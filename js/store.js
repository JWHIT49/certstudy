// Low-level persistent key/value store (localStorage, JSON values) with an in-memory fallback.
// iOS note: data persists for sites added to the Home Screen; plain Safari tabs can be purged after ~7 days of inactivity,
// which is why Settings offers a progress backup/export.
const NS = 'cs1.';
let ls = null;
try {
  ls = window.localStorage;
  ls.setItem(`${NS}__probe`, '1');
  ls.removeItem(`${NS}__probe`);
} catch {
  ls = null;
}

// `memory` is an overlay that wins over localStorage: it holds the whole store when storage is unavailable, and any value that
// could not be written (quota, private mode). A `null` entry is a tombstone for a key that could not be removed.
const memory = new Map();
const subscribers = new Set();
const failureSubscribers = new Set();
export const persistent = ls !== null;
export let lastWriteFailed = false;

function emit(key) {
  for (const fn of subscribers) {
    try { fn(key); } catch (err) { console.error(err); }
  }
}

/** Calls fn(error) whenever a write could not be saved to device storage (the data then only lives until the app closes). */
export function onWriteFailure(fn) {
  failureSubscribers.add(fn);
  return () => failureSubscribers.delete(fn);
}

function readRaw(key) {
  if (memory.has(key)) return memory.get(key);
  return ls ? ls.getItem(NS + key) : null;
}

export function get(key, fallback = null) {
  try {
    const raw = readRaw(key);
    return raw === null || raw === undefined ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** True when a value is stored under this key (a stored JSON null counts). */
export function has(key) {
  const raw = readRaw(key);
  return raw !== null && raw !== undefined;
}

export function set(key, value) {
  if (value === undefined) { remove(key); return; }
  const raw = JSON.stringify(value);
  if (ls) {
    try {
      ls.setItem(NS + key, raw);
      memory.delete(key);
      lastWriteFailed = false;
    } catch (err) {
      memory.set(key, raw);
      lastWriteFailed = true;
      console.warn('Storage write failed', key, err);
      for (const fn of failureSubscribers) {
        try { fn(err); } catch (e) { console.error(e); }
      }
    }
  } else {
    memory.set(key, raw);
  }
  emit(key);
}

export function remove(key) {
  if (ls) {
    try {
      ls.removeItem(NS + key);
      memory.delete(key);
    } catch {
      memory.set(key, null);
    }
  } else {
    memory.delete(key);
  }
  emit(key);
}

export function keys(prefix = '') {
  const out = new Set();
  if (ls) {
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (k && k.startsWith(NS + prefix)) out.add(k.slice(NS.length));
    }
  }
  for (const [k, raw] of memory) {
    if (!k.startsWith(prefix)) continue;
    if (raw === null) out.delete(k);
    else out.add(k);
  }
  return [...out];
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function exportAll() {
  const data = {};
  for (const k of keys()) {
    if (deviceKey(k)) continue; // in-progress sessions and UI hints are device state, not backup material
    data[k] = get(k);
  }
  return { app: 'CertStudy', schema: 1, exportedAt: new Date().toISOString(), data };
}

// ---------------------------------------------------------------- backup / restore
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const QKEY = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/i;
const MAX_HISTORY_ENTRIES = 40;

// One cleaner per key family. A cleaner returns a rebuilt, trusted value, or undefined to reject the key.
const CLEANERS = [
  [/^settings$/, (v) => {
    if (!isPlain(v)) return undefined;
    const out = {};
    if (['system', 'light', 'dark'].includes(v.theme)) out.theme = v.theme;
    if (isNum(v.fontScale) && v.fontScale >= 0.8 && v.fontScale <= 1.5) out.fontScale = v.fontScale;
    if (typeof v.shuffleOptions === 'boolean') out.shuffleOptions = v.shuffleOptions;
    if (typeof v.autoCheck === 'boolean') out.autoCheck = v.autoCheck;
    return out;
  }],
  [/^guide\.[a-z0-9-]+$/i, (v) => {
    if (!isPlain(v)) return undefined;
    const read = {};
    if (isPlain(v.read)) for (const [k, t] of Object.entries(v.read)) if (SLUG.test(k) && isNum(t)) read[k] = t;
    const l = v.last;
    const last = isPlain(l) && isStr(l.gid) && isStr(l.sid) && isNum(l.y) ? { gid: l.gid, sid: l.sid, y: l.y, t: isNum(l.t) ? l.t : 0 } : null;
    return { read, last };
  }],
  [/^skills\.[a-z0-9-]+$/i, (v) => {
    if (!isPlain(v)) return undefined;
    const out = {};
    for (const [k, r] of Object.entries(v)) if (/^\d{1,4}$/.test(k) && Number.isInteger(r) && r >= 1 && r <= 5) out[k] = r;
    return out;
  }],
  [/^qstats\.[a-z0-9-]+$/i, (v) => {
    if (!isPlain(v)) return undefined;
    const out = {};
    for (const [k, s] of Object.entries(v)) {
      if (QKEY.test(k) && isPlain(s) && Number.isInteger(s.a) && Number.isInteger(s.c) && s.a >= 0 && s.c >= 0 && s.c <= s.a) {
        out[k] = { a: s.a, c: s.c, last: s.last === 1 ? 1 : 0, t: isNum(s.t) ? s.t : 0 };
      }
    }
    return out;
  }],
  [/^history\.[a-z0-9-]+$/i, (v) => {
    if (!Array.isArray(v)) return undefined;
    return v.filter((e) => isPlain(e) && isStr(e.id) && isNum(e.total) && isNum(e.correct) && isNum(e.pct)).slice(0, MAX_HISTORY_ENTRIES).map((e) => ({
      id: e.id, title: typeof e.title === 'string' ? e.title.slice(0, 200) : '', mode: e.mode === 'exam' ? 'exam' : 'study',
      examId: isStr(e.examId) ? e.examId : null, startedAt: isNum(e.startedAt) ? e.startedAt : 0, endedAt: isNum(e.endedAt) ? e.endedAt : 0,
      activeMs: isNum(e.activeMs) ? e.activeMs : 0, total: e.total, attempted: isNum(e.attempted) ? e.attempted : 0, correct: e.correct, pct: e.pct,
    }));
  }],
  [/^sess\.([A-Za-z0-9-]{8,64})$/, (v, m) => (
    isPlain(v) && v.id === m[1] && isStr(v.packId) && Array.isArray(v.keys) && isPlain(v.answers)
    && isPlain(v.result) && isPlain(v.result.perQuestion) && isNum(v.result.pct) ? v : undefined)],
];

/** Validates a backup file and returns the [key, value] pairs it is safe to restore. Throws before anything is changed. */
export function parseBackup(backup) {
  if (!isPlain(backup) || backup.app !== 'CertStudy' || backup.schema !== 1 || !isPlain(backup.data)) {
    throw new Error('This file is not a CertStudy backup.');
  }
  const entries = [];
  for (const [key, value] of Object.entries(backup.data)) {
    const cleaned = cleanValue(key, value);
    if (cleaned !== undefined) entries.push([key, cleaned]);
  }
  if (!entries.length) throw new Error('This backup does not contain any progress this version can read.');
  return entries;
}

/** Rebuilds one stored value from untrusted input (a backup file or a cloud document), or returns undefined if it is not acceptable. */
export function cleanValue(key, value) {
  for (const [re, clean] of CLEANERS) {
    const m = re.exec(key);
    if (m) return clean(value, m);
  }
  return undefined;
}

// An in-progress session, one-time UI hints and sync bookkeeping belong to this device, so a restore leaves them alone.
const deviceKey = (k) => k.startsWith('active.') || k.startsWith('ui.') || k.startsWith('sync.');

function writeStrict(key, value) {
  const raw = JSON.stringify(value);
  if (ls) {
    ls.setItem(NS + key, raw);
    memory.delete(key);
  } else {
    memory.set(key, raw);
  }
}

export function importAll(backup, { replace = true } = {}) {
  const entries = parseBackup(backup);
  const snapshot = new Map(keys().filter((k) => !deviceKey(k)).map((k) => [k, readRaw(k)]));
  try {
    if (replace) for (const k of snapshot.keys()) remove(k);
    for (const [k, v] of entries) writeStrict(k, v);
  } catch {
    for (const k of keys()) if (!deviceKey(k)) remove(k);
    for (const [k, raw] of snapshot) {
      if (raw === null) continue;
      try { if (ls) ls.setItem(NS + k, raw); else memory.set(k, raw); } catch { memory.set(k, raw); }
    }
    throw new Error('There is not enough storage space to restore this backup. Your existing progress was kept.');
  }
  for (const [k] of entries) emit(k);
}

/** Removes progress and settings from this device. Sync bookkeeping is kept (so the cloud copy is cleared too) unless `includeSync`. */
export function clearAll({ includeSync = false } = {}) {
  for (const k of keys()) if (includeSync || !k.startsWith('sync.')) remove(k);
}
