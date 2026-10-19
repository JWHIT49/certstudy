// Pure grading, shuffling and scoring logic. No DOM, no storage: unit-tested under Node (tests/grade.test.mjs).
//
// Answer shapes (always in ORIGINAL option/statement/item indexes, so shuffling never changes what is stored):
//   single   -> number | null
//   multi    -> number[]            (sorted)
//   yesno    -> (boolean | null)[]  one entry per statement
//   order    -> number[]            item indexes in the sequence the learner chose (items are authored in correct order)
//   dropdown -> (number | null)[]   one entry per blank
export const LETTERS = 'ABCDEFGH';

export const selectCount = (q) => (q.type === 'multi' ? (q.select ?? q.answer.length) : 1);

export function emptyAnswer(q) {
  switch (q.type) {
    case 'single': return null;
    case 'multi': return [];
    case 'yesno': return q.statements.map(() => null);
    case 'order': return [];
    case 'dropdown': return q.blanks.map(() => null);
    default: return null;
  }
}

const validIndex = (i, n) => Number.isInteger(i) && i >= 0 && i < n;

/** Coerces anything stored (possibly from older content) into a well-formed answer for q. */
export function normalizeAnswer(q, a) {
  if (a === undefined || a === null) return emptyAnswer(q);
  switch (q.type) {
    case 'single': return validIndex(a, q.options.length) ? a : null;
    case 'multi': {
      if (!Array.isArray(a)) return [];
      const uniq = [...new Set(a.filter((i) => validIndex(i, q.options.length)))].sort((x, y) => x - y);
      return uniq.slice(0, selectCount(q));
    }
    case 'yesno': return q.statements.map((_, i) => (typeof a?.[i] === 'boolean' ? a[i] : null));
    case 'order': {
      const seen = new Set();
      const out = [];
      for (const i of Array.isArray(a) ? a : []) {
        if (validIndex(i, q.items.length) && !seen.has(i)) { seen.add(i); out.push(i); }
      }
      return out;
    }
    case 'dropdown': return q.blanks.map((b, i) => (validIndex(a?.[i], b.options.length) ? a[i] : null));
    default: return a;
  }
}

/** 'empty' | 'partial' | 'complete' */
export function answerState(q, a) {
  const ans = normalizeAnswer(q, a);
  let done;
  let total;
  switch (q.type) {
    case 'single': done = ans === null ? 0 : 1; total = 1; break;
    case 'multi': done = ans.length; total = selectCount(q); break;
    case 'yesno': done = ans.filter((v) => v !== null).length; total = ans.length; break;
    case 'order': done = ans.length; total = q.items.length; break;
    case 'dropdown': done = ans.filter((v) => v !== null).length; total = ans.length; break;
    default: return 'empty';
  }
  if (done === 0) return 'empty';
  return done === total ? 'complete' : 'partial';
}

export function correctAnswer(q) {
  switch (q.type) {
    case 'single': return q.answer[0];
    case 'multi': return [...q.answer].sort((x, y) => x - y);
    case 'yesno': return q.statements.map((s) => s.answer);
    case 'order': return q.items.map((_, i) => i);
    case 'dropdown': return q.blanks.map((b) => b.answer);
    default: return null;
  }
}

export function isCorrect(q, a) {
  if (answerState(q, a) !== 'complete') return false;
  const ans = normalizeAnswer(q, a);
  const want = correctAnswer(q);
  if (q.type === 'single') return ans === want;
  return ans.length === want.length && ans.every((v, i) => v === want[i]);
}

// ---------------------------------------------------------------- deterministic shuffling
export function hashString(str) {
  let hsh = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hsh ^= str.charCodeAt(i);
    hsh = Math.imul(hsh, 16777619);
  }
  return hsh >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic permutation of 0..n-1 for a given seed string (Fisher-Yates). */
export function permutation(n, seed, avoidIdentity = false) {
  const idx = [...Array(n).keys()];
  const rand = mulberry32(hashString(seed));
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  if (avoidIdentity && n > 1 && idx.every((v, i) => v === i)) idx.push(idx.shift());
  return idx;
}

export const optionOrder = (q, seed, shuffle) => (shuffle ? permutation(q.options.length, `${seed}:${q.key}:o`) : [...q.options.keys()]);
export const blankOrder = (q, seed, shuffle, blank) => {
  const n = q.blanks[blank].options.length;
  return shuffle ? permutation(n, `${seed}:${q.key}:b${blank}`) : [...Array(n).keys()];
};
/** Items are authored in the correct order, so they are ALWAYS shown shuffled (never in the identity order). */
export const itemOrder = (q, seed) => permutation(q.items.length, `${seed}:${q.key}:i`, true);

// ---------------------------------------------------------------- scoring
/**
 * session: { keys: string[], answers, revealed }   qmap: Map<key, question>
 * Returns { total, attempted, correct, pct, perQuestion: {key: 'c'|'w'|'u'}, byDomain, bySection, bySkill }
 * 'c' correct, 'w' wrong (including partially answered or revealed), 'u' not attempted. Multi-part questions are all-or-nothing.
 */
export function gradeSession(session, qmap) {
  const perQuestion = {};
  const byDomain = {};
  const bySection = {};
  const bySkill = {};
  let correct = 0;
  let attempted = 0;
  let total = 0;
  const bump = (bucket, id, r) => {
    if (id === undefined || id === null) return;
    const e = (bucket[id] ??= { c: 0, w: 0, u: 0 });
    e[r] += 1;
  };
  for (const key of session.keys) {
    const q = qmap.get(key);
    if (!q) continue;
    total += 1;
    const state = answerState(q, session.answers?.[key]);
    const revealed = Boolean(session.revealed?.[key]);
    let r = 'u';
    if (state !== 'empty' || revealed) {
      attempted += 1;
      r = !revealed && isCorrect(q, session.answers?.[key]) ? 'c' : 'w';
    }
    if (r === 'c') correct += 1;
    perQuestion[key] = r;
    bump(byDomain, q.domain, r);
    bump(bySection, q.section, r);
    bump(bySkill, q.skill, r);
  }
  return { total, attempted, correct, pct: total ? Math.round((correct / total) * 100) : 0, perQuestion, byDomain, bySection, bySkill };
}

/** bands: [{min: 0..1, label, text}] in any order; returns the highest band whose min <= pct/100. */
export function bandFor(pct, bands) {
  if (!bands?.length) return null;
  return [...bands].sort((a, b) => b.min - a.min).find((b) => pct / 100 >= b.min) ?? null;
}
