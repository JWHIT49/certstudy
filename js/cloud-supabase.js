// Supabase backend: sign-in through @supabase/auth-js (a vendored build, loaded only when needed) and plain fetch calls to the
// cs_* functions defined in supabase/migrations. Every request carries the signed-in user's token, and the database's row level
// security restricts each person to their own rows.
import { PROVIDERS } from './cloud-config.js';

export class CloudError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CloudError';
    this.code = code; // offline | auth | server | rejected | cancelled (the signed-in account is not the one the request was made for)
  }
}

const TIMEOUT_MS = 20000;
export const AUTH_STORAGE_KEY = 'certstudy-auth';

const toUser = (session) => {
  const u = session?.user;
  if (!u) return null;
  const meta = u.user_metadata ?? {};
  return { id: u.id, email: u.email ?? meta.email ?? null, name: meta.full_name ?? meta.name ?? null, provider: u.app_metadata?.provider ?? null };
};

/** Where sign-in returns to: this page, without the hash route and without leftover query parameters. */
export const redirectUrl = (loc = globalThis.location) => `${loc.origin}${loc.pathname}`;

export async function createSupabaseBackend(config, {
  storage = globalThis.localStorage, fetchImpl = globalThis.fetch?.bind(globalThis), loadAuth = () => import('./vendor/auth-js.js'), location = globalThis.location,
} = {}) {
  const { GoTrueClient } = await loadAuth();
  const base = config.url.replace(/\/+$/, '');
  const auth = new GoTrueClient({
    url: `${base}/auth/v1`,
    headers: { apikey: config.publishableKey },
    storageKey: AUTH_STORAGE_KEY,
    storage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  });

  // `uid` is the person the sync engine is working for. If the browser has meanwhile been signed in as somebody else (for example in
  // another tab), nothing is sent: a request made for one account must never carry another account's token.
  async function rpc(name, args, uid) {
    const { data, error } = await auth.getSession(); // refreshes an expired token
    if (error?.name === 'AuthRetryableFetchError') throw new CloudError('Could not reach the cloud.', 'offline');
    if (error || !data?.session) throw new CloudError('You are signed out.', 'auth');
    if (uid && data.session.user?.id !== uid) throw new CloudError('The signed-in account changed.', 'cancelled');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: config.publishableKey, Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args ?? {}),
        signal: ctrl.signal,
        cache: 'no-store',
      });
    } catch {
      throw new CloudError('Could not reach the cloud.', 'offline');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw new CloudError('Your sign-in expired.', 'auth');
    const text = await res.text();
    const body = (() => { try { return text ? JSON.parse(text) : null; } catch { return null; } })();
    if (!res.ok) {
      const detail = body?.message ?? '';
      if (res.status === 404) throw new CloudError('The cloud database is not set up yet (missing function). Run the SQL in supabase/migrations.', 'server');
      if (res.status >= 500) throw new CloudError(`The cloud had a problem (${res.status}).`, 'server');
      throw new CloudError(detail || `The cloud refused the request (${res.status}).`, 'rejected');
    }
    return body;
  }

  const asDoc = (r) => ({ key: r.key, value: r.value, deleted: r.deleted === true, rev: r.rev, updatedAt: r.updated_at });

  // Ends the session on this device only. If the server cannot be told (offline), the stored session is still removed.
  async function forgetSession() {
    const { error } = await auth.signOut({ scope: 'local' });
    if (!error) return;
    try {
      storage.removeItem(AUTH_STORAGE_KEY);
      storage.removeItem(`${AUTH_STORAGE_KEY}-code-verifier`);
    } catch { /* storage is blocked: nothing was stored */ }
  }

  // Offline with an expired access token, the library keeps the session but cannot hand it out until it can refresh it. The person
  // is still signed in, so the stored session is used to say who they are; the token is refreshed as soon as the connection returns.
  const storedUser = () => {
    try { return toUser(JSON.parse(storage.getItem(AUTH_STORAGE_KEY))); } catch { return null; }
  };

  return {
    name: 'supabase',
    /** Waits for a sign-in that is returning through the address bar to finish. Resolves to an error message, or null. */
    async initialize() {
      const { error } = await auth.initialize();
      return error ? error.message : null;
    },
    async getUser() {
      const { data, error } = await auth.getSession();
      if (data?.session) return toUser(data.session);
      return error?.name === 'AuthRetryableFetchError' ? storedUser() : null;
    },
    onAuthChange(cb) {
      const { data } = auth.onAuthStateChange((event, session) => {
        const next = session ? toUser(session) : event === 'INITIAL_SESSION' ? storedUser() : null;
        // Never call back into auth from inside this handler (it would deadlock), so hand over on the next tick.
        setTimeout(() => cb(next, event), 0);
      });
      return () => data.subscription.unsubscribe();
    },
    async signInWithProvider(method) {
      const provider = PROVIDERS[method];
      if (!provider) throw new CloudError('That sign-in method is not available.', 'rejected');
      const { error } = await auth.signInWithOAuth({ provider, options: { redirectTo: redirectUrl(location), scopes: provider === 'azure' ? 'email' : undefined } });
      if (error) throw new CloudError(error.message, 'rejected');
    },
    async signInWithEmail(email) {
      const { error } = await auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (error) throw new CloudError(error.message, 'rejected');
    },
    async verifyEmailCode(email, token) {
      const { data, error } = await auth.verifyOtp({ email, token: token.trim(), type: 'email' });
      if (error) throw new CloudError(error.message, 'rejected');
      return toUser(data.session);
    },
    async signOut() {
      await forgetSession(); // only this device; other devices stay signed in
    },
    async listDocs({ since, afterKey, limit, uid }) {
      const rows = await rpc('cs_list_docs', { p_since: since ?? null, p_after_key: afterKey ?? null, p_limit: limit }, uid);
      return { docs: rows.map(asDoc), hasMore: rows.length >= limit };
    },
    async getDocs(keys, uid) {
      return (await rpc('cs_get_docs', { p_keys: keys }, uid)).map(asDoc);
    },
    async putDocs(docs, uid) {
      return rpc('cs_put_docs', { p_docs: docs.map((d) => ({ key: d.key, value: d.value, deleted: d.deleted, base_rev: d.baseRev })) }, uid);
    },
    async deleteMyData(uid) {
      await rpc('cs_delete_my_data', {}, uid);
    },
    async deleteMyAccount(uid) {
      await rpc('cs_delete_my_account', {}, uid);
      await forgetSession();
    },
  };
}
