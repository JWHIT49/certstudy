import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// These tests drive the real vendored sign-in library with the same options the app uses (cloud-supabase.js), against a fake server,
// so the sign-in flow can be checked without a Supabase project.
const { GoTrueClient } = await import('../js/vendor/auth-js.js');

const BASE = 'https://abcdefghijkl.supabase.co';
const KEY = 'certstudy-auth';

function memoryStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

const SESSION = {
  access_token: 'access-token-abc', token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-token-abc',
  user: { id: 'user-1', aud: 'authenticated', role: 'authenticated', email: 'ann@example.test', app_metadata: { provider: 'azure' }, user_metadata: { full_name: 'Ann' }, created_at: '2026-10-21T12:00:00Z' },
};

function fakeServer({ offline = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    requests.push({ path: u.pathname, search: u.search, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    if (offline) throw new TypeError('Failed to fetch');
    if (u.pathname.endsWith('/token')) return new Response(JSON.stringify(SESSION), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { requests, fetchImpl };
}

const newClient = (storage, fetchImpl) => new GoTrueClient({
  url: `${BASE}/auth/v1`, headers: { apikey: 'sb_publishable_abcdefghijklmnop' }, storageKey: KEY, storage, fetch: fetchImpl,
  persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce',
});

test('the vendored bundle is self-contained and CSP-safe', async () => {
  const text = await readFile(new URL('../js/vendor/auth-js.js', import.meta.url), 'utf8');
  assert.match(text, /^\/\*!\s*\n \* @supabase\/auth-js 2\.117\.3/);
  assert.match(text, /MIT License/);
  assert.doesNotMatch(text, /\beval\s*\(|\bnew\s+Function\s*\(|\bimport\s*\(/);
  assert.doesNotMatch(text, /^import\s|\brequire\s*\(/m); // no bare imports that a browser could not resolve
});

test('a provider sign-in produces a PKCE authorize URL and remembers the verifier', async () => {
  const storage = memoryStorage();
  const auth = newClient(storage, fakeServer().fetchImpl);
  for (const [provider, scopes] of [['azure', 'email'], ['google', undefined], ['github', undefined]]) {
    const { data, error } = await auth.signInWithOAuth({ provider, options: { redirectTo: 'https://jwhit49.github.io/certstudy/', scopes, skipBrowserRedirect: true } });
    assert.equal(error, null);
    const url = new URL(data.url);
    assert.equal(`${url.origin}${url.pathname}`, `${BASE}/auth/v1/authorize`);
    assert.equal(url.searchParams.get('provider'), provider);
    assert.equal(url.searchParams.get('redirect_to'), 'https://jwhit49.github.io/certstudy/');
    assert.equal(url.searchParams.get('code_challenge_method'), 's256');
    assert.ok(url.searchParams.get('code_challenge')?.length >= 40);
    assert.equal(url.searchParams.get('scopes'), scopes ?? null);
  }
  assert.ok(storage.getItem(`${KEY}-code-verifier`)); // needed to finish the sign-in when the browser comes back
});

test('returning with a code signs in, stores the session, and sign-out removes it', async () => {
  const storage = memoryStorage();
  const server = fakeServer();
  const auth = newClient(storage, server.fetchImpl);
  const events = [];
  auth.onAuthStateChange((event, session) => { events.push([event, session?.user?.id ?? null]); });
  await auth.signInWithOAuth({ provider: 'github', options: { skipBrowserRedirect: true } });
  const { data, error } = await auth.exchangeCodeForSession('the-code-from-the-provider');
  assert.equal(error, null);
  assert.equal(data.session.user.id, 'user-1');
  const exchange = server.requests.find((r) => r.path.endsWith('/token'));
  assert.equal(exchange.search, '?grant_type=pkce');
  assert.equal(exchange.body.auth_code, 'the-code-from-the-provider');
  assert.ok(exchange.body.code_verifier.length >= 43);
  assert.equal(JSON.parse(storage.getItem(KEY)).access_token, 'access-token-abc');
  assert.equal((await auth.getSession()).data.session.access_token, 'access-token-abc');

  const out = await auth.signOut({ scope: 'local' });
  assert.equal(out.error, null);
  assert.equal(storage.getItem(KEY), null);
  const logout = server.requests.find((r) => r.path.endsWith('/logout'));
  assert.equal(logout.search, '?scope=local'); // only this device
  assert.equal(logout.headers.Authorization, 'Bearer access-token-abc');
  assert.ok(events.some(([e]) => e === 'SIGNED_IN') && events.some(([e]) => e === 'SIGNED_OUT'));
});

test('signing out while offline reports the network error but still ends the session on this device', async () => {
  const storage = memoryStorage();
  const online = fakeServer();
  const auth = newClient(storage, online.fetchImpl);
  await auth.signInWithOAuth({ provider: 'google', options: { skipBrowserRedirect: true } });
  await auth.exchangeCodeForSession('code');
  assert.ok(storage.getItem(KEY));

  const offlineAuth = newClient(storage, fakeServer({ offline: true }).fetchImpl);
  const out = await offlineAuth.signOut({ scope: 'local' });
  assert.equal(out.error?.name, 'AuthRetryableFetchError'); // the name cloud-supabase.js uses to tell "offline" from "signed out"
  assert.equal(storage.getItem(KEY), null);
  assert.equal((await offlineAuth.getSession()).data.session, null);
});

test('a fresh client with nothing stored is simply signed out', async () => {
  const auth = newClient(memoryStorage(), fakeServer().fetchImpl);
  const { data, error } = await auth.getSession();
  assert.equal(error, null);
  assert.equal(data.session, null);
});
