import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine, STATE_KEY } from '../js/sync.js';
import { cleanValue } from '../js/store.js';

// ---------------------------------------------------------------- fakes
class FakeStore {
  constructor() { this.map = new Map(); this.subs = new Set(); }
  get(key, fallback = null) { return this.map.has(key) ? JSON.parse(this.map.get(key)) : fallback; }
  has(key) { return this.map.has(key); }
  set(key, value) { this.map.set(key, JSON.stringify(value)); for (const f of this.subs) f(key); }
  remove(key) { this.map.delete(key); for (const f of this.subs) f(key); }
  keys(prefix = '') { return [...this.map.keys()].filter((k) => k.startsWith(prefix)); }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
}

// Mimics the SQL: one row per key with a revision, tombstones for deletions, optimistic concurrency on writes. It can also play up:
// the signed-in account can change underneath a call, answers can be delayed or lost, and individual keys can be refused.
class FakeCloud {
  constructor() {
    this.users = new Map(); // account id -> Map(key -> row)
    this.session = null; // the account the backend is signed in as (null: whoever the engine says it is syncing for)
    this.tick = 0;
    this.calls = { list: 0, get: 0, put: 0, putDocs: 0 };
    this.listArgs = [];
    this.getSizes = []; // how many keys each lookup asked for
    this.events = [];
    this.onCall = null;
    this.beforePut = null;
    this.failWith = null; // every list and put call fails with this
    this.failPutOnce = null; // the next upload never reaches the cloud
    this.dropAnswerOnce = false; // the next upload is applied, but its answer is lost
    this.deferNext = false; // the next upload is neither applied nor answered now (see flushDeferred)
    this.deferred = [];
    this.failListOn = null; // the n-th listDocs call fails
    this.noAnswer = false; // uploads are applied but come back without a result
    this.reject = new Map(); // key -> reason: the cloud refuses to store this key
    this.holds = {}; // method -> promise: the answer is delayed until it resolves
    this.holdsBefore = {}; // method -> promise: the request reaches the cloud late
  }
  rowsOf(uid) {
    if (!this.users.has(uid)) this.users.set(uid, new Map());
    return this.users.get(uid);
  }
  get rows() { return this.rowsOf('user-1'); }
  // Like the real cloud, every write gets a revision number nobody has seen before, even when a row is deleted and created again.
  nextRev() { this.revSeq = (this.revSeq ?? 100) + 7; return this.revSeq; }
  stamp() { this.tick += 1; return new Date(Date.UTC(2026, 9, 21, 12, 0, 0) + this.tick * 1000).toISOString(); }
  hold(method) { let release; this.holds[method] = new Promise((r) => { release = r; }); return release; }
  holdBefore(method) { let release; this.holdsBefore[method] = new Promise((r) => { release = r; }); return release; }
  backend() {
    const cloud = this;
    const view = (r) => ({ key: r.key, value: r.deleted ? null : r.value, deleted: r.deleted, rev: r.rev, updatedAt: r.updatedAt });
    // The account is decided when the call is made, like the token that rides along with a real request.
    const owner = (uid) => {
      if (cloud.session && uid && cloud.session !== uid) throw Object.assign(new Error('The signed-in account changed.'), { code: 'cancelled' });
      return cloud.session ?? uid ?? 'user-1';
    };
    const wait = async (table, method) => {
      const p = cloud[table][method];
      if (p) { delete cloud[table][method]; await p; }
    };
    return {
      async listDocs({ since, afterKey, limit, uid }) {
        cloud.calls.list += 1;
        cloud.listArgs.push({ since, afterKey, uid });
        cloud.onCall?.('listDocs');
        if (cloud.failWith) throw cloud.failWith;
        if (cloud.failListOn === cloud.calls.list) throw Object.assign(new Error('network'), { code: 'offline' });
        const rows = [...cloud.rowsOf(owner(uid)).values()].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.key < b.key ? -1 : 1));
        const after = rows.filter((r) => !since || r.updatedAt > since || (r.updatedAt === since && afterKey != null && r.key > afterKey));
        const out = { docs: after.slice(0, limit).map(view), hasMore: after.length > limit };
        await wait('holds', 'listDocs');
        return out;
      },
      async getDocs(keys, uid) {
        cloud.calls.get += 1;
        cloud.getSizes.push(keys.length);
        cloud.onCall?.('getDocs');
        const rows = cloud.rowsOf(owner(uid));
        const out = keys.slice(0, 100).filter((k) => rows.has(k)).map((k) => view(rows.get(k))); // the cloud answers for at most 100 keys
        await wait('holds', 'getDocs');
        return out;
      },
      async putDocs(docs, uid) {
        cloud.calls.putDocs += 1;
        cloud.onCall?.('putDocs');
        if (cloud.failWith) throw cloud.failWith;
        if (cloud.failPutOnce) { const err = cloud.failPutOnce; cloud.failPutOnce = null; throw err; }
        const rows = cloud.rowsOf(owner(uid));
        if (cloud.deferNext) { // the request gets stuck on its way: the device hears nothing now, and it lands later (see flushDeferred)
          cloud.deferNext = false;
          cloud.deferred.push({ rows, docs });
          throw Object.assign(new Error('network'), { code: 'offline' });
        }
        await wait('holdsBefore', 'putDocs');
        cloud.beforePut?.(docs);
        const results = cloud.apply(rows, docs);
        if (cloud.dropAnswerOnce) { cloud.dropAnswerOnce = false; throw Object.assign(new Error('network'), { code: 'offline' }); }
        await wait('holds', 'putDocs');
        return cloud.noAnswer ? [] : results;
      },
    };
  }
  apply(rows, docs) {
    const cloud = this;
    return docs.map((d) => {
      cloud.calls.put += 1;
      if (cloud.reject.has(d.key)) return { key: d.key, ok: false, error: cloud.reject.get(d.key) };
      const row = rows.get(d.key);
      if (!row) {
        if (d.baseRev !== 0) return { key: d.key, ok: false, conflict: true };
        if (d.deleted) return { key: d.key, ok: true, rev: 0 };
        rows.set(d.key, { key: d.key, value: d.value, deleted: false, rev: cloud.nextRev(), updatedAt: cloud.stamp() });
        cloud.events.push(`put:${d.key}`);
        return { key: d.key, ok: true, rev: rows.get(d.key).rev };
      }
      if (row.rev !== d.baseRev) return { key: d.key, ok: false, conflict: true };
      Object.assign(row, { value: d.deleted ? null : d.value, deleted: d.deleted, rev: cloud.nextRev(), updatedAt: cloud.stamp() });
      cloud.events.push(`put:${d.key}`);
      return { key: d.key, ok: true, rev: row.rev };
    });
  }
  /** Uploads that were stuck on their way now arrive. */
  flushDeferred() {
    for (const { rows, docs } of this.deferred.splice(0)) this.apply(rows, docs);
  }
  // A write made by "another device" directly in the cloud.
  poke(key, value, uid = 'user-1') {
    const rows = this.rowsOf(uid);
    const row = rows.get(key);
    if (row) Object.assign(row, { value, deleted: value === null, rev: this.nextRev(), updatedAt: this.stamp() });
    else rows.set(key, { key, value, deleted: false, rev: this.nextRev(), updatedAt: this.stamp() });
  }
}

function device(cloud, uid = 'user-1', extra = {}) {
  const store = new FakeStore();
  let online = true;
  const timers = [];
  const engine = createSyncEngine({
    backend: cloud.backend(), store, cleanValue, isOnline: () => online, setTimer: (fn) => timers.push(fn) && timers.length, clearTimer: () => {},
    now: () => 1700000000000, ...extra,
  });
  engine.setUser({ id: uid });
  // Sign-in decides whether progress already on the device needs approval, so tests that create data after sign-in sign in again.
  const signInAgain = () => { engine.setUser(null); engine.setUser({ id: uid }); };
  const approve = engine.approve;
  engine.approve = (...args) => { if (engine.getStatus().state !== 'needs-approval') signInAgain(); return approve(...args); };
  return { store, engine, timers, setOnline: (v) => { online = v; }, uid, resignIn: signInAgain };
}

// ---------------------------------------------------------------- data helpers (shapes accepted by the real validators)
const Q = (n) => `p1/q${n}`;
function finish(d, sid, correctQs, wrongQs = [], at = 1000) {
  const perQuestion = {};
  for (const q of correctQs) perQuestion[Q(q)] = 'c';
  for (const q of wrongQs) perQuestion[Q(q)] = 'w';
  d.store.set(`sess.${sid}`, { id: sid, packId: 'p1', keys: Object.keys(perQuestion), answers: {}, result: { perQuestion, pct: 50 } });
  const history = d.store.get('history.p1', []);
  history.unshift({ id: sid, title: 'Practice', mode: 'exam', examId: 'practice-1', startedAt: at - 5, endedAt: at, activeMs: 5, total: 2, attempted: 2, correct: correctQs.length, pct: 50 });
  d.store.set('history.p1', history);
  const stats = d.store.get('qstats.p1', {});
  for (const [k, r] of Object.entries(perQuestion)) {
    const s = stats[k] ?? { a: 0, c: 0 };
    s.a += 1; if (r === 'c') s.c += 1; s.last = r === 'c' ? 1 : 0; s.t = at; stats[k] = s;
  }
  d.store.set('qstats.p1', stats);
}
const sid = (n) => `session-${String(n).padStart(4, '0')}`;

// ---------------------------------------------------------------- tests
test('a new device uploads its progress and a second device downloads it', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('settings', { theme: 'dark' });
  a.store.set('skills.p1', { 1: 4 });
  finish(a, sid(1), [1], [2]);
  a.resignIn();
  assert.equal(a.engine.getStatus().state, 'needs-approval'); // progress already on this device
  await a.engine.approve();
  assert.equal(a.engine.getStatus().state, 'idle');
  assert.equal(cloud.rows.size, 5);

  const b = device(cloud);
  await b.engine.syncNow();
  assert.deepEqual(b.store.get('qstats.p1'), a.store.get('qstats.p1'));
  assert.deepEqual(b.store.get('skills.p1'), { 1: 4 });
  assert.deepEqual(b.store.get(`sess.${sid(1)}`), a.store.get(`sess.${sid(1)}`));
  assert.equal(b.store.get('settings').theme, 'dark');
});

test('device-only keys never leave the device', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('active.p1', { id: 'x' });
  a.store.set('ui.hint', true);
  a.store.set('guide.p1', { read: { s1: 1 }, last: null });
  await a.engine.approve();
  await a.engine.syncNow();
  assert.deepEqual([...cloud.rows.keys()], ['guide.p1']);
});

test('answers given offline on two devices are both kept, and counters are added once', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  finish(a, sid(1), [1, 2], [], 100);
  await a.engine.approve();
  await b.engine.syncNow(); // b now has session 1
  // both go offline and answer question 1 again
  finish(a, sid(2), [1], [], 200);
  finish(b, sid(3), [], [1], 300);
  await a.engine.syncNow();
  await b.engine.syncNow();
  await a.engine.syncNow();
  for (const d of [a, b]) {
    assert.deepEqual(d.store.get('history.p1').map((e) => e.id), [sid(3), sid(2), sid(1)]);
    assert.deepEqual(d.store.get('qstats.p1')[Q(1)], { a: 3, c: 2, last: 0, t: 300 });
    assert.ok(d.store.has(`sess.${sid(2)}`) && d.store.has(`sess.${sid(3)}`));
  }
  assert.deepEqual(a.store.get('qstats.p1'), b.store.get('qstats.p1'));
});

test('a refused push is merged with the newer cloud copy and retried', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 2 });
  await a.engine.approve();
  a.store.set('skills.p1', { 1: 2, 2: 5 }); // local change
  cloud.beforePut = () => { cloud.beforePut = null; cloud.poke('skills.p1', { 1: 2, 3: 1 }); }; // another device writes first
  await a.engine.syncNow();
  assert.deepEqual(a.store.get('skills.p1'), { 1: 2, 2: 5, 3: 1 });
  assert.deepEqual(cloud.rows.get('skills.p1').value, { 1: 2, 2: 5, 3: 1 });
  assert.equal(a.engine.getStatus().error, null);
});

test('resetting progress on one device clears it everywhere, and nothing is pushed when nothing changed', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  finish(a, sid(1), [1]);
  await a.engine.approve();
  await b.engine.syncNow();
  for (const k of a.store.keys().filter((x) => !x.startsWith('sync.'))) a.store.remove(k);
  await a.engine.syncNow();
  assert.ok([...cloud.rows.values()].every((r) => r.deleted));
  await b.engine.syncNow();
  assert.deepEqual(b.store.keys().filter((k) => !k.startsWith('sync.')), []);
  const before = cloud.calls.put;
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal(cloud.calls.put, before);
});

test('a deletion does not destroy changes made elsewhere in the meantime', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  await a.engine.approve();
  await b.engine.syncNow();
  a.store.remove('skills.p1');
  b.store.set('skills.p1', { 1: 5 });
  await b.engine.syncNow(); // the cloud copy changed first
  await a.engine.syncNow();
  assert.deepEqual(a.store.get('skills.p1'), { 1: 5 });
});

test('progress on the device is not uploaded to an account until the learner agrees', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud, 'someone-else');
  finish(a, sid(1), [1]);
  await a.engine.approve();
  const before = { ...cloud.calls };
  // a different account signs in on a device that still has progress and a previous account's sync state
  a.engine.setUser({ id: 'another-user' });
  assert.equal(a.engine.getStatus().state, 'needs-approval');
  await a.engine.syncNow();
  assert.deepEqual(cloud.calls, before); // no network use while waiting
});

test('cloud documents this version cannot read are never overwritten', async () => {
  const cloud = new FakeCloud();
  cloud.poke('skills.p1', { 1: 9 }); // 9 is outside 1..5, so the validator rejects it
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  await a.engine.approve();
  await a.engine.syncNow();
  assert.deepEqual(cloud.rows.get('skills.p1').value, { 1: 9 });
  assert.match(a.engine.getStatus().warning, /newer version/);
});

test('offline and auth failures are reported, then recover', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  await a.engine.approve();
  a.store.set('skills.p1', { 1: 4 });
  cloud.failWith = Object.assign(new Error('network'), { code: 'offline' });
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().state, 'offline');
  cloud.failWith = Object.assign(new Error('jwt'), { code: 'auth' });
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().needsSignIn, true);
  cloud.failWith = null;
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().state, 'idle');
  assert.deepEqual(cloud.rows.get('skills.p1').value, { 1: 4 });
  a.setOnline(false);
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().state, 'offline');
});

test('signing out in the middle of a sync does not raise an error', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  await a.engine.approve();
  a.store.set('skills.p1', { 1: 4 });
  cloud.beforePut = () => a.engine.setUser(null);
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().state, 'signed-out');
  assert.equal(a.engine.getStatus().error, null);
});

test('sessions that fall out of the history list are removed, here and in the cloud', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  for (let i = 1; i <= 3; i += 1) finish(a, sid(i), [1], [], i * 100);
  await a.engine.approve();
  // keep only the newest entry in the list, as the cap does, and drop its sessions
  a.store.set('history.p1', a.store.get('history.p1').slice(0, 1));
  a.store.remove(`sess.${sid(1)}`);
  a.store.remove(`sess.${sid(2)}`);
  await a.engine.syncNow();
  assert.equal(cloud.rows.get(`sess.${sid(1)}`).deleted, true);
  const b = device(cloud);
  await b.engine.syncNow();
  assert.deepEqual(b.store.get('history.p1').map((e) => e.id), [sid(3)]);
  assert.ok(!b.store.has(`sess.${sid(1)}`) && b.store.has(`sess.${sid(3)}`));
});

test('a learner can choose the account\'s progress instead of this device\'s', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 5 });
  a.store.set('guide.p1', { read: { s1: 1 }, last: null });
  a.resignIn();
  await a.engine.approve(); // the account now holds a's progress

  const b = device(cloud);
  b.store.set('skills.p1', { 2: 1 }); // different progress already on this phone
  b.resignIn();
  assert.equal(b.engine.getStatus().state, 'needs-approval');
  await b.engine.approve({ replaceLocal: true });
  assert.deepEqual(b.store.get('skills.p1'), { 1: 5 });
  assert.deepEqual(cloud.rows.get('skills.p1').value, { 1: 5 }); // nothing from b reached the account
  assert.equal(b.engine.getStatus().state, 'idle');
});

test('local edits schedule a sync, and wiping the device removes progress and sync state', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  await a.engine.syncNow();
  const timersBefore = a.timers.length;
  a.store.set('skills.p1', { 1: 2 });
  assert.equal(a.timers.length, timersBefore + 1);
  a.store.set('active.p1', { id: 'x' });
  assert.equal(a.timers.length, timersBefore + 1); // device-only keys do not trigger a sync
  await a.engine.syncNow();
  assert.ok(a.store.has(STATE_KEY));
  a.engine.wipeLocal();
  assert.deepEqual(a.store.keys().filter((k) => k === STATE_KEY || k.startsWith('skills.')), []);
  assert.ok(a.store.has('active.p1'));
});

test('a document the cloud no longer has is uploaded again instead of failing forever', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  await a.engine.approve();
  cloud.rows.clear(); // for example, the cloud data was deleted from another device
  a.store.set('skills.p1', { 1: 4 });
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().error, null);
  assert.deepEqual(cloud.rows.get('skills.p1').value, { 1: 4 });
});

test('the app is told when cloud data changed documents on this device, and only then', async () => {
  const cloud = new FakeCloud();
  let applied = 0;
  const a = device(cloud, 'user-1', { onApplied: () => { applied += 1; } });
  const b = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  await a.engine.approve();
  assert.equal(applied, 0); // our own upload changes nothing locally
  await b.engine.syncNow();
  b.store.set('skills.p1', { 1: 3, 2: 4 });
  await b.engine.syncNow();
  await a.engine.syncNow();
  assert.equal(applied, 1);
  assert.deepEqual(a.store.get('skills.p1'), { 1: 3, 2: 4 });
  await a.engine.syncNow();
  assert.equal(applied, 1);
});

// ---------------------------------------------------------------- failures half way, other accounts, and deletions (from the code review)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a sync that started for one account cannot deliver its documents to the next account on this device', async () => {
  const cloud = new FakeCloud();
  cloud.poke('skills.p1', { 1: 5 }, 'user-A');
  const d = device(cloud, 'user-A');
  const release = cloud.hold('listDocs'); // the answer to A's download is delayed
  const pass = d.engine.syncNow();
  d.engine.setUser(null);
  d.engine.setUser({ id: 'user-B' }); // for example another tab signed A out and B in
  release();
  await pass;
  assert.deepEqual(d.store.keys().filter((k) => k !== 'sync.state'), []);
  const saved = d.store.get('sync.state');
  assert.ok(!saved || saved.uid === 'user-B');
  assert.equal(cloud.rowsOf('user-B').size, 0);
  assert.equal(d.engine.getStatus().state, 'idle');
});

test('a request is never sent with another account\'s sign-in, and refusing it is not reported as an error', async () => {
  const cloud = new FakeCloud();
  const d = device(cloud, 'user-A');
  d.store.set('skills.p1', { 1: 3 });
  d.resignIn();
  await d.engine.approve();
  d.store.set('skills.p1', { 1: 4 });
  cloud.session = 'user-B'; // the browser's sign-in already belongs to B; the engine has not heard about it yet
  await d.engine.syncNow();
  assert.equal(d.engine.getStatus().error, null);
  assert.equal(cloud.rowsOf('user-B').size, 0);
  assert.deepEqual(cloud.rowsOf('user-A').get('skills.p1').value, { 1: 3 }); // A's account was not touched either
  cloud.session = null;
  await d.engine.syncNow();
  assert.deepEqual(cloud.rowsOf('user-A').get('skills.p1').value, { 1: 4 });
});

test('an upload that fails after a download does not make the retry count the same attempts twice', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('qstats.p1', { [Q(1)]: { a: 2, c: 1, last: 0, t: 10 } });
  a.resignIn();
  await a.engine.approve();
  a.store.set('qstats.p1', { [Q(1)]: { a: 3, c: 2, last: 1, t: 20 } }); // one more correct answer here
  cloud.poke('qstats.p1', { [Q(1)]: { a: 3, c: 1, last: 0, t: 30 } }); // and one wrong answer on another device
  cloud.failPutOnce = Object.assign(new Error('network'), { code: 'offline' });
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().state, 'offline');
  const merged = { a: 4, c: 2, last: 0, t: 30 };
  assert.deepEqual(a.store.get('qstats.p1')[Q(1)], merged);
  await a.engine.syncNow();
  assert.deepEqual(a.store.get('qstats.p1')[Q(1)], merged);
  assert.deepEqual(cloud.rows.get('qstats.p1').value[Q(1)], merged);
});

test('a download that fails on its second page keeps what the first page applied, so nothing is counted twice', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  const packs = Array.from({ length: 250 }, (_, i) => `p${i}`);
  const stats = (n, c, t) => ({ 'p1/q1': { a: n, c, last: c ? 1 : 0, t } });
  for (const p of packs) a.store.set(`qstats.${p}`, stats(2, 1, 10));
  a.resignIn();
  await a.engine.approve();
  for (const p of packs) {
    a.store.set(`qstats.${p}`, stats(3, 1, 20)); // a wrong answer here
    cloud.poke(`qstats.${p}`, stats(3, 2, 30)); // a correct answer elsewhere
  }
  cloud.failListOn = cloud.calls.list + 2; // the first page arrives, the second does not
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().state, 'offline');
  await a.engine.syncNow();
  for (const p of packs) assert.deepEqual(a.store.get(`qstats.${p}`), stats(4, 2, 30), p);
  for (const p of packs) assert.deepEqual(cloud.rows.get(`qstats.${p}`).value, stats(4, 2, 30), p);
});

test('an upload whose answer was lost is recognised afterwards instead of being merged into itself', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('qstats.p1', { [Q(1)]: { a: 2, c: 1, last: 0, t: 10 } });
  a.resignIn();
  await a.engine.approve();
  a.store.set('qstats.p1', { [Q(1)]: { a: 3, c: 2, last: 1, t: 20 } });
  cloud.dropAnswerOnce = true; // the cloud stores the upload, but the answer never arrives
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().state, 'offline');
  assert.equal(cloud.rows.get('qstats.p1').value[Q(1)].a, 3);
  a.store.set('qstats.p1', { [Q(1)]: { a: 4, c: 3, last: 1, t: 30 } }); // one more attempt before the next sync
  await a.engine.syncNow();
  assert.deepEqual(a.store.get('qstats.p1')[Q(1)], { a: 4, c: 3, last: 1, t: 30 }); // not 5: the lost upload is not added again
  assert.deepEqual(cloud.rows.get('qstats.p1').value[Q(1)], { a: 4, c: 3, last: 1, t: 30 });
});

test('items the cloud will not store are reported and kept on the device, and everything else still syncs', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  a.store.set('guide.p1', { read: { s1: 1 }, last: null });
  a.resignIn();
  cloud.reject.set('skills.p1', 'storage limit reached (25 MB)');
  await a.engine.approve();
  const status = a.engine.getStatus();
  assert.equal(status.state, 'idle');
  assert.match(status.error, /One item could not be saved/);
  assert.match(status.error, /storage limit/);
  assert.ok(cloud.rows.has('guide.p1'));
  assert.ok(!cloud.rows.has('skills.p1'));
  assert.deepEqual(a.store.get('skills.p1'), { 1: 3 });
  assert.equal(a.engine.unsyncedCount(), 1);
  cloud.reject.clear();
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().error, null);
  assert.ok(cloud.rows.has('skills.p1'));
  assert.equal(a.engine.unsyncedCount(), 0);
});

test('a document too large for the cloud is reported before it is sent, measured in bytes', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  // 130,000 characters, but about 260 KB once encoded as UTF-8
  a.store.set(`sess.${sid(9)}`, { id: sid(9), packId: 'p1', keys: [], answers: { note: 'é'.repeat(130000) }, result: { perQuestion: {}, pct: 0 } });
  a.resignIn();
  await a.engine.approve();
  assert.match(a.engine.getStatus().error, /too large/);
  assert.equal(cloud.calls.put, 0);
  assert.equal(a.engine.unsyncedCount(), 1);
});

test('an upload the cloud gives no answer for is not treated as saved', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  a.resignIn();
  cloud.noAnswer = true;
  await a.engine.approve();
  assert.match(a.engine.getStatus().error, /no answer/);
  assert.equal(a.engine.unsyncedCount(), 1);
  cloud.noAnswer = false;
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().error, null);
  assert.equal(a.engine.unsyncedCount(), 0);
});

test('when the cloud has lost a document, two devices uploading it again do not add up the same history twice', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  a.store.set('qstats.p1', { [Q(1)]: { a: 2, c: 1, last: 0, t: 10 } });
  a.resignIn();
  await a.engine.approve();
  await b.engine.syncNow(); // b holds the same history
  cloud.rows.clear(); // everything is gone from the cloud (for example "Delete my cloud data" on a third device)
  a.store.set('qstats.p1', { [Q(1)]: { a: 3, c: 2, last: 1, t: 20 } }); // one attempt on a
  b.store.set('qstats.p1', { [Q(1)]: { a: 3, c: 1, last: 0, t: 30 } }); // one attempt on b
  await a.engine.syncNow(); // uploaded again as new
  await b.engine.syncNow(); // a's copy is in the cloud now: merged with what b last knew, not added on top
  await a.engine.syncNow();
  const expected = { a: 4, c: 2, last: 0, t: 30 };
  assert.deepEqual(a.store.get('qstats.p1')[Q(1)], expected);
  assert.deepEqual(b.store.get('qstats.p1')[Q(1)], expected);
  assert.deepEqual(cloud.rows.get('qstats.p1').value[Q(1)], expected);
});

test('more refused documents than one lookup can return are all merged, with counters added once', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  const packs = Array.from({ length: 130 }, (_, i) => `p${i}`);
  const stats = (n, c, last, t) => ({ 'p1/q1': { a: n, c, last, t } });
  for (const p of packs) a.store.set(`qstats.${p}`, stats(1, 1, 1, 10));
  a.resignIn();
  await a.engine.approve();
  for (const p of packs) a.store.set(`qstats.${p}`, stats(2, 1, 0, 20));
  cloud.beforePut = () => { // another device writes every document just before ours arrive
    cloud.beforePut = null;
    for (const p of packs) cloud.poke(`qstats.${p}`, stats(2, 2, 1, 30));
  };
  await a.engine.syncNow();
  for (const p of packs) {
    assert.deepEqual(a.store.get(`qstats.${p}`), stats(3, 2, 1, 30), p);
    assert.deepEqual(cloud.rows.get(`qstats.${p}`).value, stats(3, 2, 1, 30), p);
  }
  assert.equal(a.engine.getStatus().error, null);
  // the cloud answers for at most 100 keys per lookup, so asking for more would make documents look lost
  assert.ok(cloud.getSizes.length >= 2 && Math.max(...cloud.getSizes) <= 100, `lookup sizes: ${cloud.getSizes.join(', ')}`);
  assert.equal(cloud.getSizes.reduce((sum, n) => sum + n, 0), 130);
});

test('a document another device uploads while ours is being created again is merged with what both last knew', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  a.store.set('qstats.p1', { [Q(1)]: { a: 2, c: 1, last: 0, t: 10 } });
  a.resignIn();
  await a.engine.approve();
  await b.engine.syncNow(); // both hold the same history
  cloud.rows.clear(); // the cloud lost it
  a.store.set('qstats.p1', { [Q(1)]: { a: 3, c: 2, last: 1, t: 20 } }); // one attempt on a
  let uploads = 0;
  cloud.beforePut = () => { // b gets its upload in just before a's second try
    uploads += 1;
    if (uploads === 2) cloud.poke('qstats.p1', { [Q(1)]: { a: 3, c: 1, last: 0, t: 30 } });
  };
  await a.engine.syncNow();
  const expected = { a: 4, c: 2, last: 0, t: 30 }; // each device's one new attempt, added to the shared history once
  assert.deepEqual(a.store.get('qstats.p1')[Q(1)], expected);
  assert.deepEqual(cloud.rows.get('qstats.p1').value[Q(1)], expected);
});

test('deleting cloud data waits for a sync that is under way, so nothing is uploaded after the deletion', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  a.resignIn();
  await a.engine.approve();
  a.store.set('skills.p1', { 1: 3, 2: 4 });
  a.store.set('skills.p2', { 1: 1 });
  const lateArrival = cloud.holdBefore('putDocs'); // the upload reaches the cloud late
  const pass = a.engine.syncNow();
  await tick();
  const deletion = a.engine.runExclusive(async () => { cloud.rows.clear(); }); // stands in for "delete my cloud data"
  lateArrival();
  await Promise.all([pass, deletion]);
  assert.equal(cloud.rows.size, 0); // the late upload landed before the deletion, not after it
  assert.equal(a.engine.getStatus().state, 'idle');
});

test('while an exclusive task runs no sync starts, and a failed task leaves syncing switched back on', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  a.resignIn();
  await a.engine.approve();
  a.store.set('skills.p1', { 1: 4 });
  const callsBefore = cloud.calls.list;
  const timersBefore = a.timers.length;
  let duringTask = null;
  await assert.rejects(a.engine.runExclusive(async () => {
    duringTask = await a.engine.syncNow(); // refused while the task has the engine to itself
    throw new Error('boom');
  }), /boom/);
  assert.equal(cloud.calls.list, callsBefore);
  assert.ok(duringTask);
  assert.ok(a.timers.length > timersBefore); // a sync is scheduled again
  await a.engine.syncNow();
  assert.deepEqual(cloud.rows.get('skills.p1').value, { 1: 4 });
});

test('cloud data written by a newer app version starts syncing once this version can read it', async () => {
  const cloud = new FakeCloud();
  const store = new FakeStore();
  cloud.poke('skills.p1', { 1: 9, 2: 2 }); // a rating of 9 is outside what this version accepts
  const start = (clean) => {
    const engine = createSyncEngine({ backend: cloud.backend(), store, cleanValue: clean, setTimer: () => 1, clearTimer: () => {}, isOnline: () => true });
    engine.setUser({ id: 'user-1' });
    return engine;
  };
  const before = start(cleanValue);
  await before.syncNow();
  assert.match(before.getStatus().warning, /newer version/);
  assert.equal(store.has('skills.p1'), false);
  before.destroy();
  const understands = (key, value) => (key === 'skills.p1' ? value : cleanValue(key, value)); // the app was updated
  const after = start(understands);
  await after.syncNow();
  assert.equal(after.getStatus().warning, null);
  assert.deepEqual(store.get('skills.p1'), { 1: 9, 2: 2 });
});

test('the engine says how many documents have changes the cloud does not have yet', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  assert.equal(a.engine.unsyncedCount(), 0);
  a.store.set('skills.p1', { 1: 3 });
  assert.equal(a.engine.unsyncedCount(), 1);
  a.resignIn();
  assert.equal(a.engine.unsyncedCount(), 1); // waiting for the learner's decision
  await a.engine.approve();
  assert.equal(a.engine.unsyncedCount(), 0);
  a.store.remove('skills.p1');
  assert.equal(a.engine.unsyncedCount(), 1); // a deletion is a change too
});

// ---------------------------------------------------------------- from the second review
test('an upload that is still on its way when the retry is sent is recognised once it lands', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('qstats.p1', { [Q(1)]: { a: 2, c: 1, last: 0, t: 10 } });
  a.resignIn();
  await a.engine.approve();
  a.store.set('qstats.p1', { [Q(1)]: { a: 3, c: 2, last: 1, t: 20 } }); // one attempt...
  cloud.deferNext = true; // ...whose upload gets stuck on its way: the device hears nothing
  await a.engine.syncNow();
  assert.equal(a.engine.getStatus().state, 'offline');
  a.store.set('qstats.p1', { [Q(1)]: { a: 4, c: 3, last: 1, t: 30 } }); // another attempt before the next sync
  cloud.beforePut = () => { cloud.beforePut = null; cloud.flushDeferred(); }; // the stuck upload lands just before the retry does
  await a.engine.syncNow();
  const both = { a: 4, c: 3, last: 1, t: 30 }; // the first attempt is in the cloud already; it must not be added again
  assert.deepEqual(a.store.get('qstats.p1')[Q(1)], both);
  assert.deepEqual(cloud.rows.get('qstats.p1').value[Q(1)], both);
});

test('a change that cannot be uploaded because the cloud copy is unreadable still counts as not saved', async () => {
  const cloud = new FakeCloud();
  const store = new FakeStore();
  const engine = createSyncEngine({ backend: cloud.backend(), store, cleanValue, setTimer: () => 1, clearTimer: () => {}, isOnline: () => true });
  engine.setUser({ id: 'user-1' });
  cloud.poke('skills.p1', { 1: 3 });
  await engine.syncNow();
  assert.deepEqual(store.get('skills.p1'), { 1: 3 });
  cloud.poke('skills.p1', { 1: 3, 2: 9 }); // a newer app version wrote a rating this version does not understand
  await engine.syncNow();
  assert.match(engine.getStatus().warning, /newer version/);
  assert.equal(engine.unsyncedCount(), 0);
  store.set('skills.p1', { 1: 4 }); // the learner keeps using this version
  await engine.syncNow();
  assert.deepEqual(cloud.rows.get('skills.p1').value, { 1: 3, 2: 9 }); // the unreadable copy is not overwritten...
  assert.equal(engine.unsyncedCount(), 1); // ...so the edit is not saved anywhere else
});

test('an unreadable cloud copy that disappears stops blocking the document, and the local copy is uploaded again', async () => {
  const cloud = new FakeCloud();
  const store = new FakeStore();
  const engine = createSyncEngine({ backend: cloud.backend(), store, cleanValue, setTimer: () => 1, clearTimer: () => {}, isOnline: () => true });
  engine.setUser({ id: 'user-1' });
  cloud.poke('skills.p1', { 1: 3 });
  await engine.syncNow();
  cloud.poke('skills.p1', { 1: 3, 2: 9 });
  await engine.syncNow();
  store.set('skills.p1', { 1: 4 });
  await engine.syncNow();
  assert.equal(engine.unsyncedCount(), 1);
  cloud.rows.clear(); // the cloud copy is gone (for example the data was deleted)
  await engine.syncNow();
  assert.equal(engine.getStatus().warning, null);
  assert.equal(engine.unsyncedCount(), 0);
  assert.deepEqual(cloud.rows.get('skills.p1').value, { 1: 4 });
});

test('overlapping exclusive tasks keep syncing paused until the last one is done', async () => {
  const cloud = new FakeCloud();
  const a = device(cloud);
  a.store.set('skills.p1', { 1: 3 });
  a.resignIn();
  await a.engine.approve();
  a.store.set('skills.p1', { 1: 4 });
  let finishFirst;
  const first = a.engine.runExclusive(() => new Promise((resolve) => { finishFirst = resolve; }));
  const second = a.engine.runExclusive(async () => {});
  await second;
  const before = cloud.calls.list;
  await a.engine.syncNow();
  assert.equal(cloud.calls.list, before); // the first task is still running, so nothing starts
  finishFirst();
  await first;
  await a.engine.syncNow();
  assert.ok(cloud.calls.list > before);
  assert.deepEqual(cloud.rows.get('skills.p1').value, { 1: 4 });
});

