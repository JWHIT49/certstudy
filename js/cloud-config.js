// Reads and validates the public cloud settings (cloud.json). Pure functions: used by the app at runtime and by tools/build.mjs.
// Nothing in this file is secret. The Supabase "publishable" (anon) key is meant to be public; the database's row level security
// is what protects each person's data. A secret key or service-role key must never be placed here, so those are rejected.

export const PROVIDERS = { microsoft: 'azure', google: 'google', github: 'github' };
export const ALL_METHODS = ['microsoft', 'google', 'github', 'email'];
/** Where the browser keeps the sign-in session (shared by the controller and the Supabase backend). */
export const AUTH_STORAGE_KEY = 'certstudy-auth';
/** The simulated cloud is for development only: it exists on localhost with ?cloud=mock and never on the published site. */
export const isMockAllowed = (loc = globalThis.location) => (
  ['localhost', '127.0.0.1'].includes(loc.hostname) && new URLSearchParams(loc.search).get('cloud') === 'mock'
);
// cloud.json is published exactly as it is, so it may hold nothing but these settings.
const ALLOWED_KEYS = new Set(['_comment', 'enabled', 'url', 'publishableKey', 'methods']);

function jwtRole(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = typeof atob === 'function' ? atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')) : Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json).role ?? null;
  } catch {
    return null;
  }
}

function* stringsIn(value) {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* stringsIn(v);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) yield* stringsIn(v);
}

/** Names the kind of credential that must never be published, or returns null. Looks at every value, wherever it appears. */
function credentialIn(text) {
  if (/sb_secret_/.test(text)) return 'a Supabase SECRET key (sb_secret_...)';
  for (const token of text.match(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g) ?? []) {
    const role = jwtRole(token);
    if (role !== null && role !== 'anon') return `a "${role}" key (only the public anon key may be published)`;
  }
  return null;
}

/** Returns { ok: true, config } (config is null when cloud sync is switched off) or { ok: false, errors }. */
export function parseCloudConfig(raw) {
  const errors = [];
  if (raw === null || raw === undefined) return { ok: true, config: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['cloud.json must be a JSON object'] };

  // These checks apply even when sync is switched off: the file is published either way.
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`unknown setting "${key}". cloud.json is published as it is, so it may only hold: ${[...ALLOWED_KEYS].filter((k) => k[0] !== '_').join(', ')}`);
  }
  for (const text of stringsIn(raw)) {
    const found = credentialIn(text);
    if (found) errors.push(`cloud.json contains ${found}. Remove it from the repository and rotate it; only the publishable (anon) key belongs here`);
  }
  if (errors.length) return { ok: false, errors };
  if (raw.enabled !== true) return { ok: true, config: null };

  let origin = null;
  try {
    const u = new URL(String(raw.url));
    if (u.protocol !== 'https:') errors.push('url must start with https://');
    else if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) errors.push('url must be just the project address, for example https://abcdefghijkl.supabase.co');
    else origin = u.origin;
  } catch {
    errors.push('url is not a valid address');
  }

  const key = typeof raw.publishableKey === 'string' ? raw.publishableKey.trim() : '';
  if (key.length < 20 || key.length > 600 || /\s/.test(key)) errors.push('publishableKey is missing or malformed');
  else if (key.startsWith('sb_secret_')) errors.push('publishableKey is a SECRET key. Remove it from the repository and rotate it; only the publishable (anon) key belongs here');
  else if (key.startsWith('eyJ') && jwtRole(key) !== 'anon') errors.push(`publishableKey is a "${jwtRole(key) ?? 'unknown'}" key, not the public anon key. Never commit a service_role key`);
  else if (!key.startsWith('eyJ') && !key.startsWith('sb_publishable_')) errors.push('publishableKey should start with sb_publishable_ (or be the legacy anon JWT)');

  const methods = Array.isArray(raw.methods) ? raw.methods : [];
  const bad = methods.filter((m) => !ALL_METHODS.includes(m));
  if (!methods.length) errors.push(`methods must list at least one of: ${ALL_METHODS.join(', ')}`);
  if (bad.length) errors.push(`unknown sign-in method(s): ${bad.join(', ')}`);

  if (errors.length) return { ok: false, errors };
  return { ok: true, config: { url: origin, publishableKey: key, methods: [...new Set(methods)] } };
}

/** Loads cloud.json next to index.html. Returns the validated config, or null when sync is not configured or the file is unusable. */
export async function loadCloudConfig(fetchImpl = globalThis.fetch.bind(globalThis), base = globalThis.location?.href) {
  try {
    const res = await fetchImpl(new URL('cloud.json', base), { cache: 'no-cache' });
    if (!res.ok) return null;
    const parsed = parseCloudConfig(await res.json());
    return parsed.ok ? parsed.config : null;
  } catch {
    return null;
  }
}
