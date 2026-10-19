// The practice runner: study mode (check + explain on demand), exam mode (timed, no feedback), and read-only review.
import { h, icon, fmtClock, clamp } from '../dom.js';
import * as data from '../data.js';
import * as G from '../grade.js';
import { sanitizeHtml } from '../sanitize.js';
import { getPack, getQuestionMap, getExam, getSectionMap, examIdsOf, NotFoundError } from '../content.js';
import { go } from '../router.js';
import { openSheet, confirmSheet, closeAllSheets, toast } from '../ui.js';
import { renderQuestion } from './question.js';

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function runView({ params }) {
  const pack = await getPack(params.pack);
  const session = data.getActive(pack.id);
  if (!session) return { redirect: `/c/${pack.id}/practice` };
  const { exams, qmap } = await getQuestionMap(pack, examIdsOf(session.keys));
  session.keys = session.keys.filter((k) => qmap.has(k));
  if (!session.keys.length) {
    data.clearActive(pack.id);
    return { redirect: `/c/${pack.id}/practice` };
  }
  const sections = await getSectionMap(pack);
  return buildRunner({ pack, session, qmap, exams, sections, readOnly: false });
}

export async function reviewView({ params, query }) {
  const pack = await getPack(params.pack);
  const stored = data.getSession(params.sid);
  if (!stored) throw new NotFoundError('That attempt is no longer stored on this device.');
  const { exams, qmap } = await getQuestionMap(pack, examIdsOf(stored.keys));
  let keys = stored.keys.filter((k) => qmap.has(k));
  const filter = query.f === 'missed' ? 'missed' : null;
  if (filter) keys = keys.filter((k) => stored.result?.perQuestion?.[k] !== 'c');
  if (!keys.length) return { redirect: `/c/${pack.id}/results/${stored.id}` };
  const sections = await getSectionMap(pack);
  return buildRunner({
    pack, session: { ...stored, keys }, qmap, exams, sections, readOnly: true, filter,
    startIndex: clamp(Number.parseInt(query.n ?? '0', 10) || 0, 0, keys.length - 1),
  });
}

/** A single question with its answer and explanation (opened from search). */
export async function questionView({ params }) {
  const pack = await getPack(params.pack);
  const exam = await getExam(pack, params.examId);
  const q = exam.questions.find((x) => x.id === params.qid);
  if (!q) throw new NotFoundError('That question does not exist.');
  const sections = await getSectionMap(pack);
  const cs = q.caseStudy ? exam.caseStudies?.find((c) => c.id === q.caseStudy) : null;
  const domain = pack.domains.find((d) => d.id === q.domain);
  const card = renderQuestion(q, {
    seed: 1, shuffle: false, answer: G.correctAnswer(q), locked: true, feedback: true, outcome: 'view',
    meta: `${domain?.short ?? domain?.name ?? `Domain ${q.domain}`}${q.skill ? ` · Skill ${q.skill}` : ''}`,
    caseStudy: cs ? { title: cs.title, onOpen: () => openCaseStudy(cs) } : null,
    guideLink: sections.get(q.section) ?? null,
  });
  return {
    el: h('div', { class: 'page' }, card), title: `Question ${q.number}`, subtitle: exam.title, back: `#/c/${pack.id}/search`,
  };
}

function openCaseStudy(cs) {
  return openSheet({ title: cs.title, tall: true, content: h('div', { class: 'prose case-body' }, sanitizeHtml(cs.html)) });
}

function buildRunner({ pack, session, qmap, exams, sections, readOnly, startIndex = null, filter = null }) {
  const keys = session.keys;
  const examMode = session.mode === 'exam';
  let idx = clamp(startIndex ?? session.idx ?? 0, 0, keys.length - 1);
  let done = false;
  let finishing = false;
  let timeUp = false;
  // Start of the current stretch the page has been visible (null while hidden). Only visible time counts against the clock.
  let visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
  let lastSave = Date.now();
  const domainOf = (id) => pack.domains.find((d) => d.id === id);

  const progressFill = h('span');
  const scroll = h('div', { class: 'run-scroll', tabindex: '-1' });
  const bar = h('div', { class: 'run-bar' });
  const root = h('div', { class: 'runner' }, h('div', { class: 'run-progress', 'aria-hidden': 'true' }, progressFill), scroll, bar);
  const position = h('div', { class: 'top-main' });
  const subtitle = h('div', { class: 'top-sub' });
  const clock = readOnly ? null : h('span', { class: 'clock', 'aria-live': 'off' });

  // ---------------------------------------------------------------- persistence + timer
  const persist = () => { if (!readOnly && !done) { session.idx = idx; data.saveActive(session); } };

  // Adds the visible time since the last call. Works for the 1 s interval and for visibilitychange, where the state has already flipped.
  function accrue(now) {
    if (visibleSince !== null) session.activeMs += now - visibleSince;
    visibleSince = document.visibilityState === 'visible' ? now : null;
  }

  function tick() {
    if (readOnly || done) return;
    const now = Date.now();
    accrue(now);
    updateClock();
    if (session.limitMs && session.activeMs >= session.limitMs && !timeUp) {
      timeUp = true;
      toast("Time's up. Scoring your exam.");
      finish();
      return;
    }
    if (now - lastSave > 5000) { persist(); lastSave = now; }
  }

  function updateClock() {
    if (!clock) return;
    if (session.limitMs) {
      const left = Math.max(0, session.limitMs - session.activeMs) / 1000;
      clock.textContent = fmtClock(left);
      clock.classList.toggle('low', left < 300);
    } else {
      clock.textContent = fmtClock(session.activeMs / 1000);
    }
  }

  const timer = readOnly ? null : setInterval(tick, 1000);
  const onVisibility = () => {
    tick();
    if (document.visibilityState === 'hidden') persist();
  };
  if (!readOnly) document.addEventListener('visibilitychange', onVisibility);

  // ---------------------------------------------------------------- answering
  const currentKey = () => keys[idx];
  const answerOf = (key) => G.normalizeAnswer(qmap.get(key), session.answers[key]);
  const isChecked = (key) => Boolean(session.checked?.[key]);

  function setAnswer(key, next) {
    if (readOnly) return;
    const q = qmap.get(key);
    session.answers[key] = G.normalizeAnswer(q, next);
    let revealedNow = false;
    if (!examMode && session.autoCheck && G.answerState(q, session.answers[key]) === 'complete') {
      session.checked[key] = true;
      revealedNow = true;
    }
    persist();
    show({ keepScroll: true, focusFeedback: revealedNow });
  }

  function check(key) {
    const q = qmap.get(key);
    if (G.answerState(q, session.answers[key]) !== 'complete') return;
    session.checked[key] = true;
    persist();
    show({ keepScroll: true, focusFeedback: true });
  }

  function reveal(key) {
    session.checked[key] = true;
    session.revealed[key] = true;
    persist();
    show({ keepScroll: true, focusFeedback: true });
  }

  function resetQuestion(key) {
    delete session.answers[key];
    delete session.checked[key];
    delete session.revealed[key];
    persist();
    show();
  }

  function toggleFlag(key) {
    session.flags[key] = !session.flags[key];
    if (!session.flags[key]) delete session.flags[key];
    persist();
    show({ keepScroll: true });
  }

  // ---------------------------------------------------------------- rendering
  function outcomeOf(key, feedback) {
    const revealed = Boolean(session.revealed?.[key]);
    if (readOnly) {
      const r = session.result?.perQuestion?.[key];
      return r === 'c' ? 'correct' : revealed ? 'revealed' : r === 'w' ? 'wrong' : 'unanswered';
    }
    if (!feedback) return 'view';
    return revealed ? 'revealed' : G.isCorrect(qmap.get(key), answerOf(key)) ? 'correct' : 'wrong';
  }

  function show({ keepScroll = false, focusFeedback = false } = {}) {
    const key = currentKey();
    const q = qmap.get(key);
    const checked = isChecked(key);
    const locked = readOnly || (!examMode && checked);
    const feedback = readOnly || (!examMode && checked);
    const exam = exams.get(q.examId);
    const cs = q.caseStudy ? exam?.caseStudies?.find((c) => c.id === q.caseStudy) : null;
    const domain = domainOf(q.domain);
    const card = renderQuestion(q, {
      seed: session.seed, shuffle: session.shuffle, answer: answerOf(key), locked, feedback, outcome: outcomeOf(key, feedback),
      meta: examMode && !readOnly ? null : `${domain?.short ?? domain?.name ?? `Domain ${q.domain}`}${q.skill ? ` · Skill ${q.skill}` : ''}`,
      flagged: Boolean(session.flags?.[key]), onFlag: readOnly ? null : () => toggleFlag(key),
      onChange: (next) => setAnswer(key, next), onNotice: (m) => toast(m),
      onReveal: !readOnly && !examMode && !checked ? () => reveal(key) : null,
      onReset: !readOnly && !examMode && checked ? () => resetQuestion(key) : null,
      caseStudy: cs ? { title: cs.title, onOpen: () => openCaseStudy(cs) } : null,
      guideLink: sections.get(q.section) ?? null,
    });
    const label = readOnly ? `Review ${idx + 1} of ${keys.length}` : `Question ${idx + 1} of ${keys.length}`;
    card.setAttribute('tabindex', '-1');
    card.setAttribute('aria-label', label);
    const controls = () => [...scroll.querySelectorAll('button:not([disabled])')];
    const focusPos = scroll.contains(document.activeElement) ? controls().indexOf(document.activeElement) : -1;
    const previous = scroll.scrollTop;
    scroll.replaceChildren(card);
    scroll.scrollTop = keepScroll ? previous : 0;
    if (focusFeedback) {
      const fb = scroll.querySelector('.feedback');
      if (fb) {
        const top = fb.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - scroll.clientHeight * 0.3;
        scroll.scrollTo({ top: Math.max(0, top), behavior: reduceMotion() ? 'auto' : 'smooth' });
        fb.focus({ preventScroll: true });
      }
    } else if (keepScroll && focusPos >= 0) {
      controls()[focusPos]?.focus({ preventScroll: true }); // the control that was just used was rebuilt; keep the user's place
    } else if (!keepScroll && document.contains(scroll)) {
      card.focus({ preventScroll: true }); // a new question: screen readers start at its heading
    }
    position.textContent = label;
    subtitle.textContent = readOnly ? (filter === 'missed' ? 'Missed questions' : session.title) : examMode ? 'Exam mode' : 'Study mode';
    progressFill.style.width = `${((idx + 1) / keys.length) * 100}%`;
    renderBar();
    updateClock();
  }

  function renderBar() {
    const key = currentKey();
    const q = qmap.get(key);
    const last = idx === keys.length - 1;
    const state = G.answerState(q, session.answers[key]);
    const prev = h('button', { type: 'button', class: 'btn icon', 'aria-label': 'Previous question', disabled: idx === 0, onclick: () => goTo(idx - 1) }, icon('chevron-left', 22));
    const nextLabel = (text) => h('button', { type: 'button', class: 'btn primary grow', onclick: () => goTo(idx + 1) }, text, icon('chevron-right', 18));
    let primary;
    let extra = null;
    if (readOnly) {
      primary = last
        ? h('button', { type: 'button', class: 'btn primary grow', onclick: leave }, 'Back to results')
        : nextLabel('Next');
    } else if (examMode) {
      primary = last ? h('button', { type: 'button', class: 'btn primary grow', onclick: askFinish }, 'Finish exam') : nextLabel('Next');
    } else if (!isChecked(key)) {
      primary = h('button', { type: 'button', class: 'btn primary grow', disabled: state !== 'complete', onclick: () => check(key) }, 'Check answer');
      extra = last
        ? h('button', { type: 'button', class: 'btn ghost', onclick: askFinish }, 'Finish')
        : h('button', { type: 'button', class: 'btn icon', 'aria-label': 'Skip to next question', onclick: () => goTo(idx + 1) }, icon('chevron-right', 22));
    } else {
      primary = last ? h('button', { type: 'button', class: 'btn primary grow', onclick: askFinish }, 'Finish') : nextLabel('Next');
    }
    bar.replaceChildren(...[prev, primary, extra].filter(Boolean));
  }

  function goTo(i) {
    if (i < 0 || i >= keys.length) { if (i >= keys.length && !readOnly) askFinish(); return; }
    idx = i;
    persist();
    show();
  }

  // ---------------------------------------------------------------- question list, finish, leave
  function statusOf(key) {
    if (readOnly) return session.result?.perQuestion?.[key] ?? 'u';
    const q = qmap.get(key);
    const state = G.answerState(q, session.answers[key]);
    if (!examMode && isChecked(key)) return session.revealed?.[key] ? 'w' : G.isCorrect(q, answerOf(key)) ? 'c' : 'w';
    return state === 'complete' ? 'a' : state === 'partial' ? 'p' : 'u';
  }

  const STATUS_LABEL = { c: 'correct', w: 'incorrect', a: 'answered', p: 'partly answered', u: 'not answered' };

  function openGrid() {
    const statuses = keys.map(statusOf);
    const flagged = keys.filter((k) => session.flags?.[k]).length;
    const unanswered = statuses.filter((s) => s === 'u').length;
    let sheet;
    const grid = h('div', { class: 'qgrid' }, ...keys.map((k, i) => h('button', {
      type: 'button', class: ['qdot', `s-${statuses[i]}`, i === idx && 'current', session.flags?.[k] && 'flagged'],
      'aria-label': `Question ${i + 1}, ${STATUS_LABEL[statuses[i]]}${session.flags?.[k] ? ', flagged' : ''}`,
      onclick: () => { sheet.close(); goTo(i); },
    }, String(i + 1))));
    const legend = readOnly
      ? [['c', 'Correct'], ['w', 'Incorrect'], ['u', 'Not answered']]
      : examMode ? [['a', 'Answered'], ['p', 'Partly'], ['u', 'Unanswered']] : [['c', 'Correct'], ['w', 'Incorrect'], ['a', 'Answered'], ['u', 'Unanswered']];
    const content = h('div', null,
      readOnly ? null : h('p', { class: 'muted small' }, `${keys.length - unanswered} answered · ${unanswered} unanswered${flagged ? ` · ${flagged} flagged` : ''}`),
      grid,
      h('div', { class: 'legend' }, ...legend.map(([s, label]) => h('span', null, h('i', { class: `qdot s-${s} mini` }), label)), flagged ? h('span', null, h('i', { class: 'qdot mini flagged s-u' }), 'Flagged') : null));
    sheet = openSheet({
      title: readOnly ? 'Jump to question' : 'Questions', content, tall: keys.length > 30,
      actions: readOnly ? null : [h('button', { type: 'button', class: 'btn primary grow', onclick: () => { sheet.close(); askFinish(); } }, examMode ? 'Finish exam' : 'Finish and score')],
    });
  }

  async function askFinish() {
    const unanswered = keys.filter((k) => G.answerState(qmap.get(k), session.answers[k]) === 'empty').length;
    const flagged = keys.filter((k) => session.flags?.[k]).length;
    const bits = [unanswered ? `${unanswered} unanswered (these score as incorrect)` : null, flagged ? `${flagged} flagged` : null].filter(Boolean);
    const ok = await confirmSheet({
      title: examMode ? 'Finish exam?' : 'Finish practice?',
      message: `${bits.length ? `${bits.join(' · ')}. ` : 'Every question has an answer. '}You cannot change answers after you finish.`,
      confirmLabel: 'Finish and score', cancelLabel: 'Keep going',
    });
    if (ok) finish();
  }

  function finish() {
    if (done || finishing) return;
    finishing = true; // tick() below can hit the time limit and call finish() again
    tick();
    done = true;
    closeAllSheets();
    session.idx = idx;
    const result = G.gradeSession(session, qmap);
    const finished = data.recordFinished(session, result);
    go(`/c/${pack.id}/results/${finished.id}`);
  }

  function leave() {
    if (readOnly) { go(`/c/${pack.id}/results/${session.id}`); return; }
    tick();
    persist();
    toast('Progress saved');
    go(`/c/${pack.id}/practice`);
  }

  // ---------------------------------------------------------------- keyboard (desktop)
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.sheet')) return;
    const key = currentKey();
    const q = qmap.get(key);
    if (e.key === 'ArrowRight') { goTo(idx + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { goTo(idx - 1); e.preventDefault(); }
    else if (e.key === 'Enter' && !readOnly && !examMode && !isChecked(key) && G.answerState(q, session.answers[key]) === 'complete') { check(key); e.preventDefault(); }
    else if ((e.key === 'f' || e.key === 'F') && !readOnly) toggleFlag(key);
    else if (!readOnly && (q.type === 'single' || q.type === 'multi') && !(!examMode && isChecked(key))) {
      const pos = G.LETTERS.indexOf(e.key.toUpperCase());
      const n = /^[1-8]$/.test(e.key) ? Number(e.key) - 1 : pos;
      const order = G.optionOrder(q, session.seed, session.shuffle);
      if (n >= 0 && n < order.length && e.key.length === 1) {
        const orig = order[n];
        if (q.type === 'single') setAnswer(key, orig);
        else {
          const cur = new Set(answerOf(key));
          if (cur.has(orig)) cur.delete(orig); else if (cur.size < G.selectCount(q)) cur.add(orig); else return;
          setAnswer(key, [...cur].sort((a, b) => a - b));
        }
      }
    }
  };
  document.addEventListener('keydown', onKey);

  const topEl = h('div', { class: 'top-row' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': readOnly ? 'Back to results' : 'Leave practice (progress is saved)', onclick: leave }, icon('chevron-left', 26)),
    h('div', { class: 'top-title' }, position, subtitle),
    h('div', { class: 'top-actions' }, clock, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Question list', onclick: openGrid }, icon('grid', 22))));

  show();
  return {
    el: root, topEl, fill: true, title: readOnly ? 'Review' : 'Practice',
    onLeave: () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      if (!readOnly && !done) { tick(); persist(); }
    },
  };
}
