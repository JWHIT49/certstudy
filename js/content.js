// Loads content packs (catalog, pack, guides, skills, exams) from /content. Results are memoised; the service worker makes them offline.
const memo = new Map();

export class NotFoundError extends Error { name = 'NotFoundError'; }

function fetchJson(rel) {
  if (!memo.has(rel)) {
    const p = fetch(new URL(rel, document.baseURI)).then((res) => {
      if (!res.ok) throw new Error(`Could not load ${rel} (${res.status}). If you are offline, open this item once while online first.`);
      return res.json();
    });
    p.catch(() => memo.delete(rel));
    memo.set(rel, p);
  }
  return memo.get(rel);
}

export const qkey = (examId, qid) => `${examId}/${qid}`;
export const splitKey = (key) => { const i = key.indexOf('/'); return [key.slice(0, i), key.slice(i + 1)]; };
export const examIdsOf = (keys) => [...new Set(keys.map((k) => splitKey(k)[0]))];

export const loadCatalog = () => fetchJson('content/catalog.json');

export async function getPack(id) {
  const catalog = await loadCatalog();
  const entry = catalog.packs.find((p) => p.id === id);
  if (!entry) throw new NotFoundError(`There is no certification called “${id}”.`);
  return fetchJson(`content/${entry.path}`);
}

// ---- guides
const guideIndexes = new Map();

export function indexGuide(guide) {
  const sections = [];
  const byId = new Map();
  const byNum = new Map();
  guide.parts.forEach((part, partIndex) => {
    part.sections.forEach((sec) => {
      const item = { ...sec, partId: part.id, partTitle: part.title, partIndex, order: sections.length };
      sections.push(item);
      byId.set(sec.id, item);
      if (sec.num) byNum.set(sec.num, item);
    });
  });
  return { id: guide.id, title: guide.title, guide, sections, byId, byNum };
}

export async function getGuideIndex(pack, guideId) {
  const meta = pack.guides.find((g) => g.id === guideId);
  if (!meta) throw new NotFoundError(`This certification has no guide called “${guideId}”.`);
  const k = `${pack.id}/${guideId}`;
  if (!guideIndexes.has(k)) guideIndexes.set(k, indexGuide(await fetchJson(`content/${pack.id}/${meta.file}`)));
  return guideIndexes.get(k);
}

/** Maps a guide section id to the guide that contains it (searching every guide in the pack). */
export async function findSection(pack, sectionId) {
  for (const g of pack.guides) {
    const idx = await getGuideIndex(pack, g.id);
    const sec = idx.byId.get(sectionId);
    if (sec) return { guideId: g.id, section: sec, index: idx };
  }
  return null;
}

export async function getSkills(pack) {
  return pack.skills ? fetchJson(`content/${pack.id}/${pack.skills.file}`) : null;
}

/** Map of every guide section id in the pack -> { guideId, id, title, num, href }. Loads all guides of the pack. */
export async function getSectionMap(pack) {
  const map = new Map();
  for (const g of pack.guides) {
    const idx = await getGuideIndex(pack, g.id);
    for (const s of idx.sections) map.set(s.id, { guideId: g.id, id: s.id, title: s.title, num: s.num ?? null, href: `#/c/${pack.id}/guide/${g.id}/${s.id}` });
  }
  return map;
}

// ---- exams
const examCache = new Map();

export async function getExam(pack, examId) {
  const meta = pack.exams.find((x) => x.id === examId);
  if (!meta) throw new NotFoundError(`This certification has no exam called “${examId}”.`);
  const k = `${pack.id}/${examId}`;
  if (!examCache.has(k)) {
    const raw = await fetchJson(`content/${pack.id}/${meta.file}`);
    examCache.set(k, {
      ...raw,
      questions: raw.questions.map((q, i) => ({ ...q, key: qkey(raw.id, q.id), examId: raw.id, number: i + 1 })),
    });
  }
  return examCache.get(k);
}

/** Loads the given exams and returns { exams: Map(id -> exam), qmap: Map(key -> question) }. */
export async function getQuestionMap(pack, examIds = pack.exams.map((x) => x.id)) {
  const exams = new Map();
  const qmap = new Map();
  for (const id of examIds) {
    if (!pack.exams.some((x) => x.id === id)) continue;
    const exam = await getExam(pack, id);
    exams.set(id, exam);
    for (const q of exam.questions) qmap.set(q.key, q);
  }
  return { exams, qmap };
}
