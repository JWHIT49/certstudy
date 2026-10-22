import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCloudConfig, loadCloudConfig } from '../js/cloud-config.js';
import { createSupabaseBackend, redirectUrl, CloudError, AUTH_STORAGE_KEY } from '../js/cloud-supabase.js';
import { isMockAllowed } from '../js/cloud-mock.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${b64url({ role, iss: 'supabase' })}.c2lnbmF0dXJlLXBsYWNlaG9sZGVy`;
const FAKE_SECRET_KEY = ['sb', 'secret', 'abcdefghijklmnopqrstuvwxyz'].join('_'); // assembled so secret scanners do not mistake the test value for a real key
const GOOD = { enabled: true, url: 'https://abcdefghijkl.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnop', methods: ['microsoft', 'google', 'github'] };

// ---------------------------------------------------------------- cloud.json
test('cloud.json: absent or switched off means local-only', () => {
  assert.deepEqual(parseCloudConfig(null), { ok: true, config: null });
  assert.deepEqual(parseCloudConfig({ ...GOOD, enabled: false }), { ok: true, config: null });
  assert.deepEqual(parseCloudConfig({}), { ok: true, config: null });
});

test('cloud.json: a valid file is normalised', () => {
  const r = parseCloudConfig({ ...GOOD, url: 'https://abcdefghijkl.supabase.co/', methods: ['google', 'google', 'email'] });
  assert.deepEqual(r, { ok: true, config: { url: 'https://abcdefghijkl.supabase.co', publishableKey: GOOD.publishableKey, methods: ['google', 'email'] } });
});

test('cloud.json: the legacy anon key is accepted, any other role is refused', () => {
  assert.equal(parseCloudConfig({ ...GOOD, publishableKey: jwt('anon') }).ok, true);
  const bad = parseCloudConfig({ ...GOOD, publishableKey: jwt('service_role') });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /service_role/);
});

test('cloud.json: secret keys and malformed values are refused', () => {
  const cases = [
    [{ publishableKey: FAKE_SECRET_KEY }, /SECRET/],
    [{ publishableKey: 'short' }, /publishableKey/],
    [{ publishableKey: 'not-a-known-key-format-at-all-xyz' }, /should start with/],
    [{ url: 'http://abcdefghijkl.supabase.co' }, /https/],
    [{ url: 'https://abcdefghijkl.supabase.co/rest/v1' }, /project address/],
    [{ url: 'not a url' }, /valid address/],
    [{ methods: [] }, /at least one/],
    [{ methods: ['facebook'] }, /unknown sign-in method/],
  ];
  for (const [patch, pattern] of cases) {
    const r = parseCloudConfig({ ...GOOD, ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.errors.join(' '), pattern);
  }
  assert.equal(parseCloudConfig([]).ok, false);
  assert.equal(parseCloudConfig('x').ok, false);
});

test('cloud.json: a switched-off file is still checked, because it is published either way', async () => {
  const roleJwt = jwt('service_role');
  const cases = [
    [{ enabled: false, publishableKey: FAKE_SECRET_KEY }, /SECRET/],
    [{ enabled: false, publishableKey: roleJwt }, /service_role/],
    [{ enabled: false, _comment: `copied by mistake: ${roleJwt}` }, /service_role/],
    [{ enabled: false, methods: [roleJwt] }, /service_role/],
    [{ enabled: false, serviceKey: 'anything' }, /unknown setting "serviceKey"/],
    [{ enabled: false, clientSecret: 'anything' }, /unknown setting "clientSecret"/],
    [{ ...GOOD, extra: 1 }, /unknown setting "extra"/],
  ];
  for (const [patch, pattern] of cases) {
    const r = parseCloudConfig({ ...(patch.enabled === false ? {} : GOOD), ...patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.errors.join(' '), pattern);
  }
  assert.equal(parseCloudConfig({ enabled: false, publishableKey: jwt('anon'), _comment: 'the public anon key is fine' }).ok, true);
  // the file that ships in the repository must always be valid, whether or not cloud sync is switched on in it
  const shipped = JSON.parse(await readFile(new URL('../cloud.json', import.meta.url), 'utf8'));
  const parsed = parseCloudConfig(shipped);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  if (parsed.config) {
    assert.match(parsed.config.url, /^https:\/\/[a-z0-9]+\.supabase\.co$/);
    assert.ok(parsed.config.publishableKey.startsWith('sb_publishable_'));
  }
});

test('cloud.json: loading never throws and ignores unusable files', async () => {
  const respond = (status, body) => async () => ({ ok: status >= 200 && status < 300, json: async () => { if (body instanceof Error) throw body; return body; } });
  const base = 'https://example.test/certstudy/';
  assert.equal(await loadCloudConfig(respond(404, null), base), null);
  assert.equal(await loadCloudConfig(respond(200, new SyntaxError('bad json')), base), null);
  assert.equal(await loadCloudConfig(respond(200, { ...GOOD, publishableKey: FAKE_SECRET_KEY }), base), null);
  assert.equal(await loadCloudConfig(async () => { throw new TypeError('offline'); }, base), null);
  assert.equal((await loadCloudConfig(respond(200, GOOD), base)).url, 'https://abcdefghijkl.supabase.co');
  let requested;
  await loadCloudConfig(async (url) => { requested = String(url); return { ok: false }; }, base);
  assert.equal(requested, 'https://example.test/certstudy/cloud.json');
});

// ---------------------------------------------------------------- the app only loads sign-in code when cloud sync is switched on
test('with cloud sync switched off no sign-in code is loaded: the controller imports its backends only when they are needed', async () => {
  const source = await readFile(new URL('../js/cloud.js', import.meta.url), 'utf8');
  const imported = [...source.matchAll(/^import .* from '(.+)';\s*$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imported, ['./cloud-config.js', './store.js', './sync.js']);
  // and the two backends are still reachable, but only through dynamic imports
  assert.match(source, /import\('\.\/cloud-mock\.js'\)/);
  assert.match(source, /import\('\.\/cloud-supabase\.js'\)/);
  // the shared constants live in the config module, and the backends re-export them for their own users
  const config = await import('../js/cloud-config.js');
  const supabase = await import('../js/cloud-supabase.js');
  const mock = await import('../js/cloud-mock.js');
  assert.equal(supabase.AUTH_STORAGE_KEY, config.AUTH_STORAGE_KEY);
  assert.equal(mock.isMockAllowed, config.isMockAllowed);
});

// ---------------------------------------------------------------- the development mock must never be reachable on the live site
test('the mock cloud only activates on localhost with ?cloud=mock', () => {
  assert.equal(isMockAllowed({ hostname: 'localhost', search: '?cloud=mock' }), true);
  assert.equal(isMockAllowed({ hostname: '127.0.0.1', search: '?cloud=mock&mockuser=a' }), true);
  assert.equal(isMockAllowed({ hostname: 'localhost', search: '' }), false);
  assert.equal(isMockAllowed({ hostname: 'localhost', search: '?cloud=other' }), false);
  assert.equal(isMockAllowed({ hostname: 'jwhit49.github.io', search: '?cloud=mock' }), false);
  assert.equal(isMockAllowed({ hostname: 'localhost.evil.test', search: '?cloud=mock' }), false);
});

// ---------------------------------------------------------------- Supabase backend, with a fake auth client and fake fetch
class FakeAuth {
  constructor(options) {
    FakeAuth.last = this;
    this.options = options;
    this.session = { access_token: 'token-123', user: { id: 'u1', email: 'ann@example.test', user_metadata: { full_name: 'Ann' }, app_metadata: { provider: 'azure' } } };
    this.sessionResult = null;
    this.subs = new Set();
    this.calls = [];
    this.signOutError = null;
  }
  async initialize() { return { error: null }; }
  async getSession() { return this.sessionResult ?? { data: { session: this.session }, error: null }; }
  onAuthStateChange(cb) { this.subs.add(cb); return { data: { subscription: { unsubscribe: () => this.subs.delete(cb) } } }; }
  async signInWithOAuth(args) { this.calls.push(['oauth', args]); return { data: {}, error: null }; }
  async signOut(args) { this.calls.push(['signOut', args]); return { error: this.signOutError }; }
}

const CONFIG = { url: 'https://abcdefghijkl.supabase.co', publishableKey: 'sb_publishable_abcdefghijklmnop', methods: ['google'] };
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
function reply(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

const PAGE_LOCATION = { origin: 'https://jwhit49.github.io', pathname: '/certstudy/' };
async function backendWith(fetchImpl, storage = memoryStorage()) {
  const calls = [];
  const backend = await createSupabaseBackend(CONFIG, {
    storage, fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); }, loadAuth: async () => ({ GoTrueClient: FakeAuth }),
    location: PAGE_LOCATION,
  });
  return { backend, calls, auth: FakeAuth.last, storage };
}

test('supabase: the auth client is configured for PKCE with its own storage key', async () => {
  const { auth } = await backendWith(async () => reply(200, []));
  assert.equal(auth.options.flowType, 'pkce');
  assert.equal(auth.options.storageKey, AUTH_STORAGE_KEY);
  assert.equal(auth.options.url, 'https://abcdefghijkl.supabase.co/auth/v1');
  assert.equal(auth.options.headers.apikey, CONFIG.publishableKey);
});

test('supabase: requests carry the key and the signed-in token, and rows become documents', async () => {
  const rows = [{ key: 'skills.p1', value: { 1: 3 }, deleted: false, rev: 4, updated_at: '2026-10-21T12:00:00Z' }, { key: 'guide.p1', value: null, deleted: true, rev: 2, updated_at: '2026-10-21T12:00:01Z' }];
  const { backend, calls } = await backendWith(async () => reply(200, rows));
  const page = await backend.listDocs({ since: null, afterKey: null, limit: 2 });
  assert.equal(calls[0].url, 'https://abcdefghijkl.supabase.co/rest/v1/rpc/cs_list_docs');
  assert.equal(calls[0].init.headers.apikey, CONFIG.publishableKey);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token-123');
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_since: null, p_after_key: null, p_limit: 2 });
  assert.equal(page.hasMore, true); // a full page means there may be more
  assert.deepEqual(page.docs[1], { key: 'guide.p1', value: null, deleted: true, rev: 2, updatedAt: '2026-10-21T12:00:01Z' });
});

test('supabase: writes send the base revision the server checks', async () => {
  const { backend, calls } = await backendWith(async () => reply(200, [{ key: 'skills.p1', ok: true, rev: 1 }]));
  const out = await backend.putDocs([{ key: 'skills.p1', value: { 1: 3 }, deleted: false, baseRev: 0 }]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_docs: [{ key: 'skills.p1', value: { 1: 3 }, deleted: false, base_rev: 0 }] });
  assert.deepEqual(out, [{ key: 'skills.p1', ok: true, rev: 1 }]);
});

test('supabase: failures are classified so the app can react correctly', async () => {
  const expectCode = async (fetchImpl, code, tweak) => {
    const { backend, auth } = await backendWith(fetchImpl);
    tweak?.(auth);
    await assert.rejects(() => backend.getDocs(['k']), (err) => err instanceof CloudError && err.code === code);
  };
  await expectCode(async () => reply(401, {}), 'auth');
  await expectCode(async () => reply(404, { message: 'no function' }), 'server');
  await expectCode(async () => reply(503, {}), 'server');
  await expectCode(async () => reply(400, { message: 'bad request' }), 'rejected');
  await expectCode(async () => { throw new TypeError('Failed to fetch'); }, 'offline');
  await expectCode(async () => reply(200, []), 'auth', (a) => { a.sessionResult = { data: { session: null }, error: null }; });
  await expectCode(async () => reply(200, []), 'offline', (a) => { a.sessionResult = { data: { session: null }, error: Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' }) }; });
});

test('supabase: provider sign-in uses the right provider name and returns to this page', async () => {
  const { backend, auth } = await backendWith(async () => reply(200, []));
  await backend.signInWithProvider('microsoft');
  await backend.signInWithProvider('github');
  const [first, second] = auth.calls.map((c) => c[1]);
  assert.equal(first.provider, 'azure');
  assert.equal(first.options.redirectTo, 'https://jwhit49.github.io/certstudy/');
  assert.equal(first.options.scopes, 'email');
  assert.equal(second.provider, 'github');
  assert.equal(second.options.scopes, undefined);
  await assert.rejects(() => backend.signInWithProvider('facebook'), (err) => err.code === 'rejected');
  assert.equal(redirectUrl({ origin: 'https://jwhit49.github.io', pathname: '/certstudy/' }), 'https://jwhit49.github.io/certstudy/');
});

test('supabase: a request made for one person is never sent with another person\'s sign-in', async () => {
  const { backend, calls } = await backendWith(async () => reply(200, []));
  const refused = (promise) => assert.rejects(promise, (err) => err instanceof CloudError && err.code === 'cancelled');
  await refused(backend.listDocs({ since: null, afterKey: null, limit: 10, uid: 'someone-else' }));
  await refused(backend.getDocs(['k'], 'someone-else'));
  await refused(backend.putDocs([{ key: 'k', value: {}, deleted: false, baseRev: 0 }], 'someone-else'));
  assert.equal(calls.length, 0); // nothing went over the network
  await backend.getDocs(['k'], 'u1'); // the person who is signed in (see FakeAuth)
  assert.equal(calls.length, 1);
});

test('supabase: deleting data or an account is refused when the signed-in person is not the one who asked', async () => {
  const { backend, calls } = await backendWith(async () => reply(200, 0));
  const refused = (promise) => assert.rejects(promise, (err) => err instanceof CloudError && err.code === 'cancelled');
  await refused(backend.deleteMyData('someone-else'));
  await refused(backend.deleteMyAccount('someone-else'));
  assert.equal(calls.length, 0); // nothing was sent, so nothing was deleted
  await backend.deleteMyData('u1');
  assert.match(calls[0].url, /cs_delete_my_data$/);
});

test('supabase: the signed-in user is mapped, and auth events are handed over on a later tick', async () => {
  const { backend, auth } = await backendWith(async () => reply(200, []));
  assert.deepEqual(await backend.getUser(), { id: 'u1', email: 'ann@example.test', name: 'Ann', provider: 'azure' });
  const seen = [];
  const off = backend.onAuthChange((user, event) => seen.push([user?.id ?? null, event]));
  for (const cb of auth.subs) cb('SIGNED_OUT', null);
  assert.deepEqual(seen, []); // never re-enter the auth client from inside its own callback
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [[null, 'SIGNED_OUT']]);
  off();
  assert.equal(auth.subs.size, 0);
});

test('supabase: opening the app offline with an expired token still shows the person as signed in', async () => {
  const stored = { access_token: 'old', user: { id: 'u1', email: 'ann@example.test', user_metadata: { full_name: 'Ann' }, app_metadata: { provider: 'google' } } };
  const storage = memoryStorage({ [AUTH_STORAGE_KEY]: JSON.stringify(stored) });
  const { backend, auth } = await backendWith(async () => reply(200, []), storage);
  auth.sessionResult = { data: { session: null }, error: Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' }) };
  assert.deepEqual(await backend.getUser(), { id: 'u1', email: 'ann@example.test', name: 'Ann', provider: 'google' });
  const seen = [];
  backend.onAuthChange((user, event) => seen.push([user?.id ?? null, event]));
  for (const cb of auth.subs) { cb('INITIAL_SESSION', null); cb('SIGNED_OUT', null); }
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [['u1', 'INITIAL_SESSION'], [null, 'SIGNED_OUT']]); // only a real sign-out clears the person
  auth.sessionResult = { data: { session: null }, error: null }; // a genuinely signed-out device stays signed out
  storage.removeItem(AUTH_STORAGE_KEY);
  assert.equal(await backend.getUser(), null);
});

test('supabase: signing out offline still forgets the session on this device', async () => {
  const storage = memoryStorage({ [AUTH_STORAGE_KEY]: '{"x":1}', [`${AUTH_STORAGE_KEY}-code-verifier`]: 'v', unrelated: 'keep' });
  const { backend, auth } = await backendWith(async () => reply(200, []), storage);
  auth.signOutError = new Error('fetch failed');
  await backend.signOut();
  assert.deepEqual([...storage.map.keys()], ['unrelated']);
  assert.deepEqual(auth.calls.at(-1), ['signOut', { scope: 'local' }]);
});

test('supabase: deleting the account signs this device out as well, and an empty reply is fine', async () => {
  const { backend, auth, calls } = await backendWith(async () => reply(204));
  await backend.deleteMyAccount();
  assert.match(calls[0].url, /cs_delete_my_account$/);
  assert.deepEqual(auth.calls.at(-1), ['signOut', { scope: 'local' }]);
});
