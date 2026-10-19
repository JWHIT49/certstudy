// App-level user data (settings, reading progress, skill ratings, per-question stats, practice sessions) on top of store.js.
import * as store from './store.js';

export const DEFAULT_SETTINGS = { theme: 'system', fontScale: 1, shuffleOptions: false, autoCheck: false };
const MAX_HISTORY = 40;

// ---- settings
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...(store.get('settings', {}) ?? {}) });
export function setSetting(key, value) {
  const next = { ...getSettings(), [key]: value };
  store.set('settings', next);
  return next;
}

// ---- study guide progress: { read: {sectionId: 1}, last: {gid, sid, y, t} | null }
export const getGuideProgress = (pack) => ({ read: {}, last: null, ...(store.get(`guide.${pack}`, {}) ?? {}) });
export function setSectionRead(pack, sid, on) {
  const p = getGuideProgress(pack);
  if (on) p.read[sid] = Date.now();
  else delete p.read[sid];
  store.set(`guide.${pack}`, p);
}
export function setLastRead(pack, gid, sid, y) {
  const p = getGuideProgress(pack);
  p.last = { gid, sid, y: Math.max(0, Math.round(y)), t: Date.now() };
  store.set(`guide.${pack}`, p);
}

// ---- skill confidence ratings: { [skillNumber]: 1..5 }
export const getSkillRatings = (pack) => store.get(`skills.${pack}`, {}) ?? {};
export function setSkillRating(pack, n, rating) {
  const r = getSkillRatings(pack);
  if (rating) r[n] = rating;
  else delete r[n];
  store.set(`skills.${pack}`, r);
}

// ---- per-question stats: { [questionKey]: { a: attempts, c: correct, last: 1|0, t } }
export const getQStats = (pack) => store.get(`qstats.${pack}`, {}) ?? {};

// ---- sessions
export const getHistory = (pack) => store.get(`history.${pack}`, []) ?? [];
export const getActive = (pack) => store.get(`active.${pack}`, null);
export const saveActive = (session) => store.set(`active.${session.packId}`, session);
export const clearActive = (pack) => store.remove(`active.${pack}`);
export const getSession = (id) => store.get(`sess.${id}`, null);

/** Stores a finished session (with its grading result), updates history and per-question stats, clears the active session. */
export function recordFinished(session, result) {
  // Idempotent: finishing the same session twice (double tap, time-up racing a tap) must not count it twice.
  const already = store.get(`sess.${session.id}`, null);
  if (already?.status === 'finished') {
    clearActive(session.packId);
    return already;
  }
  const endedAt = Date.now();
  const finished = { ...session, status: 'finished', endedAt, result };
  store.set(`sess.${session.id}`, finished);

  const history = getHistory(session.packId);
  history.unshift({
    id: session.id, title: session.title, mode: session.mode, examId: session.examId ?? null,
    startedAt: session.startedAt, endedAt, activeMs: session.activeMs,
    total: result.total, attempted: result.attempted, correct: result.correct, pct: result.pct,
  });
  for (const old of history.splice(MAX_HISTORY)) store.remove(`sess.${old.id}`);
  store.set(`history.${session.packId}`, history);

  const stats = getQStats(session.packId);
  for (const [key, r] of Object.entries(result.perQuestion)) {
    if (r === 'u') continue;
    const s = stats[key] ?? { a: 0, c: 0 };
    s.a += 1;
    if (r === 'c') s.c += 1;
    s.last = r === 'c' ? 1 : 0;
    s.t = endedAt;
    stats[key] = s;
  }
  store.set(`qstats.${session.packId}`, stats);
  clearActive(session.packId);
  return finished;
}

export function deleteSession(pack, id) {
  store.remove(`sess.${id}`);
  store.set(`history.${pack}`, getHistory(pack).filter((h) => h.id !== id));
}

/** Removes all progress for one certification (keeps settings). */
export function resetPack(pack) {
  for (const h of getHistory(pack)) store.remove(`sess.${h.id}`);
  for (const k of ['guide', 'skills', 'qstats', 'history', 'active']) store.remove(`${k}.${pack}`);
}
