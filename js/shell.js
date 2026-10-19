// The app frame: one top bar, one scrolling view, an optional tab bar. Views hand over a descriptor:
//   { el, title, subtitle?, back? (href | fn), brand?, actions?: [{icon,label,href|onClick}], topEl?, tabs?: {pack, active},
//     fill? (view manages its own scrolling), className?, restoreScroll?, onMount?, onLeave? }
import { h, icon } from './dom.js';
import { closeAllSheets } from './ui.js';

const TABS = [['home', 'Home', 'home'], ['guide', 'Guide', 'book'], ['practice', 'Practice', 'check-circle'], ['skills', 'Skills', 'target']];
let current = null;

const $ = (id) => document.getElementById(id);

function leave() {
  if (current?.onLeave) {
    try { current.onLeave(); } catch (err) { console.error(err); }
  }
  current = null;
}

function actionEl(a) {
  const props = { class: 'icon-btn', 'aria-label': a.label, title: a.label };
  const content = a.icon ? icon(a.icon, 22) : a.text;
  return a.href ? h('a', { ...props, href: a.href }, content) : h('button', { ...props, type: 'button', onclick: a.onClick }, content);
}

function renderTop(view) {
  const bar = $('topbar');
  if (view.topEl) {
    bar.className = 'topbar custom';
    bar.replaceChildren(view.topEl);
    return;
  }
  bar.className = 'topbar';
  let left;
  if (typeof view.back === 'function') left = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: view.back }, icon('chevron-left', 26));
  else if (view.back) left = h('a', { class: 'icon-btn', href: view.back, 'aria-label': 'Back' }, icon('chevron-left', 26));
  else left = h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('library', 22));
  bar.replaceChildren(h('div', { class: 'top-row' },
    left,
    h('div', { class: 'top-title' }, h('div', { class: 'top-main' }, view.title ?? ''), view.subtitle ? h('div', { class: 'top-sub' }, view.subtitle) : null),
    h('div', { class: 'top-actions' }, ...(view.actions ?? []).map(actionEl))));
}

function renderTabs(view) {
  const nav = $('tabbar');
  if (!view.tabs) { nav.hidden = true; nav.replaceChildren(); return; }
  nav.hidden = false;
  const { pack, active } = view.tabs;
  nav.replaceChildren(...TABS.map(([id, label, ic]) => h('a', {
    class: ['tab', active === id && 'active'], href: id === 'home' ? `#/c/${pack}` : `#/c/${pack}/${id}`,
    'aria-current': active === id ? 'page' : null,
  }, icon(ic, 24), h('span', null, label))));
}

function messageView(title, text, { back = '#/' } = {}) {
  return {
    title: 'CertStudy', back: null,
    el: h('div', { class: 'page' }, h('div', { class: 'empty' }, icon('info', 36), h('h3', null, title), h('p', { class: 'muted' }, text),
      h('a', { class: 'btn primary', href: back }, 'Back to library'))),
  };
}

export function mount(view) {
  closeAllSheets();
  if (view?.loading) {
    leave();
    $('view').className = 'view';
    $('view').replaceChildren(h('div', { class: 'loading', role: 'status' }, h('div', { class: 'spinner' }), h('span', null, 'Loading…')));
    return;
  }
  if (!view || view.notFound) view = messageView('Page not found', 'That page does not exist.');
  else if (view.error) {
    const expected = view.error.name === 'NotFoundError'; // a stale link or a deleted attempt, not a bug
    if (!expected) console.error(view.error);
    view = messageView(expected ? 'Not found' : 'Something went wrong', view.error.message || String(view.error));
  }
  leave();
  current = view;
  const main = $('view');
  main.className = `view${view.fill ? ' fill' : ''}${view.className ? ` ${view.className}` : ''}`;
  main.replaceChildren(view.el);
  renderTop(view);
  renderTabs(view);
  document.title = view.title && view.title !== 'CertStudy' ? `${view.title} · CertStudy` : 'CertStudy';
  main.scrollTop = view.restoreScroll ?? 0;
  main.focus({ preventScroll: true });
  view.onMount?.(main);
}

export const scroller = () => $('view');
