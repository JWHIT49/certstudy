// Shared UI components: bottom sheets, toasts, confirm dialogs, segmented controls, switches, progress ring/meter, list rows.
import { h, icon } from './dom.js';
import * as store from './store.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function toast(message, { action = null, duration = 3500, sticky = false } = {}) {
  const root = document.getElementById('toast-root');
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  const el = h('div', { class: 'toast', role: 'status' },
    h('span', { class: 'toast-text' }, message),
    action ? h('button', { type: 'button', class: 'toast-action', onclick: () => { action.onClick(); dismiss(); } }, action.label) : null);
  root.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  if (!sticky) timer = setTimeout(dismiss, duration);
  return dismiss;
}

const openSheets = new Set();

// While a sheet is open the page behind it must not take focus or be read by assistive tech.
function setBackgroundInert(on) {
  const app = document.getElementById('app');
  if (app) app.inert = on;
}

/** Closes every open sheet (used when the view changes so a stale dialog cannot act on a page that is gone). */
export function closeAllSheets() {
  for (const ref of [...openSheets]) ref.close();
}

export function openSheet({ title, content, actions = null, tall = false, onClose = null, className = '' }) {
  const root = document.getElementById('overlay-root');
  const returnFocus = document.activeElement;
  let closed = false;
  const ref = {};
  const close = () => {
    if (closed) return;
    closed = true;
    openSheets.delete(ref);
    if (!openSheets.size) setBackgroundInert(false);
    document.removeEventListener('keydown', onKey);
    backdrop.classList.remove('show');
    sheet.classList.remove('show');
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 220);
    if (returnFocus && returnFocus.focus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const backdrop = h('div', { class: 'backdrop', onclick: close });
  const sheet = h('div', { class: ['sheet', tall && 'tall', className], role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    h('div', { class: 'sheet-head' },
      h('h2', null, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x', 22))),
    h('div', { class: 'sheet-body' }, content),
    actions ? h('div', { class: 'sheet-actions' }, ...actions) : null);
  root.append(backdrop, sheet);
  document.addEventListener('keydown', onKey);
  Object.assign(ref, { close, el: sheet });
  openSheets.add(ref);
  setBackgroundInert(true);
  requestAnimationFrame(() => { backdrop.classList.add('show'); sheet.classList.add('show'); sheet.focus({ preventScroll: true }); });
  return ref;
}

export function confirmSheet({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, extra = null }) {
  return new Promise((resolve) => {
    let decided = false;
    const finish = (value) => {
      if (decided) return;
      decided = true;
      resolve(value);
      ref.close();
    };
    const ref = openSheet({
      title,
      content: [h('p', { class: 'sheet-text' }, message), extra],
      actions: [
        h('button', { type: 'button', class: 'btn ghost', onclick: () => finish(false) }, cancelLabel),
        h('button', { type: 'button', class: ['btn', danger ? 'danger' : 'primary'], onclick: () => finish(true) }, confirmLabel),
      ],
      onClose: () => { if (!decided) { decided = true; resolve(false); } },
    });
  });
}

export function segmented({ options, value, onChange, label = '' }) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((o) => h('button', {
    type: 'button', role: 'radio', class: ['seg-btn', o.value === value && 'on'], 'aria-checked': String(o.value === value),
    onclick: () => select(o.value),
  }, o.label));
  function select(v) {
    buttons.forEach((b, i) => {
      const on = options[i].value === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    onChange(v);
  }
  wrap.append(...buttons);
  return wrap;
}

export function switchRow({ title, description = '', checked, onChange }) {
  const sw = h('span', { class: ['switch', checked && 'on'], 'aria-hidden': 'true' }, h('span', { class: 'knob' }));
  const row = h('button', {
    type: 'button', class: 'row switch-row', role: 'switch', 'aria-checked': String(checked),
    onclick: () => {
      checked = !checked;
      sw.classList.toggle('on', checked);
      row.setAttribute('aria-checked', String(checked));
      onChange(checked);
    },
  }, h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, title), description ? h('span', { class: 'row-sub' }, description) : null), sw);
  return row;
}

export function row({ href, onClick, leading, title, sub, trailing, chevron = true, className = '' }) {
  const tag = href ? 'a' : onClick ? 'button' : 'div';
  const interactive = tag !== 'div';
  return h(tag, { class: ['row', className], href, onclick: onClick, type: tag === 'button' ? 'button' : null },
    leading ? h('span', { class: 'row-lead' }, leading) : null,
    h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, title), sub ? h('span', { class: 'row-sub' }, sub) : null),
    trailing ?? null,
    interactive && chevron ? icon('chevron-right', 18, 'row-chevron') : null);
}

export function meter(value, max, { label = '' } = {}) {
  const percent = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return h('div', { class: 'meter', role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value },
    h('span', { style: { width: `${percent}%` } }));
}

export function ring(percent, { size = 132, stroke = 12, sub = null } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const mk = (cls, dash) => {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(size / 2));
    circle.setAttribute('cy', String(size / 2));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke-width', String(stroke));
    circle.setAttribute('class', cls);
    if (dash) {
      circle.setAttribute('stroke-dasharray', `${(c * Math.min(100, percent)) / 100} ${c}`);
      circle.setAttribute('stroke-linecap', 'round');
      circle.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    }
    return circle;
  };
  svg.append(mk('ring-track', false), mk('ring-bar', true));
  return h('div', { class: 'ring', style: { width: `${size}px`, height: `${size}px` } }, svg,
    h('div', { class: 'ring-text' }, h('b', null, `${percent}%`), sub ? h('small', null, sub) : null));
}

export function emptyState({ iconName = 'info', title, text = '', action = null }) {
  return h('div', { class: 'empty' }, icon(iconName, 36), h('h3', null, title), text ? h('p', { class: 'muted' }, text) : null, action);
}

export function installHint() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!isIOS || standalone || store.get('ui.installHintDismissed')) return null;
  const el = h('div', { class: 'notice' },
    icon('share', 22),
    h('div', { class: 'notice-text' },
      h('b', null, 'Install on your iPhone'),
      h('span', null, 'Tap the Share button in Safari, then “Add to Home Screen”. It opens full-screen and works offline. Install before you start studying: progress saved in Safari is not copied to the installed app.')),
    h('button', { type: 'button', class: 'btn small ghost', onclick: () => { store.set('ui.installHintDismissed', true); el.remove(); } }, 'Got it'));
  return el;
}
