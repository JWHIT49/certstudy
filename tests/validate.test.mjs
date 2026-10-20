import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { validateLoadedPack, validateQuestion, validateExam, validatePack } from '../js/validate.js';

const read = async (p) => JSON.parse(await readFile(new URL(`../content/ab-400/${p}`, import.meta.url), 'utf8'));
const load = async () => {
  const pack = await read('pack.json');
  return { pack, guides: { 'study-guide': await read('guide.json') }, skills: await read('skills.json'), exams: { 'practice-1': await read('exams/practice-1.json') } };
};

const contentDir = new URL('../content/', import.meta.url);
async function loadPackDir(dir) {
  const rd = async (p) => JSON.parse(await readFile(new URL(`${dir}/${p}`, contentDir), 'utf8'));
  const pack = await rd('pack.json');
  const loaded = { pack, guides: {}, skills: null, exams: {} };
  for (const g of pack.guides) loaded.guides[g.id] = await rd(g.file);
  if (pack.skills) loaded.skills = await rd(pack.skills.file);
  for (const x of pack.exams) loaded.exams[x.id] = await rd(x.file);
  return loaded;
}

test('every shipped pack is valid, consistent and free of encoding damage', async () => {
  const dirs = (await readdir(contentDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(dirs.includes('ab-400'));
  for (const dir of dirs) {
    const loaded = await loadPackDir(dir);
    assert.deepEqual(validateLoadedPack(loaded), [], dir);
    assert.equal(loaded.pack.id, dir, `${dir}: pack id must match its folder`);
    for (const x of loaded.pack.exams) assert.equal(loaded.exams[x.id].questions.length, x.questions, `${dir}/${x.id}: question count in pack.json`);
    const sectionIds = Object.values(loaded.guides).flatMap((g) => g.parts.flatMap((p) => p.sections.map((s) => s.id)));
    assert.ok(sectionIds.length > 0, `${dir}: has guide sections`);
    assert.ok(!/â€|Ã[\u0080-\u00bf]|Â[\u00a0-\u00bf]/.test(JSON.stringify(loaded)), `${dir}: contains mojibake (wrong file encoding)`);
    for (const exam of Object.values(loaded.exams)) {
      for (const cs of exam.caseStudies ?? []) assert.ok(exam.questions.some((q) => q.caseStudy === cs.id), `${dir}: case study ${cs.id} has questions`);
      for (const q of exam.questions) if (q.caseStudy) assert.ok((exam.caseStudies ?? []).some((c) => c.id === q.caseStudy), `${dir}/${q.id}: unknown case study`);
    }
  }
});

test('the AB-400 pack stays valid', async () => {
  assert.deepEqual(validateLoadedPack(await load()), []);
});

test('detects broken references and malformed questions', async () => {
  const base = await load();
  const clone = () => structuredClone(base);

  let c = clone();
  c.exams['practice-1'].questions[0].section = 'no-such-section';
  assert.ok(validateLoadedPack(c).some((m) => m.includes('unknown guide section')));

  c = clone();
  c.exams['practice-1'].questions[0].domain = 9;
  assert.ok(validateLoadedPack(c).some((m) => m.includes('unknown domain')));

  c = clone();
  c.exams['practice-1'].questions[1].id = c.exams['practice-1'].questions[0].id;
  assert.ok(validateLoadedPack(c).some((m) => m.includes('duplicate')));

  c = clone();
  c.skills.groups[0].skills[0].refs = ['nope'];
  assert.ok(validateLoadedPack(c).some((m) => m.includes('unknown section')));

  c = clone();
  c.guides['study-guide'].parts[0].sections[0].html = '<p>hi</p><script>alert(1)</script>';
  assert.ok(validateLoadedPack(c).some((m) => m.includes('script-like')));
});

test('content must not use inline styles (blocked by the CSP) but may mention them as escaped text', () => {
  const ok = { id: 'q1', type: 'single', domain: 1, stem: 's', explanation: 'e', options: ['a', 'b'], answer: [0] };
  const bad = validateQuestion({ ...ok, explanation: '<span class="bar-fill" style="width:5%"></span>' }, 'q');
  assert.ok(bad.some((m) => m.includes('inline-style')), 'a real style attribute is rejected');
  assert.deepEqual(validateQuestion({ ...ok, explanation: 'Use <code>&lt;div style="color:red"&gt;</code> sparingly' }, 'q'), [], 'escaped code samples are fine');
  assert.deepEqual(validateQuestion({ ...ok, explanation: '<span class="bar-fill" data-w="5"></span>' }, 'q'), [], 'data-w is the supported way to size bars');
});

test('question rules per type', () => {
  const ok = { id: 'q1', type: 'single', domain: 1, stem: 's', explanation: 'e', options: ['a', 'b'], answer: [0] };
  assert.deepEqual(validateQuestion(ok, 'q'), []);
  assert.ok(validateQuestion({ ...ok, answer: [2] }, 'q').length);
  assert.ok(validateQuestion({ ...ok, answer: [0, 1] }, 'q').length, 'single needs exactly one answer');
  assert.ok(validateQuestion({ ...ok, type: 'multi', options: ['a', 'b', 'c'], answer: [0] }, 'q').length, 'multi needs two answers');
  assert.ok(validateQuestion({ ...ok, type: 'multi', options: ['a', 'b', 'c'], answer: [0, 1], select: 3 }, 'q').length);
  assert.ok(validateQuestion({ ...ok, type: 'yesno', statements: [{ text: 't', answer: 'yes' }] }, 'q').length);
  assert.ok(validateQuestion({ ...ok, type: 'order', items: ['only one'] }, 'q').length);
  const dd = { ...ok, type: 'dropdown', format: 'code', template: 'x {1} y {2}', blanks: [{ options: ['a', 'b'], answer: 0 }, { options: ['c', 'd'], answer: 1 }] };
  assert.deepEqual(validateQuestion(dd, 'q'), []);
  assert.ok(validateQuestion({ ...dd, template: 'x {1} y' }, 'q').some((m) => m.includes('{2}')));
  assert.ok(validateQuestion({ ...dd, template: 'x {1} {1} y {2}' }, 'q').some((m) => m.includes('exactly once')));
  assert.ok(validateQuestion({ ...dd, template: 'x {1} y {2} {3}' }, 'q').some((m) => m.includes('no matching blank')));
  assert.ok(validateQuestion({ ...ok, ref: 'javascript:alert(1)' }, 'q').some((m) => m.includes('http')));
});

test('exam and pack level rules', async () => {
  assert.ok(validateExam({ schema: 1, id: 'x', title: 't', questions: [] }).length);
  assert.ok(validatePack({ schema: 1, id: 'Bad Id', code: 'X', title: 'T', version: '1', domains: [{ id: 1, name: 'd' }], guides: [], exams: [] }).length);
  const { pack } = await load();
  assert.deepEqual(validatePack(pack), []);
});
