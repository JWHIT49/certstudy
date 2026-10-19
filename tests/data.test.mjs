import test from 'node:test';
import assert from 'node:assert/strict';
import * as data from '../js/data.js';
import * as store from '../js/store.js';

const session = (id) => ({ id, packId: 'p', title: 'T', mode: 'exam', examId: 'e', keys: ['e/q1', 'e/q2'], answers: {}, startedAt: 1, activeMs: 5 });
const result = { total: 2, attempted: 2, correct: 1, pct: 50, perQuestion: { 'e/q1': 'c', 'e/q2': 'w' } };

test('finishing the same session twice records it once', () => {
  store.clearAll();
  const s = session('aaaaaaaa-1');
  data.saveActive(s);
  const first = data.recordFinished(s, result);
  const second = data.recordFinished(s, result);
  assert.equal(first.id, second.id);
  assert.equal(data.getHistory('p').length, 1, 'one history entry');
  assert.deepEqual(data.getQStats('p')['e/q1'].a, 1, 'statistics are not counted twice');
  assert.equal(data.getQStats('p')['e/q2'].c, 0);
  assert.equal(data.getActive('p'), null, 'the in-progress session is cleared');
});

test('history is capped and orphaned finished sessions are removed', () => {
  store.clearAll();
  for (let i = 0; i < 45; i += 1) data.recordFinished(session(`bbbbbbbb-${i}`), result);
  const history = data.getHistory('p');
  assert.equal(history.length, 40);
  assert.equal(history[0].id, 'bbbbbbbb-44', 'newest first');
  assert.equal(data.getSession('bbbbbbbb-0'), null, 'the oldest attempts are deleted');
  assert.ok(data.getSession('bbbbbbbb-44'));
});

test('deleting an attempt keeps the other attempts and the question statistics', () => {
  store.clearAll();
  data.recordFinished(session('cccccccc-1'), result);
  data.recordFinished(session('cccccccc-2'), result);
  data.deleteSession('p', 'cccccccc-1');
  assert.deepEqual(data.getHistory('p').map((h) => h.id), ['cccccccc-2']);
  assert.equal(data.getSession('cccccccc-1'), null);
  assert.equal(data.getQStats('p')['e/q1'].a, 2);
});
