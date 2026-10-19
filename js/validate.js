// Pure content-pack validation. No DOM access, so it runs in Node (tools/build.mjs, tests) and in the browser.
// Every function returns an array of human-readable error strings; an empty array means "valid".

export const QUESTION_TYPES = ['single', 'multi', 'yesno', 'order', 'dropdown'];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const URL_RE = /^https?:\/\//i;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isInt = (v) => Number.isInteger(v);

const UNSAFE = 'contains script-like or inline-style content';

// Inline style attributes are rejected too: the app's CSP blocks them (bar widths use data-w instead).
function unsafeHtml(s) {
  return typeof s === 'string' && /<\s*(script|iframe|object|embed|link|meta|style)\b|<[a-z][^>]*\sstyle\s*=|\son[a-z]+\s*=|javascript:/i.test(s);
}

export function validatePack(pack) {
  const e = [];
  if (!isObj(pack)) return ['pack: must be an object'];
  if (pack.schema !== 1) e.push('pack.schema: must be 1');
  if (!ID_RE.test(pack.id ?? '')) e.push('pack.id: lowercase letters, digits and dashes only');
  for (const k of ['code', 'title', 'version']) if (!isStr(pack[k])) e.push(`pack.${k}: required string`);
  if (pack.accent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(pack.accent)) e.push('pack.accent: must look like #0f6cbd');
  if (!Array.isArray(pack.domains) || pack.domains.length === 0) e.push('pack.domains: at least one domain is required');
  else {
    const ids = new Set();
    pack.domains.forEach((d, i) => {
      if (!isInt(d?.id)) e.push(`pack.domains[${i}].id: integer required`);
      else if (ids.has(d.id)) e.push(`pack.domains[${i}].id: duplicate ${d.id}`);
      else ids.add(d.id);
      if (!isStr(d?.name)) e.push(`pack.domains[${i}].name: required string`);
    });
  }
  if (!Array.isArray(pack.guides)) e.push('pack.guides: array required (may be empty)');
  else {
    const ids = new Set();
    pack.guides.forEach((g, i) => {
      if (!ID_RE.test(g?.id ?? '')) e.push(`pack.guides[${i}].id: invalid`);
      else if (ids.has(g.id)) e.push(`pack.guides[${i}].id: duplicate`);
      else ids.add(g.id);
      if (!isStr(g?.title)) e.push(`pack.guides[${i}].title: required`);
      if (!isStr(g?.file)) e.push(`pack.guides[${i}].file: required`);
    });
  }
  if (!Array.isArray(pack.exams)) e.push('pack.exams: array required (may be empty)');
  else {
    const ids = new Set();
    pack.exams.forEach((x, i) => {
      if (!ID_RE.test(x?.id ?? '')) e.push(`pack.exams[${i}].id: invalid`);
      else if (ids.has(x.id)) e.push(`pack.exams[${i}].id: duplicate`);
      else ids.add(x.id);
      if (!isStr(x?.title)) e.push(`pack.exams[${i}].title: required`);
      if (!isStr(x?.file)) e.push(`pack.exams[${i}].file: required`);
    });
  }
  if (pack.skills !== undefined && !isStr(pack.skills?.file)) e.push('pack.skills.file: required when skills is present');
  (pack.links ?? []).forEach((l, i) => {
    if (!isStr(l?.title) || !URL_RE.test(l?.url ?? '')) e.push(`pack.links[${i}]: needs title and an http(s) url`);
  });
  return e;
}

/** Returns { errors, sectionIds, nums } so other validators can cross-check references. */
export function validateGuide(guide) {
  const errors = [];
  const sectionIds = new Set();
  const nums = new Set();
  if (!isObj(guide)) return { errors: ['guide: must be an object'], sectionIds, nums };
  if (guide.schema !== 1) errors.push('guide.schema: must be 1');
  if (!isStr(guide.title)) errors.push('guide.title: required');
  if (!Array.isArray(guide.parts) || guide.parts.length === 0) errors.push('guide.parts: at least one part required');
  const partIds = new Set();
  (guide.parts ?? []).forEach((p, i) => {
    const at = `guide.parts[${i}]`;
    if (!ID_RE.test(p?.id ?? '')) errors.push(`${at}.id: invalid`);
    else if (partIds.has(p.id)) errors.push(`${at}.id: duplicate ${p.id}`);
    else partIds.add(p.id);
    if (!isStr(p?.title)) errors.push(`${at}.title: required`);
    if (!Array.isArray(p?.sections) || p.sections.length === 0) errors.push(`${at}.sections: at least one section required`);
    (p?.sections ?? []).forEach((s, j) => {
      const sat = `${at}.sections[${j}]`;
      if (!ID_RE.test(s?.id ?? '')) errors.push(`${sat}.id: invalid`);
      else if (sectionIds.has(s.id)) errors.push(`${sat}.id: duplicate ${s.id}`);
      else sectionIds.add(s.id);
      if (!isStr(s?.title)) errors.push(`${sat}.title: required`);
      if (typeof s?.html !== 'string') errors.push(`${sat}.html: string required`);
      else if (unsafeHtml(s.html)) errors.push(`${sat}.html: ${UNSAFE}`);
      if (s?.num !== undefined) {
        if (!/^\d+\.\d+$/.test(s.num)) errors.push(`${sat}.num: must look like 3.1`);
        else if (nums.has(s.num)) errors.push(`${sat}.num: duplicate ${s.num}`);
        else nums.add(s.num);
      }
    });
  });
  return { errors, sectionIds, nums };
}

export function validateSkills(skills, sectionIds, domainIds) {
  const errors = [];
  const numbers = new Set();
  if (!isObj(skills)) return { errors: ['skills: must be an object'], numbers };
  if (skills.schema !== 1) errors.push('skills.schema: must be 1');
  if (!Array.isArray(skills.groups) || skills.groups.length === 0) errors.push('skills.groups: required');
  (skills.groups ?? []).forEach((g, i) => {
    const at = `skills.groups[${i}]`;
    if (!isStr(g?.title)) errors.push(`${at}.title: required`);
    if (domainIds && !domainIds.has(g?.domain)) errors.push(`${at}.domain: unknown domain ${g?.domain}`);
    (g?.skills ?? []).forEach((s, j) => {
      const sat = `${at}.skills[${j}]`;
      if (!isInt(s?.n) || s.n < 1) errors.push(`${sat}.n: positive integer required`);
      else if (numbers.has(s.n)) errors.push(`${sat}.n: duplicate skill ${s.n}`);
      else numbers.add(s.n);
      if (!isStr(s?.text)) errors.push(`${sat}.text: required`);
      (s?.refs ?? []).forEach((r) => { if (sectionIds && !sectionIds.has(r)) errors.push(`${sat}.refs: unknown section ${r}`); });
    });
  });
  return { errors, numbers };
}

function checkOptions(arr, at, min, e) {
  if (!Array.isArray(arr) || arr.length < min || !arr.every(isStr)) { e.push(`${at}: needs at least ${min} non-empty strings`); return false; }
  arr.forEach((o, i) => { if (unsafeHtml(o)) e.push(`${at}[${i}]: ${UNSAFE}`); });
  return true;
}

export function validateQuestion(q, at, ctx = {}) {
  const e = [];
  if (!isObj(q)) return [`${at}: must be an object`];
  if (!ID_RE.test(q.id ?? '')) e.push(`${at}.id: invalid`);
  if (!QUESTION_TYPES.includes(q.type)) { e.push(`${at}.type: must be one of ${QUESTION_TYPES.join(', ')}`); return e; }
  if (ctx.domainIds && !ctx.domainIds.has(q.domain)) e.push(`${at}.domain: unknown domain ${q.domain}`);
  if (q.skill !== undefined && ctx.skillNumbers && !ctx.skillNumbers.has(q.skill)) e.push(`${at}.skill: unknown skill ${q.skill}`);
  if (q.section !== undefined && ctx.sectionIds && !ctx.sectionIds.has(q.section)) e.push(`${at}.section: unknown guide section ${q.section}`);
  if (!isStr(q.stem)) e.push(`${at}.stem: required`);
  else if (unsafeHtml(q.stem)) e.push(`${at}.stem: ${UNSAFE}`);
  if (!isStr(q.explanation)) e.push(`${at}.explanation: required`);
  else if (unsafeHtml(q.explanation)) e.push(`${at}.explanation: ${UNSAFE}`);
  if (q.ref !== undefined && !URL_RE.test(q.ref)) e.push(`${at}.ref: must be an http(s) URL`);
  if (q.caseStudy !== undefined && ctx.caseStudyIds && !ctx.caseStudyIds.has(q.caseStudy)) e.push(`${at}.caseStudy: unknown case study ${q.caseStudy}`);

  switch (q.type) {
    case 'single':
    case 'multi': {
      const min = q.type === 'single' ? 2 : 3;
      if (!checkOptions(q.options, `${at}.options`, min, e)) break;
      const a = q.answer;
      if (!Array.isArray(a) || !a.every((i) => isInt(i) && i >= 0 && i < q.options.length) || new Set(a).size !== a.length) {
        e.push(`${at}.answer: must be unique valid option indexes`);
        break;
      }
      if (q.type === 'single' && a.length !== 1) e.push(`${at}.answer: single needs exactly one index`);
      if (q.type === 'multi') {
        if (a.length < 2) e.push(`${at}.answer: multi needs at least two indexes`);
        if (q.select !== undefined && q.select !== a.length) e.push(`${at}.select: must equal answer length (${a.length})`);
        if (a.length >= q.options.length) e.push(`${at}.answer: cannot select every option`);
      }
      break;
    }
    case 'yesno':
      if (!Array.isArray(q.statements) || q.statements.length === 0) e.push(`${at}.statements: at least one required`);
      else q.statements.forEach((s, i) => {
        if (!isStr(s?.text)) e.push(`${at}.statements[${i}].text: required`);
        else if (unsafeHtml(s.text)) e.push(`${at}.statements[${i}].text: ${UNSAFE}`);
        if (typeof s?.answer !== 'boolean') e.push(`${at}.statements[${i}].answer: boolean required`);
      });
      break;
    case 'order':
      checkOptions(q.items, `${at}.items`, 2, e);
      break;
    case 'dropdown': {
      if (!['text', 'code'].includes(q.format)) e.push(`${at}.format: must be "text" or "code"`);
      if (!isStr(q.template)) { e.push(`${at}.template: required`); break; }
      if (q.format === 'text' && unsafeHtml(q.template)) e.push(`${at}.template: ${UNSAFE}`);
      if (!Array.isArray(q.blanks) || q.blanks.length === 0) { e.push(`${at}.blanks: at least one required`); break; }
      q.blanks.forEach((b, i) => {
        if (!checkOptions(b?.options, `${at}.blanks[${i}].options`, 2, e)) return;
        if (!isInt(b.answer) || b.answer < 0 || b.answer >= b.options.length) e.push(`${at}.blanks[${i}].answer: invalid index`);
        const count = (q.template.match(new RegExp(`\\{${i + 1}\\}`, 'g')) ?? []).length;
        if (count !== 1) e.push(`${at}.template: placeholder {${i + 1}} must appear exactly once (found ${count})`);
      });
      const extra = [...q.template.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])).filter((n) => n < 1 || n > q.blanks.length);
      if (extra.length) e.push(`${at}.template: placeholder(s) {${extra.join('}, {')}} have no matching blank`);
      break;
    }
    default:
  }
  return e;
}

export function validateExam(exam, ctx = {}) {
  const errors = [];
  if (!isObj(exam)) return ['exam: must be an object'];
  if (exam.schema !== 1) errors.push('exam.schema: must be 1');
  if (!ID_RE.test(exam.id ?? '')) errors.push('exam.id: invalid');
  if (!isStr(exam.title)) errors.push('exam.title: required');
  if (exam.minutes !== undefined && !(isInt(exam.minutes) && exam.minutes > 0)) errors.push('exam.minutes: positive integer');
  const caseStudyIds = new Set();
  (exam.caseStudies ?? []).forEach((c, i) => {
    if (!ID_RE.test(c?.id ?? '')) errors.push(`exam.caseStudies[${i}].id: invalid`);
    else if (caseStudyIds.has(c.id)) errors.push(`exam.caseStudies[${i}].id: duplicate`);
    else caseStudyIds.add(c.id);
    if (!isStr(c?.title) || typeof c?.html !== 'string') errors.push(`exam.caseStudies[${i}]: title and html required`);
    else if (unsafeHtml(c.html)) errors.push(`exam.caseStudies[${i}].html: ${UNSAFE}`);
  });
  (exam.bands ?? []).forEach((b, i) => {
    if (typeof b?.min !== 'number' || b.min < 0 || b.min > 1 || !isStr(b?.label)) errors.push(`exam.bands[${i}]: needs min (0-1) and label`);
  });
  if (!Array.isArray(exam.questions) || exam.questions.length === 0) errors.push('exam.questions: at least one question required');
  const ids = new Set();
  (exam.questions ?? []).forEach((q, i) => {
    if (ids.has(q?.id)) errors.push(`exam.questions[${i}].id: duplicate ${q.id}`);
    ids.add(q?.id);
    errors.push(...validateQuestion(q, `exam.questions[${i}]${q?.id ? ` (${q.id})` : ''}`, { ...ctx, caseStudyIds }));
  });
  return errors;
}

/** Validates a whole pack given already-loaded parts: { pack, guides: {id: json}, skills, exams: {id: json} } */
export function validateLoadedPack({ pack, guides = {}, skills = null, exams = {} }) {
  const errors = validatePack(pack).map((m) => `[pack] ${m}`);
  if (errors.length) return errors;
  const domainIds = new Set(pack.domains.map((d) => d.id));
  const sectionIds = new Set();
  for (const g of pack.guides) {
    const r = validateGuide(guides[g.id]);
    r.errors.forEach((m) => errors.push(`[guide ${g.id}] ${m}`));
    r.sectionIds.forEach((s) => sectionIds.add(s));
  }
  let skillNumbers;
  if (pack.skills) {
    const r = validateSkills(skills, sectionIds, domainIds);
    r.errors.forEach((m) => errors.push(`[skills] ${m}`));
    skillNumbers = r.numbers;
  }
  for (const x of pack.exams) {
    validateExam(exams[x.id], { domainIds, sectionIds, skillNumbers }).forEach((m) => errors.push(`[exam ${x.id}] ${m}`));
  }
  return errors;
}
