import test from 'node:test';
import assert from 'node:assert/strict';
import { equal, familyOf, isSyncedKey, reconcile } from '../js/merge.js';

test('only learner data syncs; device state does not', () => {
  for (const k of ['settings', 'guide.ab-400', 'skills.ab-400', 'qstats.mb-230', 'history.ai-103', 'sess.0f8e7d6c-1111-4222-8333-444455556666']) {
    assert.ok(isSyncedKey(k), k);
  }
  for (const k of ['active.ab-400', 'ui.hint.install', 'sync.state', 'guide', 'sess.short', 'settings.x', 'qstats.', '__proto__']) {
    assert.equal(isSyncedKey(k), false, k);
  }
  assert.equal(familyOf('guide.ab-400'), 'guide');
  assert.equal(familyOf('nope'), null);
});

test('equal ignores key order and compares deeply', () => {
  assert.ok(equal({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(equal(undefined, undefined));
  assert.equal(equal(undefined, null), false);
  assert.equal(equal({ a: 1 }, { a: 2 }), false);
  assert.equal(equal([1, 2], [2, 1]), false);
});

test('settings: each side keeps its own change; a real conflict keeps this device', () => {
  const base = { theme: 'system', fontScale: 1 };
  assert.deepEqual(reconcile('settings', base, { theme: 'dark', fontScale: 1 }, { theme: 'system', fontScale: 1.3 }), { theme: 'dark', fontScale: 1.3 });
  assert.deepEqual(reconcile('settings', base, { theme: 'dark', fontScale: 1 }, { theme: 'light', fontScale: 1 }), { theme: 'dark', fontScale: 1 });
});

test('guide: read marks from both devices are kept, unread propagates, newest reading position wins', () => {
  const base = { read: { a: 1, b: 2 }, last: { gid: 'g', sid: 'a', y: 0, t: 5 } };
  const local = { read: { a: 1, b: 2, c: 30 }, last: { gid: 'g', sid: 'c', y: 10, t: 30 } };
  const remote = { read: { b: 2, d: 40 }, last: { gid: 'g', sid: 'd', y: 20, t: 40 } };
  assert.deepEqual(reconcile('guide', base, local, remote), { read: { b: 2, c: 30, d: 40 }, last: { gid: 'g', sid: 'd', y: 20, t: 40 } });
  // both marked the same section: keep the later time
  assert.deepEqual(reconcile('guide', { read: {}, last: null }, { read: { s: 10 }, last: null }, { read: { s: 20 }, last: null }), { read: { s: 20 }, last: null });
});

test('skills: ratings merge per skill and a rating beats a deletion in a conflict', () => {
  const base = { 1: 2, 2: 3 };
  assert.deepEqual(reconcile('skills', base, { 1: 4, 2: 3 }, { 1: 2, 2: 5, 3: 1 }), { 1: 4, 2: 5, 3: 1 });
  assert.deepEqual(reconcile('skills', base, { 2: 3 }, { 1: 2, 2: 3 }), { 2: 3 });
  assert.deepEqual(reconcile('skills', base, { 2: 3 }, { 1: 5, 2: 3 }), { 1: 5, 2: 3 });
});

test('qstats: attempts made on two devices add up exactly once', () => {
  const base = { 'p/q1': { a: 2, c: 1, last: 0, t: 10 } };
  const local = { 'p/q1': { a: 3, c: 2, last: 1, t: 20 } };
  const remote = { 'p/q1': { a: 4, c: 1, last: 0, t: 30 }, 'p/q2': { a: 1, c: 1, last: 1, t: 31 } };
  assert.deepEqual(reconcile('qstats', base, local, remote), {
    'p/q1': { a: 5, c: 2, last: 0, t: 30 },
    'p/q2': { a: 1, c: 1, last: 1, t: 31 },
  });
});

test('qstats: with no base the two devices\' attempts are added, and correct never exceeds attempts', () => {
  // The first sync of a device that already had progress: both sides made their own, different attempts.
  assert.deepEqual(
    reconcile('qstats', undefined, { 'p/q1': { a: 7, c: 6, last: 1, t: 60 } }, { 'p/q1': { a: 5, c: 4, last: 0, t: 40 } }),
    { 'p/q1': { a: 12, c: 10, last: 1, t: 60 } },
  );
  assert.deepEqual(
    reconcile('qstats', undefined, { 'p/q1': { a: 5, c: 5, last: 1, t: 50 } }, { 'p/q1': { a: 7, c: 2, last: 0, t: 40 }, 'p/q2': { a: 1, c: 0, last: 0, t: 41 } }),
    { 'p/q1': { a: 12, c: 7, last: 1, t: 50 }, 'p/q2': { a: 1, c: 0, last: 0, t: 41 } },
  );
  // Defensive: even malformed input (correct above attempts) cannot produce a value the app would reject.
  assert.deepEqual(reconcile('qstats', undefined, { 'p/q': { a: 1, c: 5, last: 1, t: 1 } }, { 'p/q': { a: 2, c: 1, last: 0, t: 2 } }), { 'p/q': { a: 3, c: 3, last: 0, t: 2 } });
  // Identical documents are the same data (for example the same snapshot), not two sets of attempts.
  const same = reconcile('qstats', undefined, { 'p/q': { a: 1, c: 1, last: 1, t: 1 } }, { 'p/q': { a: 1, c: 1, last: 1, t: 1 } });
  assert.deepEqual(same, { 'p/q': { a: 1, c: 1, last: 1, t: 1 } });
});

test('qstats: re-merging the same cloud copy is a no-op once the base has been advanced (no double counting on retry)', () => {
  const base = { 'p/q1': { a: 2, c: 1, last: 0, t: 10 } };
  const local = { 'p/q1': { a: 3, c: 2, last: 1, t: 20 } };
  const remote = { 'p/q1': { a: 3, c: 1, last: 0, t: 30 } };
  const merged = reconcile('qstats', base, local, remote);
  assert.deepEqual(merged, { 'p/q1': { a: 4, c: 2, last: 0, t: 30 } });
  // After a successful merge the engine records `remote` as the new base. Merging the same remote again must change nothing.
  assert.deepEqual(reconcile('qstats', remote, merged, remote), merged);
});

test('history: union by id, newest first, removal on either side sticks, capped', () => {
  const e = (id, endedAt) => ({ id, endedAt, total: 60, correct: 30, pct: 50 });
  const base = [e('a', 10), e('b', 20)];
  const local = [e('c', 30), e('a', 10)]; // added c, deleted b
  const remote = [e('d', 40), e('b', 20), e('a', 10)]; // added d
  assert.deepEqual(reconcile('history', base, local, remote).map((x) => x.id), ['d', 'c', 'a']);
  const many = Array.from({ length: 50 }, (_, i) => e(`id-${String(i).padStart(2, '0')}`, i));
  assert.equal(reconcile('history', [], many, []).length, 40);
  assert.equal(reconcile('history', [], many, [])[0].id, 'id-49');
});

test('whole documents: new data is adopted, deletions win only when the other side did not change', () => {
  const doc = { 1: 3 };
  assert.deepEqual(reconcile('skills', undefined, doc, undefined), doc);
  assert.deepEqual(reconcile('skills', undefined, undefined, doc), doc);
  // deleted here, unchanged in the cloud: stay deleted
  assert.equal(reconcile('skills', doc, undefined, doc), undefined);
  // deleted here, but the cloud changed it since: keep their data
  assert.deepEqual(reconcile('skills', doc, undefined, { 1: 5 }), { 1: 5 });
  // deleted in the cloud, unchanged here: delete here too; changed here: re-upload
  assert.equal(reconcile('skills', doc, doc, undefined), undefined);
  assert.deepEqual(reconcile('skills', doc, { 1: 4 }, undefined), { 1: 4 });
  assert.equal(reconcile('skills', undefined, undefined, undefined), undefined);
});

test('sessions are immutable: union, and a deletion once both sides knew the document', () => {
  const s = { id: 'x', packId: 'p' };
  assert.deepEqual(reconcile('sess', undefined, s, undefined), s);
  assert.deepEqual(reconcile('sess', undefined, undefined, s), s);
  assert.equal(reconcile('sess', true, undefined, s), undefined);
  assert.equal(reconcile('sess', true, s, undefined), undefined);
  assert.deepEqual(reconcile('sess', true, s, { ...s, extra: 1 }), s);
});

test('merging cannot be used to pollute prototypes', () => {
  const evil = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"ok":1}');
  const merged = reconcile('skills', {}, {}, evil);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(merged, '__proto__'), false);
  assert.equal(Object.hasOwn(merged, 'constructor'), false);
  assert.equal(merged.ok, 1);
});
