import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  emptyAnswer, normalizeAnswer, answerState, isCorrect, correctAnswer, permutation, optionOrder, blankOrder, itemOrder,
  gradeSession, bandFor, selectCount, hashString,
} from '../js/grade.js';

const exam = JSON.parse(await readFile(new URL('../content/ab-400/exams/practice-1.json', import.meta.url), 'utf8'));
const questions = exam.questions.map((q) => ({ ...q, key: `${exam.id}/${q.id}` }));
const byType = (t) => questions.filter((q) => q.type === t);

const single = { type: 'single', key: 's', options: ['a', 'b', 'c', 'd'], answer: [2] };
const multi = { type: 'multi', key: 'm', options: ['a', 'b', 'c', 'd', 'e'], answer: [3, 1], select: 2 };
const yesno = { type: 'yesno', key: 'y', statements: [{ answer: true }, { answer: false }, { answer: true }] };
const order = { type: 'order', key: 'o', items: ['one', 'two', 'three'] };
const dropdown = { type: 'dropdown', key: 'd', blanks: [{ options: ['x', 'y', 'z'], answer: 1 }, { options: ['p', 'q'], answer: 0 }] };

test('empty answers and answer states', () => {
  assert.equal(emptyAnswer(single), null);
  assert.deepEqual(emptyAnswer(multi), []);
  assert.deepEqual(emptyAnswer(yesno), [null, null, null]);
  assert.deepEqual(emptyAnswer(dropdown), [null, null]);
  assert.equal(answerState(single, null), 'empty');
  assert.equal(answerState(single, 0), 'complete');
  assert.equal(answerState(multi, [1]), 'partial');
  assert.equal(answerState(multi, [1, 3]), 'complete');
  assert.equal(answerState(yesno, [true, null, null]), 'partial');
  assert.equal(answerState(yesno, [true, false, false]), 'complete');
  assert.equal(answerState(order, [2, 0]), 'partial');
  assert.equal(answerState(order, [2, 0, 1]), 'complete');
  assert.equal(answerState(dropdown, [1, null]), 'partial');
});

test('correctness is all-or-nothing and order-insensitive for multi', () => {
  assert.ok(isCorrect(single, 2));
  assert.ok(!isCorrect(single, 1));
  assert.ok(isCorrect(multi, [1, 3]));
  assert.ok(isCorrect(multi, [3, 1]), 'selection order must not matter');
  assert.ok(!isCorrect(multi, [1, 2]));
  assert.ok(!isCorrect(multi, [1]), 'partial multi is wrong');
  assert.ok(isCorrect(yesno, [true, false, true]));
  assert.ok(!isCorrect(yesno, [true, false, false]));
  assert.ok(!isCorrect(yesno, [true, false, null]));
  assert.ok(isCorrect(order, [0, 1, 2]));
  assert.ok(!isCorrect(order, [1, 0, 2]));
  assert.ok(isCorrect(dropdown, [1, 0]));
  assert.ok(!isCorrect(dropdown, [1, 1]));
});

test('normalizeAnswer repairs malformed stored answers', () => {
  assert.equal(normalizeAnswer(single, 99), null);
  assert.equal(normalizeAnswer(single, 'x'), null);
  assert.deepEqual(normalizeAnswer(multi, [3, 3, 1, 42, -1]), [1, 3]);
  assert.deepEqual(normalizeAnswer(multi, [0, 1, 2, 3]), [0, 1], 'never more than the select count');
  assert.deepEqual(normalizeAnswer(yesno, [true, 'no']), [true, null, null]);
  assert.deepEqual(normalizeAnswer(order, [2, 2, 0, 9]), [2, 0]);
  assert.deepEqual(normalizeAnswer(dropdown, [5, 0]), [null, 0]);
  assert.equal(selectCount(multi), 2);
  assert.equal(selectCount(single), 1);
});

test('shuffling is deterministic, a real permutation, and order items never show in the answer order', () => {
  const a = permutation(8, 'seed-1');
  assert.deepEqual(a, permutation(8, 'seed-1'));
  assert.deepEqual([...a].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.notDeepEqual(a, permutation(8, 'seed-2'));
  for (let i = 0; i < 200; i += 1) {
    const p = itemOrder({ key: `k${i}`, items: ['a', 'b', 'c'] }, 12345);
    assert.notDeepEqual(p, [0, 1, 2]);
  }
  assert.deepEqual(optionOrder(single, 1, false), [0, 1, 2, 3]);
  assert.equal(optionOrder(single, 1, true).length, 4);
  assert.deepEqual(blankOrder(dropdown, 1, false, 1), [0, 1]);
  assert.ok(hashString('abc') >= 0);
});

test('gradeSession counts correct, wrong, partial, revealed and unattempted', () => {
  const qmap = new Map([['s', { ...single, domain: 1, section: 'x', skill: 1 }], ['m', { ...multi, domain: 1, section: 'x', skill: 2 }],
    ['y', { ...yesno, domain: 2, section: 'y', skill: 3 }], ['o', { ...order, domain: 2, section: 'y', skill: 4 }]]);
  const r = gradeSession({
    keys: ['s', 'm', 'y', 'o', 'gone'],
    answers: { s: 2, m: [1], y: [true, false, true] },
    revealed: { o: true },
  }, qmap);
  assert.equal(r.total, 4, 'unknown keys are ignored');
  assert.equal(r.correct, 2);
  assert.equal(r.attempted, 4);
  assert.deepEqual(r.perQuestion, { s: 'c', m: 'w', y: 'c', o: 'w' });
  assert.equal(r.pct, 50);
  assert.deepEqual(r.byDomain[1], { c: 1, w: 1, u: 0 });
  assert.deepEqual(r.byDomain[2], { c: 1, w: 1, u: 0 });
  const none = gradeSession({ keys: ['s'], answers: {} }, qmap);
  assert.equal(none.perQuestion.s, 'u');
  assert.equal(none.attempted, 0);
});

test('bandFor picks the highest band reached', () => {
  const bands = [{ min: 0, label: 'low' }, { min: 0.8, label: 'high' }, { min: 0.7, label: 'mid' }];
  assert.equal(bandFor(95, bands).label, 'high');
  assert.equal(bandFor(80, bands).label, 'high');
  assert.equal(bandFor(79, bands).label, 'mid');
  assert.equal(bandFor(10, bands).label, 'low');
  assert.equal(bandFor(50, []), null);
});

test('real exam: the keyed answer is correct and every wrong alternative is rejected', () => {
  assert.equal(questions.length, 60);
  for (const q of questions) {
    const good = correctAnswer(q);
    assert.equal(answerState(q, good), 'complete', q.id);
    assert.ok(isCorrect(q, good), `${q.id} keyed answer must grade as correct`);
  }
  for (const q of byType('single')) {
    for (let i = 0; i < q.options.length; i += 1) assert.equal(isCorrect(q, i), i === q.answer[0], `${q.id} option ${i}`);
  }
  for (const q of byType('multi')) {
    const wrong = q.options.map((_, i) => i).filter((i) => !q.answer.includes(i)).slice(0, q.answer.length);
    assert.ok(!isCorrect(q, wrong), `${q.id} all-wrong must fail`);
    assert.ok(!isCorrect(q, q.answer.slice(0, 1)), `${q.id} partial must fail`);
  }
  for (const q of byType('yesno')) assert.ok(!isCorrect(q, q.statements.map((s) => !s.answer)), q.id);
  for (const q of byType('order')) {
    const reversed = q.items.map((_, i) => i).reverse();
    assert.ok(!isCorrect(q, reversed), q.id);
  }
  for (const q of byType('dropdown')) assert.ok(!isCorrect(q, q.blanks.map((b) => (b.answer + 1) % b.options.length)), q.id);
});

test('real exam: question mix matches the study guide (domains and formats)', () => {
  const count = (f) => questions.filter(f).length;
  assert.deepEqual([1, 2, 3, 4].map((d) => count((q) => q.domain === d)), [11, 17, 23, 9]);
  assert.equal(byType('single').length, 41);
  assert.equal(byType('multi').length, 6);
  assert.equal(byType('yesno').length, 7);
  assert.equal(byType('order').length, 2);
  assert.equal(byType('dropdown').length, 4);
  assert.equal(count((q) => q.caseStudy === 'contoso'), 5);
});
