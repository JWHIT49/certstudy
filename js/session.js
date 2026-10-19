// Practice-session creation helpers (pure; no DOM).
import { uid } from './dom.js';

export function shuffled(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createSession({ packId, title, keys, mode, shuffle = false, autoCheck = false, minutes = null, examId = null }) {
  return {
    v: 1, id: uid(), packId, examId, title, mode,
    shuffle: Boolean(shuffle), autoCheck: mode === 'study' && Boolean(autoCheck),
    seed: Math.floor(Math.random() * 2 ** 31),
    keys, idx: 0, answers: {}, checked: {}, revealed: {}, flags: {},
    startedAt: Date.now(), activeMs: 0,
    limitMs: mode === 'exam' && minutes ? Math.round(minutes * 60000) : null,
    status: 'active',
  };
}

/**
 * Picks question keys for a drill.
 * qmap: Map<key, question>   stats: { [key]: {a, c, last} }   domains: number[] (empty = all)   source: 'all' | 'missed' | 'new'
 */
export function pickDrillKeys({ qmap, stats, domains = [], source = 'all', count = 10 }) {
  let pool = [...qmap.values()];
  if (domains.length) pool = pool.filter((q) => domains.includes(q.domain));
  if (source === 'missed') pool = pool.filter((q) => stats[q.key]?.last === 0);
  if (source === 'new') pool = pool.filter((q) => !stats[q.key]);
  return shuffled(pool).slice(0, count).map((q) => q.key);
}
