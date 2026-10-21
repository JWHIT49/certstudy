// Local-first sync engine. The app keeps reading and writing localStorage exactly as before; this module quietly reconciles the
// synced documents with the cloud whenever a signed-in user is online.
//
// How it stays correct without tracking every edit: after each sync the engine remembers, per document, the cloud revision and the
// value both sides agreed on (the "base"). A document that differs from its base has changed locally, so it is pushed with the
// base revision as an optimistic-concurrency check. If the cloud moved on, the push is refused, the newer cloud copy is pulled,
// merged with merge.js (three-way, using the base) and pushed again.
//
// Safety rules the code below depends on:
//   * What was applied is remembered at once. State is saved after every pulled page and every pushed chunk, so a pass that fails
//     half way and is retried never applies the same cloud change (or counts the same attempts) a second time.
//   * A pass belongs to one signed-in user. It carries a generation number and checks it after every network call; if the user
//     changed meanwhile, the pass stops without touching anything, and the backend is told which user the call is for.
//   * A write whose answer never arrived is recognised when it comes back from the cloud, so counters are not merged in twice.
//   * Nothing is reported as synced unless the cloud accepted it.
import { equal, familyOf, isSyncedKey, reconcile } from './merge.js';

export const STATE_KEY = 'sync.state';
const PAGE = 200;
const PUSH_CHUNK = 40;
const FETCH_CHUNK = 100; // the cloud returns at most this many documents for one request by key
const MAX_ROUNDS = 4;
const OVERLAP_MS = 30000; // pulls start a little before the last one ended, so a write that committed late is not missed
const MAX_DOC_BYTES = 250 * 1024;
const CONFLICT_RETRY_MS = 30000;
const REJECTED_RETRY_MS = 5 * 60000;
const MAX_PENDING = 4; // unanswered uploads remembered per counter document
const PROGRESS = /^(guide|skills|qstats|history)\.|^sess\./;
const NEWER_VERSION = 'Some cloud data was written by a newer version of the app and was left alone. Update the app to use it.';

const emptyState = (uid) => ({ v: 1, uid, approved: false, lastPull: null, lastSyncAt: null, docs: {}, pending: {} });
const listOf = (p) => (Array.isArray(p) ? p : p ? [p] : []);
const utf8Length = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const cancelled = () => Object.assign(new Error('Sync cancelled'), { code: 'cancelled' });
// Counters are the only documents where applying the same change twice changes the result (every other merge is idempotent).
const isCounter = (key) => familyOf(key) === 'qstats';

/**
 * backend: { listDocs({since, afterKey, limit, uid}) -> {docs, hasMore}, getDocs(keys, uid) -> docs, putDocs(docs, uid) -> results }
 *   doc = { key, value, deleted, rev, updatedAt }; put request = { key, value, deleted, baseRev }
 *   result = { key, ok, rev } | { key, ok: false, conflict: true } | { key, ok: false, error }
 *   `uid` is the user the engine is syncing for. A backend whose current session belongs to someone else must refuse the call with an
 *   error whose code is 'cancelled' instead of sending it, so one person's documents can never reach another person's account.
 * store: the store.js API (get, set, remove, keys, has, subscribe). cleanValue(key, value): returns a trusted value or undefined.
 * withLock(fn): runs fn while holding a lock shared by every tab of the app (the default just runs it).
 */
export function createSyncEngine({
  backend, store, cleanValue, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  isOnline = () => globalThis.navigator?.onLine !== false, debounceMs = 4000, withLock = (fn) => fn(), log = () => {},
  onApplied = () => {},
}) {
  let touched = 0; // documents on this device changed by cloud data since the last notification
  let user = null;
  let state = null;
  let timer = null;
  let running = null;
  let rerun = false;
  let failures = 0;
  let applying = false;
  let generation = 0; // changes whenever the user changes or the engine is stopped; an older pass abandons itself
  let paused = 0; // how many runExclusive() tasks currently have the engine to themselves
  const listeners = new Set();
  let status = { state: 'signed-out', lastSyncAt: null, error: null, warning: null, needsSignIn: false };

  const setStatus = (patch) => {
    status = { ...status, ...patch };
    for (const fn of listeners) {
      try { fn(status); } catch (err) { log('listener failed', err); }
    }
  };
  const loadState = () => {
    const s = store.get(STATE_KEY, null);
    if (!s || s.v !== 1 || s.uid !== user.id) return emptyState(user.id);
    return { ...emptyState(user.id), ...s, docs: s.docs ?? {}, pending: s.pending ?? {} };
  };
  const saveState = () => store.set(STATE_KEY, state);
  const hasProgress = () => store.keys().some((k) => PROGRESS.test(k) && isSyncedKey(k));

  // ---------------------------------------------------------------- applying cloud documents
  function applyRemote(doc, { recheck = false } = {}) {
    const key = doc?.key;
    if (typeof key !== 'string' || !isSyncedKey(key) || !Number.isInteger(doc.rev)) return;
    const family = familyOf(key);
    const entry = state.docs[key];
    if (entry && entry.rev === doc.rev && !(recheck && entry.blocked)) return; // already applied (we pull with an overlap, and we receive our own pushes)
    const pending = listOf(state.pending[key]);

    let remote;
    if (!doc.deleted) {
      remote = cleanValue(key, doc.value);
      // A document that changes when cleaned holds something this version does not understand (for example it was written by a newer
      // version). Never overwrite it with a lossy copy. What was agreed before is kept, so it can be merged properly once readable.
      if (remote === undefined || !equal(remote, doc.value)) {
        state.docs[key] = entry && 'base' in entry ? { rev: doc.rev, blocked: true, base: entry.base } : { rev: doc.rev, blocked: true };
        delete state.pending[key];
        return;
      }
    }

    // One of our own earlier writes that the cloud applied but whose answer never reached us (or reached us after we had moved on): it
    // is already part of the cloud copy, so it must not be merged in a second time, which would count the same attempts twice. Anything
    // done on this device since is still local and is uploaded next. Whatever else is still unresolved has been overtaken: it can only
    // be refused now.
    const ours = pending.some((p) => doc.rev > p.baseRev && (doc.deleted ? p.deleted : !p.deleted && equal(remote, p.value)));
    delete state.pending[key];
    if (ours) {
      state.docs[key] = remote === undefined ? { rev: doc.rev, deleted: true } : { rev: doc.rev, base: remote };
      return;
    }

    const local = store.has(key) ? store.get(key) : undefined;
    const base = !entry || entry.deleted ? undefined : entry.base;
    const merged = reconcile(family, base, local, remote);

    if (!equal(merged, local)) {
      applying = true;
      try {
        if (merged === undefined) store.remove(key);
        else store.set(key, merged);
      } finally {
        applying = false;
      }
      touched += 1;
      if (family === 'history') dropOrphanSessions(local, merged);
    }
    state.docs[key] = remote === undefined
      ? { rev: doc.rev, deleted: true }
      : { rev: doc.rev, base: family === 'sess' ? true : remote };
  }

  // A session that fell out of the history list is no longer reachable, so it is removed (and the removal syncs like any other).
  function dropOrphanSessions(before, after) {
    const ids = (list) => new Set(Array.isArray(list) ? list.map((e) => e?.id) : []);
    const kept = ids(after);
    for (const id of ids(before)) if (typeof id === 'string' && !kept.has(id)) store.remove(`sess.${id}`);
  }

  // ---------------------------------------------------------------- finding local changes
  // Only normalized values are compared and uploaded, so every document in the cloud is something every version can read back.
  const readLocal = (key) => (store.has(key) ? cleanValue(key, store.get(key)) : undefined);

  function localChanges() {
    const out = [];
    const all = new Set([...store.keys().filter(isSyncedKey), ...Object.keys(state.docs).filter(isSyncedKey)]);
    for (const key of all) {
      const entry = state.docs[key];
      if (entry?.blocked) continue;
      const present = store.has(key);
      const local = readLocal(key);
      if (present && local === undefined) continue; // unreadable local value: leave it alone
      if (familyOf(key) === 'sess') {
        if (present && (!entry || entry.deleted)) out.push(key);
        else if (!present && entry && !entry.deleted) out.push(key);
      } else {
        if (!present && !entry) continue;
        const base = !entry || entry.deleted ? undefined : entry.base;
        if (!equal(local, base)) out.push(key);
      }
    }
    return out.sort();
  }

  // ---------------------------------------------------------------- one sync pass
  async function pull(uid, alive) {
    let since = state.lastPull ? new Date(Date.parse(state.lastPull) - OVERLAP_MS).toISOString() : null;
    let afterKey = null;
    let newest = state.lastPull ? Date.parse(state.lastPull) : -Infinity;
    for (;;) {
      const page = await backend.listDocs({ since, afterKey, limit: PAGE, uid });
      alive();
      for (const doc of page.docs) {
        applyRemote(doc);
        const t = Date.parse(doc.updatedAt);
        if (Number.isFinite(t) && t > newest) { newest = t; state.lastPull = doc.updatedAt; }
      }
      saveState(); // checkpoint: these documents are now applied and remembered, whatever happens next
      if (!page.hasMore || !page.docs.length) break;
      const last = page.docs[page.docs.length - 1];
      since = last.updatedAt;
      afterKey = last.key;
    }
  }

  async function fetchDocs(keys, uid, alive) {
    const found = [];
    for (let i = 0; i < keys.length; i += FETCH_CHUNK) {
      found.push(...await backend.getDocs(keys.slice(i, i + FETCH_CHUNK), uid));
      alive();
    }
    return found;
  }

  // Cloud documents this version could not read are looked at again each pass, so they start syncing once the app can read them.
  async function recheckBlocked(uid, alive) {
    const keys = Object.keys(state.docs).filter((k) => state.docs[k].blocked);
    if (!keys.length) return;
    const found = await fetchDocs(keys, uid, alive);
    for (const doc of found) applyRemote(doc, { recheck: true });
    // A cloud copy that no longer exists blocks nothing. What was last agreed is kept, so the local copy can be uploaded again.
    for (const key of keys) {
      const entry = state.docs[key];
      if (!entry?.blocked || found.some((d) => d.key === key)) continue;
      if ('base' in entry) state.docs[key] = { rev: 0, base: entry.base };
      else delete state.docs[key];
    }
    saveState();
  }

  const forgetLatestAttempt = (key) => {
    const older = listOf(state.pending[key]).slice(0, -1);
    if (older.length) state.pending[key] = older;
    else delete state.pending[key];
  };

  async function push(keys, uid, alive) {
    const conflicts = [];
    const rejected = [];
    const requests = [];
    for (const key of keys) {
      const present = store.has(key);
      const value = present ? readLocal(key) : null;
      if (present && value === undefined) continue;
      if (present && utf8Length(value) > MAX_DOC_BYTES) {
        rejected.push({ key, reason: 'too large to sync' });
        continue;
      }
      requests.push({ key, value, deleted: !present, baseRev: state.docs[key]?.rev ?? 0 });
    }
    for (let i = 0; i < requests.length; i += PUSH_CHUNK) {
      const chunk = requests.slice(i, i + PUSH_CHUNK);
      // Counters are noted before sending. If the answer is lost, the cloud may or may not apply the write, possibly later than a retry
      // that has already been sent; whenever the document comes back from the cloud it is recognised as ours (see applyRemote) instead
      // of being merged into itself.
      for (const req of chunk) {
        if (isCounter(req.key)) state.pending[req.key] = [...listOf(state.pending[req.key]).slice(1 - MAX_PENDING), { value: req.value, deleted: req.deleted, baseRev: req.baseRev }];
      }
      saveState();
      const results = await backend.putDocs(chunk, uid); // when this throws, `pending` stays: the outcome is unknown
      alive();
      for (const req of chunk) {
        const res = results.find((r) => r.key === req.key);
        if (!res) { rejected.push({ key: req.key, reason: 'no answer from the cloud' }); continue; } // outcome unknown: stays pending
        if (res.ok) {
          delete state.pending[req.key]; // anything sent earlier for this document has been overtaken
          state.docs[req.key] = req.deleted
            ? { rev: res.rev, deleted: true }
            : { rev: res.rev, base: familyOf(req.key) === 'sess' ? true : req.value };
          continue;
        }
        forgetLatestAttempt(req.key); // this one was not applied; an older one that never got an answer might still land
        if (res.conflict) conflicts.push(req.key);
        else rejected.push({ key: req.key, reason: res.error || 'refused by the cloud' });
      }
      saveState();
    }
    return { conflicts, rejected };
  }

  async function runPass(gen) {
    const alive = () => { if (gen !== generation || !state) throw cancelled(); };
    alive(); // the user may have changed while this pass waited for the lock
    const uid = user.id;
    state = loadState(); // another tab may have synced meanwhile
    await pull(uid, alive);
    await recheckBlocked(uid, alive);
    const rejected = [];
    const skip = new Set();
    let conflicts = [];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const changes = localChanges().filter((k) => !skip.has(k));
      if (!changes.length) { conflicts = []; break; }
      const out = await push(changes, uid, alive);
      conflicts = out.conflicts;
      for (const r of out.rejected) { skip.add(r.key); rejected.push(r); }
      if (!conflicts.length) break;
      const found = await fetchDocs(conflicts, uid, alive);
      // A refused document with no cloud copy means the cloud lost it (for example its data was deleted). It is pushed again as new, but
      // what both sides last agreed on is kept: if another device uploads the same document first, the two copies still merge correctly
      // instead of being added together.
      for (const key of conflicts) if (state.docs[key] && !found.some((d) => d.key === key)) state.docs[key] = { ...state.docs[key], rev: 0 };
      for (const doc of found) applyRemote(doc); // the cloud revision moved on since we last saw it: merge, then push the merged result
      saveState();
    }
    state.approved = true;
    state.lastSyncAt = now();
    saveState();
    return { conflicts: conflicts.length, rejected };
  }

  // ---------------------------------------------------------------- public API
  function syncNow() {
    if (!user || paused > 0 || status.state === 'needs-approval') return Promise.resolve(status);
    if (running) { rerun = true; return running; }
    clearTimer(timer);
    timer = null;
    if (!isOnline()) { setStatus({ state: 'offline' }); return Promise.resolve(status); }
    const gen = generation;
    setStatus({ state: 'syncing', error: null });
    running = withLock(() => runPass(gen)).then((result) => {
      if (gen !== generation) return;
      failures = 0;
      const n = result.rejected.length;
      let error = null;
      if (n) error = `${n === 1 ? 'One item' : `${n} items`} could not be saved to the cloud (${result.rejected[0].reason}). ${n === 1 ? 'It stays' : 'They stay'} on this device.`;
      else if (result.conflicts) error = 'Some changes could not be saved yet. They will be retried.';
      setStatus({
        state: 'idle', lastSyncAt: state.lastSyncAt, error, needsSignIn: false,
        warning: Object.values(state.docs).some((e) => e.blocked) ? NEWER_VERSION : null,
      });
      if (n) schedule(REJECTED_RETRY_MS);
      else if (result.conflicts) schedule(CONFLICT_RETRY_MS);
    }).catch((err) => {
      const code = err?.code;
      if (code === 'cancelled') {
        if (gen === generation) setStatus({ state: 'idle' }); // the account changed under us; the change itself starts a new pass
        return;
      }
      if (gen !== generation) return;
      failures += 1;
      if (code === 'offline') setStatus({ state: 'offline', error: null });
      else if (code === 'auth') setStatus({ state: 'error', error: 'Your sign-in expired. Sign in again to keep syncing.', needsSignIn: true });
      else setStatus({ state: 'error', error: err?.message || 'Sync failed.' });
      if (code !== 'auth') schedule(Math.min(15 * 60000, 30000 * 2 ** Math.min(failures - 1, 5)));
      log('sync failed', err);
    }).finally(() => {
      running = null;
      if (touched) {
        touched = 0;
        try { onApplied(); } catch (err) { log('onApplied failed', err); }
      }
      if (rerun) { rerun = false; schedule(1000); }
    }).then(() => status);
    return running;
  }

  function schedule(delay = debounceMs) {
    if (!user || status.state === 'needs-approval') return;
    clearTimer(timer);
    timer = setTimer(() => { timer = null; syncNow(); }, delay);
  }

  /**
   * How many documents on this device hold changes that are not in the cloud. That includes edits to a document whose cloud copy this
   * version cannot read: it is never overwritten, so those edits are not saved anywhere else.
   */
  function unsyncedCount() {
    if (!user || !state) return 0;
    try {
      const stuck = Object.keys(state.docs).filter((key) => {
        const entry = state.docs[key];
        if (!entry.blocked) return false;
        if (!store.has(key)) return entry.base !== undefined;
        const local = readLocal(key);
        if (local === undefined) return false;
        return !('base' in entry) || !equal(local, entry.base);
      });
      return localChanges().length + stuck.length;
    } catch {
      return 0;
    }
  }

  const unsubscribe = store.subscribe((key) => {
    if (applying || !user || key === STATE_KEY || !isSyncedKey(key)) return;
    schedule();
  });

  /** Call when the signed-in user changes (or on start). Pass null when signed out. */
  function setUser(next) {
    if ((user && next && user.id === next.id) || (!user && !next)) return; // repeated notifications (token refreshes) change nothing
    generation += 1; // a pass still running for the previous user stops at its next step
    clearTimer(timer);
    timer = null;
    user = next ? { id: next.id } : null;
    if (!user) { state = null; setStatus({ state: 'signed-out', error: null, needsSignIn: false, warning: null }); return; }
    state = loadState();
    failures = 0;
    // Progress already on this device must not flow into an account that has never synced from this device without asking first.
    if (!state.approved && hasProgress()) { setStatus({ state: 'needs-approval', error: null, needsSignIn: false, warning: null, lastSyncAt: null }); return; }
    setStatus({ state: 'idle', error: null, needsSignIn: false, warning: null, lastSyncAt: state.lastSyncAt });
    schedule(0);
  }

  function approve({ replaceLocal = false } = {}) {
    if (!user || status.state !== 'needs-approval') return Promise.resolve(status);
    if (replaceLocal) removeSyncedDocs(); // the learner chose the account's progress over this device's
    state = loadState();
    state.approved = true;
    saveState();
    setStatus({ state: 'idle' });
    return syncNow();
  }

  function removeSyncedDocs() {
    applying = true;
    try {
      for (const k of store.keys()) if (isSyncedKey(k)) store.remove(k);
    } finally {
      applying = false;
    }
  }

  /** Removes every synced document and the sync bookkeeping from this device (used by "sign out and clear this device"). */
  function wipeLocal() {
    generation += 1;
    clearTimer(timer);
    timer = null;
    removeSyncedDocs();
    store.remove(STATE_KEY);
    state = null;
  }

  /**
   * Runs `task` with no sync pass running or able to start, here or (through the shared lock) in another tab. A pass that is in
   * flight is abandoned and waited for first, so it cannot write to the cloud or to this device after `task` has begun.
   */
  async function runExclusive(task) {
    generation += 1;
    paused += 1;
    clearTimer(timer);
    timer = null;
    try {
      if (running) await running;
      return await withLock(task);
    } finally {
      paused -= 1;
      if (user && paused === 0) {
        if (status.state === 'syncing') setStatus({ state: 'idle' });
        schedule(); // the task did not end the session (it failed), so carry on syncing
      }
    }
  }

  return {
    setUser, approve, syncNow, schedule, wipeLocal, runExclusive, unsyncedCount,
    getStatus: () => status,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    destroy: () => { clearTimer(timer); unsubscribe(); listeners.clear(); },
  };
}
