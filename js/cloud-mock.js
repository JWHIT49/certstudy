// Development-only backend. It talks to the in-memory mock cloud inside tools/serve.mjs, so the whole sign-in and sync flow can be
// exercised without a real Supabase project. It only activates on localhost with ?cloud=mock and is never reachable on the live site.
import { CloudError } from './cloud-supabase.js';
import { isMockAllowed } from './cloud-config.js';

export { isMockAllowed };

const KEY = 'certstudy-mock-user';

export async function createMockBackend() {
  const listeners = new Set();
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  let user = read();

  async function call(fn, args, uid) {
    if (!user) throw new CloudError('You are signed out.', 'auth');
    if (uid && user.id !== uid) throw new CloudError('The signed-in account changed.', 'cancelled');
    let res;
    try {
      res = await fetch(`/__mock/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mock-user': user.id }, body: JSON.stringify(args ?? {}) });
    } catch {
      throw new CloudError('Could not reach the cloud.', 'offline');
    }
    if (res.status === 401) throw new CloudError('Your sign-in expired.', 'auth');
    if (res.status === 503) throw new CloudError('Could not reach the cloud.', 'offline');
    if (!res.ok) throw new CloudError(`The mock cloud refused the request (${res.status}).`, res.status >= 500 ? 'server' : 'rejected');
    return res.json();
  }
  const asDoc = (r) => ({ key: r.key, value: r.value, deleted: r.deleted === true, rev: r.rev, updatedAt: r.updated_at });
  const notify = () => { for (const cb of listeners) setTimeout(() => cb(user, 'MOCK'), 0); };

  return {
    name: 'mock',
    async getUser() { return user; },
    async initialize() { return null; },
    onAuthChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    async signInWithProvider(method) {
      const name = (new URLSearchParams(location.search).get('mockuser') || globalThis.prompt?.('Mock sign-in: choose a user name', 'alice') || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!name) throw new CloudError('Sign-in cancelled.', 'rejected');
      user = { id: `mock-${name}`, email: `${name}@example.test`, name, provider: method };
      localStorage.setItem(KEY, JSON.stringify(user));
      notify();
    },
    async signInWithEmail() { throw new CloudError('Email codes are not part of the mock.', 'rejected'); },
    async verifyEmailCode() { throw new CloudError('Email codes are not part of the mock.', 'rejected'); },
    async signOut() { user = null; localStorage.removeItem(KEY); notify(); },
    async listDocs({ since, afterKey, limit, uid }) {
      const rows = await call('cs_list_docs', { p_since: since ?? null, p_after_key: afterKey ?? null, p_limit: limit }, uid);
      return { docs: rows.map(asDoc), hasMore: rows.length >= limit };
    },
    async getDocs(keys, uid) { return (await call('cs_get_docs', { p_keys: keys }, uid)).map(asDoc); },
    async putDocs(docs, uid) { return call('cs_put_docs', { p_docs: docs.map((d) => ({ key: d.key, value: d.value, deleted: d.deleted, base_rev: d.baseRev })) }, uid); },
    async deleteMyData(uid) { await call('cs_delete_my_data', {}, uid); },
    async deleteMyAccount(uid) { await call('cs_delete_my_account', {}, uid); user = null; localStorage.removeItem(KEY); notify(); },
  };
}
