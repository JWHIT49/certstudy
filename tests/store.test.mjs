import test from 'node:test';
import assert from 'node:assert/strict';

// A controllable stand-in for localStorage, installed before store.js is loaded.
class FakeStorage {
  constructor() { this.map = new Map(); this.failWrites = false; this.failRemoves = false; this.failKey = null; }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.failWrites || (this.failKey && k.endsWith(this.failKey))) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(k, String(v));
  }
  removeItem(k) { if (this.failRemoves) throw new Error('blocked'); this.map.delete(k); }
}
const fake = new FakeStorage();
globalThis.window = { localStorage: fake };
const store = await import('../js/store.js');

const reset = () => { fake.failWrites = false; fake.failRemoves = false; fake.failKey = null; store.clearAll(); fake.map.clear(); };

const goodBackup = () => ({
  app: 'CertStudy', schema: 1, exportedAt: '2026-01-01T00:00:00Z',
  data: {
    settings: { theme: 'dark', fontScale: 1.15, shuffleOptions: true, autoCheck: false },
    'guide.ab-400': { read: { 'd1-arch': 1700000000000 }, last: { gid: 'study-guide', sid: 'd1-arch', y: 120, t: 1 } },
    'skills.ab-400': { 1: 4, 2: 5 },
    'qstats.ab-400': { 'practice-1/q001': { a: 2, c: 1, last: 1, t: 5 } },
    'history.ab-400': [{ id: 'abcdefgh-1', title: 'Practice Exam 1', mode: 'exam', examId: 'practice-1', startedAt: 1, endedAt: 2, activeMs: 3, total: 60, attempted: 10, correct: 5, pct: 8 }],
    'sess.abcdefgh-1': { id: 'abcdefgh-1', packId: 'ab-400', keys: ['practice-1/q001'], answers: {}, result: { pct: 8, perQuestion: { 'practice-1/q001': 'c' } } },
  },
});

test('a failed write keeps the newest value readable and is reported', () => {
  reset();
  const failures = [];
  const off = store.onWriteFailure((e) => failures.push(e));
  store.set('active.ab-400', { idx: 1 });
  fake.failWrites = true;
  store.set('active.ab-400', { idx: 7 });
  assert.deepEqual(store.get('active.ab-400'), { idx: 7 }, 'the in-memory copy wins over the stale persisted one');
  assert.ok(store.keys().includes('active.ab-400'));
  assert.equal(failures.length, 1);
  fake.failWrites = false;
  store.set('active.ab-400', { idx: 9 });
  assert.deepEqual(store.get('active.ab-400'), { idx: 9 });
  assert.equal(JSON.parse(fake.getItem('cs1.active.ab-400')).idx, 9, 'a later successful write is persisted again');
  off();
});

test('a key that cannot be removed stays hidden', () => {
  reset();
  store.set('skills.x', { 1: 3 });
  fake.failRemoves = true;
  store.remove('skills.x');
  assert.equal(store.get('skills.x'), null);
  assert.ok(!store.keys().includes('skills.x'));
  fake.failRemoves = false;
});

test('setting undefined removes the key instead of storing the text "undefined"', () => {
  reset();
  store.set('k', 1);
  store.set('k', undefined);
  assert.equal(store.get('k'), null);
});

test('parseBackup accepts a good backup and rebuilds each value', () => {
  const entries = Object.fromEntries(store.parseBackup(goodBackup()));
  assert.equal(entries.settings.theme, 'dark');
  assert.deepEqual(entries['skills.ab-400'], { 1: 4, 2: 5 });
  assert.equal(entries['history.ab-400'][0].pct, 8);
  assert.equal(entries['guide.ab-400'].last.sid, 'd1-arch');
  assert.ok(entries['sess.abcdefgh-1']);
});

test('parseBackup rejects files that are not usable backups', () => {
  for (const bad of [null, [], 'x', { app: 'Other', schema: 1, data: {} }, { app: 'CertStudy', schema: 2, data: {} }, { app: 'CertStudy', schema: 1, data: [] },
    { app: 'CertStudy', schema: 1, data: null }, { app: 'CertStudy', schema: 1, data: {} }, { app: 'CertStudy', schema: 1, data: { 'history.ab-400': {} } }]) {
    assert.throws(() => store.parseBackup(bad), /backup|progress/i);
  }
});

test('parseBackup drops malformed values, unknown keys, device keys and prototype tricks', () => {
  const b = goodBackup();
  b.data['skills.ab-400'] = { 1: 4, 2: 9, abc: 3, __proto__: 5, 3: 'x' };
  b.data['active.ab-400'] = { idx: 3 };
  b.data['ui.installHintDismissed'] = true;
  b.data['__proto__'] = { polluted: true };
  b.data['constructor'] = 1;
  b.data['qstats.ab-400'] = { 'practice-1/q001': { a: 1, c: 5 }, 'bad key': { a: 1, c: 1 }, 'practice-1/q002': { a: 3, c: 2, last: 0, t: 1 } };
  const entries = Object.fromEntries(store.parseBackup(b));
  assert.deepEqual(entries['skills.ab-400'], { 1: 4 });
  assert.deepEqual(Object.keys(entries['qstats.ab-400']), ['practice-1/q002']);
  for (const k of ['active.ab-400', 'ui.installHintDismissed', '__proto__', 'constructor']) assert.ok(!Object.keys(entries).includes(k), `${k} must be ignored`);
  assert.equal({}.polluted, undefined);
});

test('an invalid backup never wipes existing progress', () => {
  reset();
  store.set('skills.ab-400', { 1: 5 });
  assert.throws(() => store.importAll({ app: 'CertStudy', schema: 1, data: [] }), /backup/i);
  assert.throws(() => store.importAll({ app: 'CertStudy', schema: 1, data: { 'history.ab-400': {} } }), /progress/i);
  assert.deepEqual(store.get('skills.ab-400'), { 1: 5 });
});

test('restore replaces progress but keeps device state', () => {
  reset();
  store.set('skills.old-pack', { 1: 2 });
  store.set('active.ab-400', { idx: 4 });
  store.set('ui.installHintDismissed', true);
  store.importAll(goodBackup());
  assert.equal(store.get('skills.old-pack'), null, 'previous progress is replaced');
  assert.deepEqual(store.get('skills.ab-400'), { 1: 4, 2: 5 });
  assert.deepEqual(store.get('active.ab-400'), { idx: 4 });
  assert.equal(store.get('ui.installHintDismissed'), true);
});

test('restore rolls back when storage fills up part-way', () => {
  reset();
  store.set('skills.keep-me', { 1: 3 });
  store.set('history.keep-me', []);
  fake.failKey = 'qstats.ab-400';
  assert.throws(() => store.importAll(goodBackup()), /not enough storage/i);
  fake.failKey = null;
  assert.deepEqual(store.get('skills.keep-me'), { 1: 3 });
  assert.deepEqual(store.get('history.keep-me'), []);
  assert.equal(store.get('skills.ab-400'), null, 'nothing from the half-written backup remains');
});

test('export then restore round-trips', () => {
  reset();
  store.importAll(goodBackup());
  store.set('active.ab-400', { idx: 2 });
  const exported = store.exportAll();
  assert.ok(!('active.ab-400' in exported.data));
  store.clearAll();
  store.importAll(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(store.get('skills.ab-400'), { 1: 4, 2: 5 });
  assert.equal(store.get('history.ab-400').length, 1);
});
