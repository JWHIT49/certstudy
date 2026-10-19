// Renders one question card for the runner, the review screen and the single-question viewer.
// It is stateless: the caller passes the current answer and callbacks and re-renders on every change.
import { h, icon } from '../dom.js';
import { sanitizeHtml } from '../sanitize.js';
import * as G from '../grade.js';

export function typeLabel(q) {
  switch (q.type) {
    case 'single': return 'Select one';
    case 'multi': return `Select ${G.selectCount(q)}`;
    case 'yesno': return 'Yes or No for each statement';
    case 'order': return 'Arrange in the correct order';
    case 'dropdown': return q.format === 'code' ? 'Complete the code' : 'Choose for each blank';
    default: return '';
  }
}

export function refLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'learn.microsoft.com' ? 'Microsoft Learn' : host;
  } catch {
    return 'Reference';
  }
}

const STATE_TEXT = { correct: 'Correct answer', wrong: 'Your answer is incorrect', missed: 'Correct answer you did not select' };

function optionButton({ role, letter, content, selected, state, locked, onClick, note = null, badge = false }) {
  return h('button', {
    type: 'button', role, class: ['opt', selected && 'selected', state && `is-${state}`, badge && 'order-item'],
    'aria-checked': String(selected), 'aria-disabled': locked ? 'true' : null,
    onclick: () => { if (!locked) onClick(); },
  },
  h('span', { class: ['opt-letter', badge && 'order-badge'] }, letter),
  h('span', { class: 'opt-text' }, content, state ? h('span', { class: 'sr' }, ` (${STATE_TEXT[state]})`) : null),
  note ? h('span', { class: 'opt-note' }, note) : null,
  state ? h('span', { class: 'opt-mark', 'aria-hidden': 'true' }, icon(state === 'wrong' ? 'x' : 'check', 18)) : null);
}

// ---------------------------------------------------------------- bodies, one per question type
function singleBody(q, c) {
  const order = G.optionOrder(q, c.seed, c.shuffle);
  return h('div', { class: 'opts', role: 'radiogroup', 'aria-label': 'Answer options' }, ...order.map((orig, pos) => {
    const selected = c.answer === orig;
    const correct = q.answer.includes(orig);
    const state = c.feedback ? (correct ? 'correct' : selected ? 'wrong' : null) : null;
    return optionButton({ role: 'radio', letter: G.LETTERS[pos], content: sanitizeHtml(q.options[orig]), selected, state, locked: c.locked, onClick: () => c.onChange(orig) });
  }));
}

function multiBody(q, c) {
  const order = G.optionOrder(q, c.seed, c.shuffle);
  const need = G.selectCount(q);
  const chosen = new Set(c.answer);
  const toggle = (orig) => {
    const next = new Set(chosen);
    if (next.has(orig)) next.delete(orig);
    else if (next.size >= need) { c.onNotice?.(`Choose exactly ${need}. Deselect one first.`); return; }
    else next.add(orig);
    c.onChange([...next].sort((a, b) => a - b));
  };
  return h('div', null,
    h('div', { class: 'hint', 'aria-live': 'polite' }, `${chosen.size} of ${need} selected`),
    h('div', { class: 'opts', role: 'group', 'aria-label': `Choose ${need} answers` }, ...order.map((orig, pos) => {
      const selected = chosen.has(orig);
      const correct = q.answer.includes(orig);
      let state = null;
      if (c.feedback) state = selected ? (correct ? 'correct' : 'wrong') : (correct ? 'missed' : null);
      return optionButton({ role: 'checkbox', letter: G.LETTERS[pos], content: sanitizeHtml(q.options[orig]), selected, state, locked: c.locked, onClick: () => toggle(orig) });
    })));
}

function yesNoBody(q, c) {
  return h('div', { class: 'yn' }, ...q.statements.map((s, i) => {
    const mine = c.answer[i];
    const button = (val, label) => {
      const selected = mine === val;
      const right = s.answer === val;
      const state = c.feedback ? (right ? 'correct' : selected ? 'wrong' : null) : null;
      return h('button', {
        type: 'button', role: 'radio', class: ['yn-btn', selected && 'selected', state && `is-${state}`],
        'aria-checked': String(selected), 'aria-disabled': c.locked ? 'true' : null,
        onclick: () => { if (c.locked) return; const next = [...c.answer]; next[i] = val; c.onChange(next); },
      }, label, state ? icon(state === 'wrong' ? 'x' : 'check', 16) : null);
    };
    return h('div', { class: 'yn-row' },
      h('div', { class: 'yn-text' }, h('span', { class: 'yn-num' }, String(i + 1)), h('span', null, sanitizeHtml(s.text))),
      h('div', { class: 'yn-btns', role: 'radiogroup', 'aria-label': `Statement ${i + 1}` }, button(true, 'Yes'), button(false, 'No')));
  }));
}

function orderBody(q, c) {
  const display = G.itemOrder(q, c.seed);
  const chosen = c.answer;
  const rows = display.map((orig) => {
    const pos = chosen.indexOf(orig);
    const isChosen = pos >= 0;
    const ok = isChosen && pos === orig;
    const state = c.feedback ? (ok ? 'correct' : isChosen ? 'wrong' : 'missed') : null;
    return optionButton({
      role: 'checkbox', badge: true, letter: isChosen ? String(pos + 1) : '', content: sanitizeHtml(q.items[orig]),
      selected: isChosen, state, locked: c.locked, note: c.feedback && !ok ? `Step ${orig + 1}` : null,
      onClick: () => c.onChange(isChosen ? chosen.filter((i) => i !== orig) : [...chosen, orig]),
    });
  });
  return h('div', null,
    h('div', { class: 'hint' }, 'Tap the steps in the order they should happen. Tap a numbered step to remove it.'),
    h('div', { class: 'opts', role: 'group', 'aria-label': 'Steps' }, ...rows),
    !c.locked && chosen.length ? h('button', { type: 'button', class: 'link-btn', onclick: () => c.onChange([]) }, icon('undo', 16), 'Reset order') : null);
}

function fillPlaceholders(root, makePill) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\{\d+\}/.test(n.data)) nodes.push(n);
  for (const node of nodes) {
    const parts = node.data.split(/(\{\d+\})/).filter(Boolean).map((part) => {
      const m = /^\{(\d+)\}$/.exec(part);
      return m ? makePill(Number(m[1]) - 1) : document.createTextNode(part);
    });
    node.replaceWith(...parts);
  }
}

function dropdownBody(q, c) {
  const pill = (i) => {
    const b = q.blanks[i];
    if (!b) return document.createTextNode('');
    const sel = c.answer[i];
    const state = c.feedback ? (sel === b.answer ? 'correct' : sel !== null ? 'wrong' : 'missed') : null;
    return h('span', { class: ['blank-pill', sel !== null && 'filled', state && `is-${state}`] }, sel !== null ? b.options[sel] : `[ ${i + 1} ]`);
  };
  let template;
  if (q.format === 'code') {
    const code = h('code');
    q.template.split(/(\{\d+\})/).forEach((part) => {
      const m = /^\{(\d+)\}$/.exec(part);
      if (m) code.append(pill(Number(m[1]) - 1));
      else if (part) code.append(document.createTextNode(part));
    });
    template = h('pre', { class: 'code-block' }, code);
  } else {
    const frag = sanitizeHtml(q.template);
    fillPlaceholders(frag, pill);
    template = h('div', { class: 'tpl-text' }, frag);
  }
  const groups = q.blanks.map((b, i) => {
    const order = G.blankOrder(q, c.seed, c.shuffle, i);
    return h('div', { class: 'blank-group' },
      h('div', { class: 'blank-title' }, h('span', { class: 'blank-pill small' }, `[ ${i + 1} ]`), 'Choose one'),
      h('div', { class: 'opts', role: 'radiogroup', 'aria-label': `Blank ${i + 1}` }, ...order.map((orig, pos) => {
        const selected = c.answer[i] === orig;
        const correct = b.answer === orig;
        const state = c.feedback ? (correct ? 'correct' : selected ? 'wrong' : null) : null;
        return optionButton({
          role: 'radio', letter: G.LETTERS[pos], content: document.createTextNode(b.options[orig]), selected, state, locked: c.locked,
          onClick: () => { const next = [...c.answer]; next[i] = orig; c.onChange(next); },
        });
      })));
  });
  return h('div', null, template, ...groups);
}

const BODIES = { single: singleBody, multi: multiBody, yesno: yesNoBody, order: orderBody, dropdown: dropdownBody };

// ---------------------------------------------------------------- feedback panel
function correctSummary(q, c) {
  if (q.type === 'single' || q.type === 'multi') {
    const order = G.optionOrder(q, c.seed, c.shuffle);
    const items = order.map((orig, pos) => [orig, pos]).filter(([orig]) => q.answer.includes(orig));
    return h('div', { class: 'fb-answer' }, h('h4', null, items.length > 1 ? 'Correct answers' : 'Correct answer'),
      h('ul', { class: 'ans-list' }, ...items.map(([orig, pos]) => h('li', null, h('b', null, `${G.LETTERS[pos]}. `), sanitizeHtml(q.options[orig])))));
  }
  if (q.type === 'yesno') {
    return h('div', { class: 'fb-answer' }, h('h4', null, 'Correct answers'),
      h('p', { class: 'fb-line' }, q.statements.map((s, i) => `${i + 1}: ${s.answer ? 'Yes' : 'No'}`).join('   ·   ')));
  }
  if (q.type === 'order') {
    return h('div', { class: 'fb-answer' }, h('h4', null, 'Correct order'),
      h('ol', { class: 'ans-list numbered' }, ...q.items.map((it) => h('li', null, sanitizeHtml(it)))));
  }
  return h('div', { class: 'fb-answer' }, h('h4', null, 'Correct choices'),
    h('p', { class: 'fb-line' }, q.blanks.map((b, i) => `[ ${i + 1} ] ${b.options[b.answer]}`).join('   ·   ')));
}

const OUTCOMES = {
  correct: ['check-circle', 'Correct', 'good'],
  wrong: ['x', 'Not quite', 'bad'],
  revealed: ['eye', 'Answer revealed', 'info'],
  unanswered: ['info', 'Not answered', 'info'],
  view: ['info', 'Answer and explanation', 'info'],
};

function feedbackPanel(q, c) {
  const [ic, label, tone] = OUTCOMES[c.outcome] ?? OUTCOMES.view;
  return h('section', { class: ['feedback', `tone-${tone}`], tabindex: '-1', role: 'region', 'aria-label': label },
    h('div', { class: 'fb-banner' }, icon(ic, 22), h('b', null, label)),
    correctSummary(q, c),
    h('div', { class: 'explain' }, h('h4', null, 'Explanation'), h('div', { class: 'prose' }, sanitizeHtml(q.explanation))),
    c.guideLink || q.ref ? h('div', { class: 'fb-links' },
      c.guideLink ? h('a', { class: 'chip-link', href: c.guideLink.href }, icon('book', 16), `Study guide: ${c.guideLink.title}`) : null,
      q.ref ? h('a', { class: 'chip-link', href: q.ref, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 16), refLabel(q.ref)) : null) : null,
    c.onReset ? h('button', { type: 'button', class: 'link-btn', onclick: c.onReset }, icon('undo', 16), 'Try this question again') : null);
}

/**
 * ctx: { seed, shuffle, answer, locked, feedback, outcome, meta, flagged, onFlag, onChange, onNotice, onReveal, onReset, caseStudy, guideLink }
 */
export function renderQuestion(q, ctx) {
  const meta = h('div', { class: 'qmeta' },
    h('span', { class: 'chip' }, typeLabel(q)),
    ctx.meta ? h('span', { class: 'chip soft' }, ctx.meta) : null,
    h('span', { class: 'spacer' }),
    ctx.onFlag ? h('button', {
      type: 'button', class: ['flag-btn', ctx.flagged && 'on'], 'aria-pressed': String(Boolean(ctx.flagged)),
      'aria-label': ctx.flagged ? 'Remove flag' : 'Flag for review', onclick: ctx.onFlag,
    }, icon('flag', 18), h('span', null, ctx.flagged ? 'Flagged' : 'Flag')) : null);
  const caseBtn = ctx.caseStudy ? h('button', { type: 'button', class: 'case-btn', onclick: ctx.caseStudy.onOpen },
    icon('book', 18), h('span', null, `Case study: ${ctx.caseStudy.title}`), icon('chevron-right', 18)) : null;
  return h('article', { class: 'qcard' },
    meta,
    caseBtn,
    h('div', { class: 'stem prose' }, sanitizeHtml(q.stem)),
    BODIES[q.type](q, ctx),
    ctx.onReveal && !ctx.locked ? h('div', { class: 'q-actions' }, h('button', { type: 'button', class: 'link-btn', onclick: ctx.onReveal }, icon('eye', 16), 'Show answer')) : null,
    ctx.feedback ? feedbackPanel(q, ctx) : null);
}
