// Cloud controller: the one place that owns the optional backend and the sync engine, and the small API the UI uses.
// With cloud.json switched off (the default) nothing here does anything: no sign-in code is loaded and nothing leaves the device. The
// backends are imported only when they are needed, so this file must not import them statically (a test guards that).
import * as store from './store.js';
import { createSyncEngine, STATE_KEY } from './sync.js';
import { loadCloudConfig, isMockAllowed, AUTH_STORAGE_KEY } from './cloud-config.js';

const MOCK_USER_KEY = 'certstudy-mock-user';
const RETURN_TO_KEY = 'ui.afterSignIn';
const POLL_MS = 5 * 60 * 1000;
const AUTH_PARAMS = ['code', 'error', 'error_code', 'error_description', 'state'];
const SIGN_OUT_GRACE_MS = 3000;

// Says what went wrong in plain words. A missing "code verifier" means the sign-in came back to a different window (or storage) than it
// started in, which is what happens when a provider's page opens in Safari instead of inside a Home Screen app.
const signInProblem = (message) => (/code verifier/i.test(message)
  ? 'Sign-in could not finish because it came back to a different window than it started in. Try again. If it keeps happening in the Home Screen app, use the emailed code instead.'
  : `Sign-in did not complete: ${message}`);

let config = null;
let backend = null;
let engine = null;
let user = null;
let booting = null;
let initialized = null;
let notice = null; // a one-off message for the UI (a failed sign-in, an unexpected sign-out)
let signOutExpectedUntil = 0;
let busy = false;
let onDataChanged = () => {};
const listeners = new Set();

export function getState() {
  return {
    configured: config !== null,
    methods: config?.methods ?? [],
    mock: isMockAllowed(),
    user,
    sync: engine ? engine.getStatus() : { state: 'signed-out', lastSyncAt: null, error: null, warning: null, needsSignIn: false },
    notice,
    busy,
  };
}
const notify = () => { for (const fn of [...listeners]) { try { fn(getState()); } catch (err) { console.error(err); } } };
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const clearNotice = () => { notice = null; notify(); };
/** Called after cloud data changed progress on this device, so the open page can refresh itself. */
export const setDataChangedHandler = (fn) => { onDataChanged = fn; };

function wireTriggers() {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') engine.syncNow(); });
  window.addEventListener('online', () => engine.syncNow());
  setInterval(() => { if (document.visibilityState === 'visible') engine.syncNow(); }, POLL_MS);
}

async function boot() {
  booting ??= (async () => {
    const be = isMockAllowed()
      ? await (await import('./cloud-mock.js')).createMockBackend()
      : await (await import('./cloud-supabase.js')).createSupabaseBackend(config);
    // Web Locks are what keep a deletion in one tab from racing a sync in another; every current browser has them (iOS since 15.4).
    const withLock = globalThis.navigator?.locks?.request ? (fn) => navigator.locks.request('certstudy-sync', fn) : undefined;
    const eng = createSyncEngine({
      backend: be, store, cleanValue: store.cleanValue, withLock, onApplied: () => onDataChanged(), log: (...a) => console.debug('[sync]', ...a),
    });
    eng.subscribe(notify);
    const stopListening = be.onAuthChange((next) => {
      if (!next && user && Date.now() > signOutExpectedUntil) notice = 'You were signed out. Sign in again to resume syncing.';
      user = next;
      eng.setUser(next);
      notify();
    });
    try {
      const problem = await be.initialize();
      if (problem) notice = signInProblem(problem);
      user = await be.getUser();
      eng.setUser(user);
    } catch (err) {
      stopListening();
      eng.destroy();
      throw err;
    }
    backend = be;
    engine = eng;
    wireTriggers();
    notify();
    return be;
  })().catch((err) => {
    booting = null;
    throw err;
  });
  return booting;
}

const hasStoredSession = () => {
  try { return localStorage.getItem(AUTH_STORAGE_KEY) !== null || (isMockAllowed() && localStorage.getItem(MOCK_USER_KEY) !== null); } catch { return false; }
};

// The provider sends the browser back with ?code=... on success, or an error in the query (sometimes in the #fragment).
function readReturn() {
  const query = new URLSearchParams(location.search);
  const badHash = location.hash !== '' && !location.hash.startsWith('#/');
  const frag = badHash ? new URLSearchParams(location.hash.slice(1)) : new URLSearchParams();
  const error = query.get('error_description') || frag.get('error_description') || query.get('error') || frag.get('error');
  return { code: query.has('code'), error, badHash };
}

function cleanAddressBar(badHash) {
  const url = new URL(location.href);
  for (const name of AUTH_PARAMS) url.searchParams.delete(name);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${badHash ? '' : url.hash}`);
}

/** Looks for the cloud settings. Safe to call more than once. Resolves once it is known whether the cloud is available. */
export function initCloud() {
  initialized ??= (async () => {
    config = isMockAllowed() ? { methods: ['microsoft', 'google', 'github'] } : await loadCloudConfig();
    if (!config) return;
    const back = readReturn();
    const returning = back.code || back.error !== null;
    if (back.error) notice = signInProblem(back.error);
    if (back.badHash) cleanAddressBar(true);
    notify();
    if (hasStoredSession() || back.code) {
      try {
        await boot();
      } catch (err) {
        console.warn('Cloud sync could not start', err);
        notice ??= 'Cloud sync could not start. Check your connection and reload.';
      }
    }
    const dest = store.get(RETURN_TO_KEY, null);
    if (dest !== null) store.remove(RETURN_TO_KEY); // used once, and only when the provider actually sent the browser back
    if (returning) {
      cleanAddressBar(false);
      if (typeof dest === 'string' && dest.startsWith('#/')) location.hash = dest;
      else if (back.badHash) location.hash = '#/settings';
    }
    notify();
  })();
  return initialized;
}

async function run(action) {
  busy = true;
  notice = null;
  notify();
  try {
    await action();
    return true;
  } catch (err) {
    notice = err?.message || 'Something went wrong.';
    return false;
  } finally {
    busy = false;
    notify();
  }
}

/** Starts the sign-in with Microsoft, Google or GitHub. The page leaves for the provider and comes back signed in. */
export function signIn(method, { returnTo = '#/settings' } = {}) {
  return run(async () => {
    await initCloud();
    if (!config) throw new Error('Sign-in is not set up for this app.');
    const be = await boot();
    store.set(RETURN_TO_KEY, returnTo);
    try {
      await be.signInWithProvider(method);
    } catch (err) {
      store.remove(RETURN_TO_KEY);
      throw err;
    }
  });
}

export function sendEmailCode(email) {
  return run(async () => { await initCloud(); await (await boot()).signInWithEmail(email.trim()); });
}

export function verifyEmailCode(email, code) {
  return run(async () => { await (await boot()).verifyEmailCode(email.trim(), code.trim()); });
}

async function endSession() {
  signOutExpectedUntil = Date.now() + SIGN_OUT_GRACE_MS;
  await backend.signOut();
  engine.setUser(null);
  user = null;
}

/** Signs this device out. `clearDevice` also removes the progress from this device (for a shared phone or computer). */
export function signOut({ clearDevice = false } = {}) {
  return run(async () => {
    if (!backend) return;
    await endSession();
    if (clearDevice) engine.wipeLocal();
  });
}

// A deletion is only ever carried out for the account that asked for it. If another tab signs in as somebody else while the request is
// waiting for a running sync to finish, it is refused instead of deleting the wrong person's data.
function exclusiveFor(uid, task) {
  return engine.runExclusive(async () => {
    if (!uid || user?.id !== uid) throw new Error('The signed-in account changed, so nothing was deleted.');
    await task(uid);
  });
}

/** Deletes the cloud copy of the progress and signs out. The progress on this device is kept. */
export function deleteCloudData() {
  return run(() => exclusiveFor(user?.id, async (uid) => { // no sync may be running, or start, while the data is deleted
    await backend.deleteMyData(uid);
    await endSession();
    store.remove(STATE_KEY); // the next sign-in must ask again before anything is uploaded
  }));
}

/** Deletes the account and everything stored for it. The progress on this device is kept. */
export function deleteAccount() {
  return run(() => exclusiveFor(user?.id, async (uid) => {
    signOutExpectedUntil = Date.now() + SIGN_OUT_GRACE_MS;
    await backend.deleteMyAccount(uid);
    engine.setUser(null);
    user = null;
    store.remove(STATE_KEY);
  }));
}

export const syncNow = () => engine?.syncNow();
/** How many documents on this device hold changes that are not in the cloud yet. */
export const unsyncedCount = () => engine?.unsyncedCount() ?? 0;

/**
 * The progress documents the account already holds, read without changing anything on this device, so the learner can see what is
 * there before deciding. Resolves to a list of [key, value] pairs, or null when they cannot be read right now.
 */
export async function previewAccount() {
  if (!backend || !user) return null;
  const uid = user.id;
  try {
    const entries = [];
    let since = null;
    let afterKey = null;
    for (let page = 0; page < 5; page += 1) { // far more than one person's progress; the sync itself always reads everything
      const batch = await backend.listDocs({ since, afterKey, limit: 200, uid });
      for (const doc of batch.docs) if (!doc.deleted) entries.push([doc.key, doc.value]);
      if (!batch.hasMore || !batch.docs.length) break;
      const last = batch.docs[batch.docs.length - 1];
      since = last.updatedAt;
      afterKey = last.key;
    }
    return entries;
  } catch {
    return null;
  }
}

/** First sign-in on a device that already has progress: `replaceLocal` keeps only what the account holds. */
export function approveFirstSync({ replaceLocal = false } = {}) {
  return run(async () => { await engine.approve({ replaceLocal }); });
}
