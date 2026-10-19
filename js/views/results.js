import { h, icon, fmtDuration, fmtDateTime, plural } from '../dom.js';
import { getPack, getQuestionMap, getSectionMap, examIdsOf, NotFoundError } from '../content.js';
import * as data from '../data.js';
import { bandFor } from '../grade.js';
import { ring, confirmSheet, row } from '../ui.js';
import { go } from '../router.js';
import { openStartSheet } from './practice.js';

export async function resultsView({ params }) {
  const pack = await getPack(params.pack);
  const s = data.getSession(params.sid);
  if (!s?.result) throw new NotFoundError('That attempt is no longer stored on this device.');
  const { exams } = await getQuestionMap(pack, examIdsOf(s.keys));
  const sections = await getSectionMap(pack);
  const r = s.result;
  const exam = s.examId ? exams.get(s.examId) : null;
  const band = exam ? bandFor(r.pct, exam.bands) : null;
  const missed = s.keys.filter((k) => r.perQuestion[k] && r.perQuestion[k] !== 'c');
  const base = `#/c/${pack.id}`;
  const ratio = (pack.exams[0]?.minutes ?? 100) / (pack.exams[0]?.questions ?? 60);

  const hero = h('section', { class: ['card', 'result-hero', band && `band-${band.label.toLowerCase().replace(/\W+/g, '-')}`] },
    ring(r.pct, { sub: `${r.correct} of ${r.total}` }),
    h('div', { class: 'result-text' },
      h('h2', null, band?.label ?? (r.pct >= 80 ? 'Strong result' : r.pct >= 70 ? 'Getting close' : 'Keep going')),
      band ? h('p', null, band.text) : null,
      h('p', { class: 'muted small' }, `${s.mode === 'exam' ? 'Exam' : 'Study'} mode · ${fmtDuration(s.activeMs)} · ${fmtDateTime(s.endedAt)}`),
      r.attempted < r.total ? h('p', { class: 'muted small' }, `${plural(r.total - r.attempted, 'question')} left unanswered (scored as incorrect).`) : null));

  const actions = h('div', { class: 'btn-row wrap' },
    h('a', { class: 'btn primary grow', href: `${base}/review/${s.id}` }, icon('eye', 18), 'Review all'),
    missed.length ? h('a', { class: 'btn grow', href: `${base}/review/${s.id}?f=missed` }, `Missed (${missed.length})`) : null,
    missed.length ? h('button', {
      type: 'button', class: 'btn grow',
      onclick: () => openStartSheet(pack, { title: 'Retake: missed questions', keys: missed, minutes: Math.max(1, Math.round(missed.length * ratio)) }),
    }, icon('refresh', 18), 'Retake missed') : null);

  const domainRows = pack.domains.map((d) => {
    const e = r.byDomain?.[d.id] ?? { c: 0, w: 0, u: 0 };
    const t = e.c + e.w + e.u;
    const p = t ? Math.round((e.c / t) * 100) : 0;
    return h('div', { class: 'dom-row' },
      h('div', { class: 'dom-head' }, h('span', null, d.name), h('b', null, t ? `${e.c}/${t}` : '–')),
      h('div', { class: 'meter' }, h('span', { class: p >= 80 ? 'good' : p >= 70 ? 'ok' : 'low', style: { width: `${p}%` } })),
      h('span', { class: 'muted small' }, `Exam weight ${d.weight ?? ''}`.trim()));
  });

  const study = Object.entries(r.bySection ?? {})
    .map(([sid, e]) => ({ sid, miss: e.w + e.u, total: e.c + e.w + e.u, section: sections.get(sid) }))
    .filter((x) => x.miss > 0 && x.section)
    .sort((a, b) => b.miss - a.miss || a.section.title.localeCompare(b.section.title))
    .slice(0, 6);

  const dots = h('div', { class: 'qgrid compact' }, ...s.keys.map((k, i) => h('a', {
    class: ['qdot', `s-${r.perQuestion[k] ?? 'u'}`], href: `${base}/review/${s.id}?n=${i}`,
    'aria-label': `Question ${i + 1}, ${r.perQuestion[k] === 'c' ? 'correct' : r.perQuestion[k] === 'w' ? 'incorrect' : 'not answered'}`,
  }, String(i + 1))));

  const el = h('div', { class: 'page' },
    hero,
    actions,
    h('section', { class: 'card' }, h('h3', null, 'By domain'), ...domainRows),
    study.length ? h('section', { class: 'card' }, h('h3', null, 'Study next'),
      h('p', { class: 'muted small' }, 'Guide sections where you lost the most points.'),
      h('div', { class: 'list flush' }, ...study.map((x) => row({ href: x.section.href, title: x.section.title, sub: `${x.miss} of ${x.total} missed` })))) : null,
    h('section', { class: 'card' }, h('h3', null, 'All questions'), dots,
      h('div', { class: 'legend' }, h('span', null, h('i', { class: 'qdot s-c mini' }), 'Correct'), h('span', null, h('i', { class: 'qdot s-w mini' }), 'Incorrect'), h('span', null, h('i', { class: 'qdot s-u mini' }), 'Not answered'))),
    h('button', {
      type: 'button', class: 'link-btn danger-text',
      onclick: async () => {
        if (await confirmSheet({ title: 'Delete this attempt?', message: 'It is removed from your history. Per-question statistics are kept.', confirmLabel: 'Delete', danger: true })) {
          data.deleteSession(pack.id, s.id);
          go(`/c/${pack.id}/practice`);
        }
      },
    }, icon('trash', 16), 'Delete this attempt'));
  return { el, title: 'Results', subtitle: s.title, back: `${base}/practice`, tabs: { pack: pack.id, active: 'practice' } };
}
