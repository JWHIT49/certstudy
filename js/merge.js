// Pure merge rules for cloud sync. No DOM, storage or network in here: every function depends only on its arguments.
//   base   = the last state this device and the cloud agreed on (undefined when they never synced this document)
//   local  = this device now, remote = the cloud now. `undefined` always means "this document does not exist".
// The goal is that nothing a learner did on any device is lost, and that counters are never counted twice.

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(v) ? v : 0);

/** Document families that sync. In-progress sessions (active.*), one-time hints (ui.*) and sync bookkeeping (sync.*) stay on the device. */
const FAMILIES = [
  [/^settings$/, 'settings'],
  [/^guide\.[a-z0-9-]+$/i, 'guide'],
  [/^skills\.[a-z0-9-]+$/i, 'skills'],
  [/^qstats\.[a-z0-9-]+$/i, 'qstats'],
  [/^history\.[a-z0-9-]+$/i, 'history'],
  [/^sess\.[A-Za-z0-9-]{8,64}$/, 'sess'],
];
export const familyOf = (key) => {
  for (const [re, name] of FAMILIES) if (re.test(key)) return name;
  return null;
};
export const isSyncedKey = (key) => familyOf(key) !== null;

// ---------------------------------------------------------------- equality
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlain(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}
/** Deep equality for JSON values (key order does not matter). */
export const equal = (a, b) => a === b || canonical(a) === canonical(b);

// ---------------------------------------------------------------- per-key three-way merge for maps
// If only one side changed a key, that side wins (a deletion counts as a change). If both changed it, `onConflict` decides.
// By default a real value beats a deletion, and local beats remote, so a conflict never silently throws data away.
const keepData = (b, l, r) => (l !== undefined ? l : r);

function mergeMap(base, local, remote, onConflict = keepData) {
  const b = isPlain(base) ? base : {};
  const l = isPlain(local) ? local : {};
  const r = isPlain(remote) ? remote : {};
  const out = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
    if (BLOCKED_KEYS.has(k)) continue;
    let v;
    if (equal(l[k], r[k])) v = l[k];
    else if (equal(l[k], b[k])) v = r[k];
    else if (equal(r[k], b[k])) v = l[k];
    else v = onConflict(b[k], l[k], r[k], k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- families
const mergeSettings = (base, local, remote) => mergeMap(base, local, remote);
const mergeSkills = (base, local, remote) => mergeMap(base, local, remote);

function mergeGuide(base, local, remote) {
  const read = mergeMap(base?.read, local?.read, remote?.read, (b, l, r) => (Number.isFinite(l) && Number.isFinite(r) ? Math.max(l, r) : keepData(b, l, r)));
  const ll = isPlain(local?.last) ? local.last : null;
  const rl = isPlain(remote?.last) ? remote.last : null;
  const last = !ll ? rl : !rl ? ll : num(rl.t) > num(ll.t) ? rl : ll;
  return { read, last };
}

// Per-question counters. With a base, each side's increase since the base is added once, so an attempt is never counted twice.
// Without a base (the first sync of a device that already has progress, which the learner has agreed to combine) the two sides are
// different attempts made on different devices, so they are added together. If a device only holds an older copy of progress that
// is already in the account, the learner should choose "use my account's progress" instead (the approval text says so).
function mergeQuestion(b, l, r) {
  const newer = num(r.t) > num(l.t) ? r : l;
  const known = isPlain(b);
  const gain = (side) => Math.max(0, num(side.a) - num(b.a));
  const gainC = (side) => Math.max(0, num(side.c) - num(b.c));
  const a = known ? num(b.a) + gain(l) + gain(r) : num(l.a) + num(r.a);
  const c = Math.min(known ? num(b.c) + gainC(l) + gainC(r) : num(l.c) + num(r.c), a);
  return { a, c, last: newer.last === 1 ? 1 : 0, t: num(newer.t) };
}

function mergeQstats(base, local, remote) {
  return mergeMap(base, local, remote, (b, l, r) => (l !== undefined && r !== undefined ? mergeQuestion(b, l, r) : keepData(b, l, r)));
}

/** Attempt summaries are immutable and identified by id, so the merge is a set merge: removal on either side sticks. */
function mergeHistory(base, local, remote, { maxHistory = 40 } = {}) {
  const list = (v) => (Array.isArray(v) ? v.filter((e) => isPlain(e) && typeof e.id === 'string') : []);
  const b = list(base);
  const l = list(local);
  const r = list(remote);
  const inBase = new Set(b.map((e) => e.id));
  const inLocal = new Set(l.map((e) => e.id));
  const inRemote = new Set(r.map((e) => e.id));
  const byId = new Map();
  for (const e of [...r, ...l]) byId.set(e.id, e);
  return [...byId.values()]
    .filter((e) => !inBase.has(e.id) || (inLocal.has(e.id) && inRemote.has(e.id)))
    .sort((x, y) => num(y.endedAt) - num(x.endedAt) || (x.id < y.id ? -1 : 1))
    .slice(0, maxHistory);
}

const MERGERS = { settings: mergeSettings, guide: mergeGuide, skills: mergeSkills, qstats: mergeQstats, history: mergeHistory };

/**
 * Decides what a document should be after a sync.
 * `base` for the immutable `sess` family is just `true` ("known to the cloud") or undefined, because those documents never change.
 * Returns the merged value, or undefined when the document should not exist.
 */
export function reconcile(family, base, local, remote, options = {}) {
  if (equal(local, remote)) return local;
  const hasLocal = local !== undefined;
  const hasRemote = remote !== undefined;

  if (family === 'sess') {
    if (hasLocal && hasRemote) return local;
    if (base === undefined) return hasLocal ? local : remote; // new on one side
    return undefined; // known to both once, now gone from one side: a deletion
  }

  if (hasLocal && hasRemote) return MERGERS[family](base, local, remote, options);
  if (!hasLocal) {
    // Deleted here (for example "Reset all progress"). If the cloud copy changed since, keep their data.
    if (base === undefined) return remote;
    return equal(remote, base) ? undefined : remote;
  }
  if (base === undefined) return local;
  return equal(local, base) ? undefined : local;
}
