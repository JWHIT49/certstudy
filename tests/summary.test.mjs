import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, isEmpty, describeSummary } from '../js/summary.js';

test('summary: counts answered questions, rated skills and read sections across every certification', () => {
  const s = summarize([
    ['qstats.ab-400', { 'practice-1/q001': { a: 3, c: 2, last: 1, t: 5 }, 'practice-1/q002': { a: 2, c: 0, last: 0, t: 6 } }],
    ['qstats.ab-410', { 'practice-1/q001': { a: 1, c: 1, last: 1, t: 7 } }],
    ['skills.ab-400', { 1: 4, 2: 5, 3: 2 }],
    ['guide.ab-400', { read: { 'exam-facts': 10, 'd1-arch': 20 }, last: null }],
    ['guide.ab-410', { read: {}, last: null }],
    ['history.ab-400', [{ id: 'x' }]], // attempts are not counted: the answered questions already say how much was practised
    ['settings', { theme: 'dark' }],
  ]);
  assert.deepEqual(s, { answered: 6, skills: 3, sections: 2 });
});

test('summary: untrusted or odd values are counted safely and never throw', () => {
  const s = summarize([
    ['qstats.p', { q1: { a: -4 }, q2: { a: 'many' }, q3: null, q4: { a: 2.9 }, q5: [] }],
    ['skills.p', [1, 2, 3]],
    ['guide.p', { read: [1, 2] }],
    ['guide.q', null],
    ['qstats.deleted', null], // a deletion marker from the cloud
  ]);
  assert.deepEqual(s, { answered: 2, skills: 0, sections: 0 });
  assert.deepEqual(summarize([]), { answered: 0, skills: 0, sections: 0 });
});

test('summary: wording is plain, singular where it should be, and "nothing yet" when empty', () => {
  assert.equal(describeSummary({ answered: 412, skills: 61, sections: 22 }), '412 questions answered \u00b7 61 skills rated \u00b7 22 sections read');
  assert.equal(describeSummary({ answered: 1, skills: 1, sections: 1 }), '1 question answered \u00b7 1 skill rated \u00b7 1 section read');
  assert.equal(describeSummary({ answered: 0, skills: 0, sections: 0 }), 'nothing yet');
  assert.equal(isEmpty({ answered: 0, skills: 0, sections: 0 }), true);
  assert.equal(isEmpty({ answered: 0, skills: 1, sections: 0 }), false);
});
