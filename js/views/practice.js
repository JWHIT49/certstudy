import { h, icon, fmtDateTime, plural } from '../dom.js';
import { getPack, getQuestionMap, getExam } from '../content.js';
import * as data from '../data.js';
import { createSession, pickDrillKeys } from '../session.js';
import { go } from '../router.js';
import { openSheet, confirmSheet, segmented, switchRow, row, toast } from '../ui.js';

/** Bottom sheet that lets the learner choose Study/Exam mode, then creates and opens the session. */
export function openStartSheet(pack, { title, keys, minutes = null, examId = null, defaultMode = 'study' }) {
  const settings = data.getSettings();
  const state = { mode: defaultMode, shuffle: settings.shuffleOptions, auto: settings.autoCheck };
  const clockMinutes = minutes ?? Math.max(1, Math.round(keys.length * 1.67));
  const desc = h('p', { class: 'muted small' });
  const autoRow = switchRow({
    title: 'Instant feedback', description: 'Reveal the answer and explanation as soon as an answer is complete.',
    checked: state.auto, onChange: (v) => { state.auto = v; },
  });
  const paint = () => {
    desc.textContent = state.mode === 'exam'
      ? `Timed: ${clockMinutes} minutes. No feedback until you finish, like the real exam. The clock only runs while the app is open.`
      : 'Tap "Check answer" when you are ready and read the explanation straight away. No time limit.';
    autoRow.hidden = state.mode === 'exam';
  };
  const content = h('div', { class: 'stack-sm' },
    h('p', { class: 'muted' }, plural(keys.length, 'question')),
    segmented({ label: 'Mode', options: [{ value: 'study', label: 'Study' }, { value: 'exam', label: 'Exam' }], value: state.mode, onChange: (v) => { state.mode = v; paint(); } }),
    desc,
    autoRow,
    switchRow({ title: 'Shuffle answer options', checked: state.shuffle, onChange: (v) => { state.shuffle = v; } }));
  paint();

  async function start() {
    if (data.getActive(pack.id)) {
      const ok = await confirmSheet({
        title: 'Replace the session in progress?', message: 'You have a practice session in progress. Starting a new one discards it.',
        confirmLabel: 'Discard and start', cancelLabel: 'Cancel', danger: true,
      });
      if (!ok) return;
    }
    data.saveActive(createSession({ packId: pack.id, title, keys, mode: state.mode, shuffle: state.shuffle, autoCheck: state.auto, minutes: clockMinutes, examId }));
    ref.close();
    go(`/c/${pack.id}/run`);
  }
  const ref = openSheet({ title, content, actions: [h('button', { type: 'button', class: 'btn primary grow', onclick: start }, icon('play', 18), 'Start')] });
}

const pctPill = (p) => h('span', { class: ['score-pill', p >= 80 ? 'good' : p >= 70 ? 'ok' : 'low'] }, String(p));

export async function practiceView({ params }) {
  const pack = await getPack(params.pack);
  const history = data.getHistory(pack.id);
  const active = data.getActive(pack.id);
  const stats = data.getQStats(pack.id);
  const ratio = (pack.exams[0]?.minutes ?? 100) / (pack.exams[0]?.questions ?? 60);
  const el = h('div', { class: 'page' });

  if (active) {
    const answered = Object.keys(active.answers ?? {}).length;
    el.append(h('section', { class: 'card resume-card' },
      h('div', { class: 'resume-text' }, h('b', null, 'Session in progress'), h('span', null, `${active.title} · ${active.mode === 'exam' ? 'Exam' : 'Study'} mode · ${answered} of ${active.keys.length} answered`)),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn primary grow', href: `#/c/${pack.id}/run` }, icon('play', 18), 'Resume'),
        h('button', {
          type: 'button', class: 'btn ghost',
          onclick: async () => {
            if (await confirmSheet({ title: 'Discard this session?', message: 'Your answers in this session will be lost.', confirmLabel: 'Discard', danger: true })) {
              data.clearActive(pack.id);
              go(`/c/${pack.id}/practice`);
            }
          },
        }, 'Discard'))));
  }

  el.append(h('h2', { class: 'section-title' }, 'Practice exams'));
  for (const meta of pack.exams) {
    const attempts = history.filter((x) => x.examId === meta.id);
    const best = attempts.length ? Math.max(...attempts.map((a) => a.pct)) : null;
    el.append(h('section', { class: 'card exam-card' },
      h('div', { class: 'exam-head' }, h('h3', null, meta.title), h('span', { class: 'muted small' }, `${meta.questions} questions · ${meta.minutes} min`)),
      meta.description ? h('p', { class: 'muted' }, meta.description) : null,
      h('p', { class: 'small muted' }, attempts.length ? `${plural(attempts.length, 'attempt')} · best ${best}% · last ${attempts[0].pct}%` : 'Not attempted yet'),
      h('button', {
        type: 'button', class: 'btn primary block',
        onclick: async () => {
          const exam = await getExam(pack, meta.id);
          openStartSheet(pack, { title: meta.title, keys: exam.questions.map((q) => q.key), minutes: meta.minutes, examId: meta.id });
        },
      }, icon('play', 18), attempts.length ? 'Start again' : 'Start')));
  }

  // quick drill
  const missedCount = Object.values(stats).filter((s) => s.last === 0).length;
  const drill = { domains: new Set(), count: 10, source: 'all' };
  const chips = pack.domains.map((d) => {
    const chip = h('button', {
      type: 'button', class: 'chip-btn', 'aria-pressed': 'false',
      onclick: () => {
        if (drill.domains.has(d.id)) drill.domains.delete(d.id); else drill.domains.add(d.id);
        chip.classList.toggle('on', drill.domains.has(d.id));
        chip.setAttribute('aria-pressed', String(drill.domains.has(d.id)));
      },
    }, d.short ?? d.name);
    return chip;
  });
  el.append(h('section', { class: 'card' },
    h('h3', null, 'Quick drill'),
    h('p', { class: 'muted small' }, 'A short set from any area. Leave the domains empty to include everything.'),
    h('div', { class: 'chips' }, ...chips),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Questions'),
      segmented({ label: 'Number of questions', options: [10, 20, 30].map((n) => ({ value: n, label: String(n) })), value: 10, onChange: (v) => { drill.count = v; } })),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'From'),
      segmented({ label: 'Question source', options: [{ value: 'all', label: 'All' }, { value: 'missed', label: `Missed (${missedCount})` }, { value: 'new', label: 'Unseen' }], value: 'all', onChange: (v) => { drill.source = v; } })),
    h('button', {
      type: 'button', class: 'btn primary block',
      onclick: async () => {
        const { qmap } = await getQuestionMap(pack);
        const keys = pickDrillKeys({ qmap, stats, domains: [...drill.domains], source: drill.source, count: drill.count });
        if (!keys.length) { toast('No questions match those filters yet.'); return; }
        openStartSheet(pack, { title: 'Quick drill', keys, minutes: Math.max(1, Math.round(keys.length * ratio)) });
      },
    }, icon('bolt', 18), 'Start drill')));

  el.append(h('section', { class: 'card' },
    h('h3', null, 'Recent attempts'),
    history.length
      ? h('div', { class: 'list flush' }, ...history.slice(0, 12).map((x) => row({
        href: `#/c/${pack.id}/results/${x.id}`, leading: pctPill(x.pct), title: x.title,
        sub: `${x.mode === 'exam' ? 'Exam mode' : 'Study mode'} · ${x.correct}/${x.total} correct · ${fmtDateTime(x.endedAt)}`,
      })))
      : h('p', { class: 'muted' }, 'Finish a practice session and your scores will appear here.')));

  return { el, title: 'Practice', subtitle: pack.code, back: '#/', tabs: { pack: pack.id, active: 'practice' }, actions: [{ icon: 'search', label: 'Search', href: `#/c/${pack.id}/search` }] };
}
