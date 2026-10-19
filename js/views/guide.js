import { h, icon, throttle } from '../dom.js';
import { getPack, getGuideIndex, NotFoundError } from '../content.js';
import { sanitizeHtml, linkSectionRefs } from '../sanitize.js';
import * as data from '../data.js';
import { row, openSheet, meter } from '../ui.js';

const tagEl = (b) => h('span', { class: `tag ${b.kind}` }, b.text);

export async function guideListView({ params }) {
  const pack = await getPack(params.pack);
  if (pack.guides.length === 1) return { redirect: `/c/${pack.id}/guide/${pack.guides[0].id}` };
  const el = h('div', { class: 'page' }, h('div', { class: 'list' }, ...pack.guides.map((g) => row({ href: `#/c/${pack.id}/guide/${g.id}`, title: g.title, leading: icon('book', 22) }))));
  return { el, title: 'Study guides', subtitle: pack.code, back: '#/', tabs: { pack: pack.id, active: 'guide' } };
}

export async function guideTocView({ params }) {
  const pack = await getPack(params.pack);
  const idx = await getGuideIndex(pack, params.gid);
  const progress = data.getGuideProgress(pack.id);
  const total = idx.sections.length;
  const readCount = idx.sections.filter((s) => progress.read[s.id]).length;
  const lastSec = progress.last?.gid === idx.id ? idx.byId.get(progress.last.sid) : null;

  const parts = idx.guide.parts.map((part, i) => {
    const done = part.sections.filter((s) => progress.read[s.id]).length;
    const open = lastSec ? lastSec.partId === part.id : i === 0;
    return h('details', { class: 'part', open },
      h('summary', null,
        h('span', { class: 'part-main' }, h('b', null, part.title), part.subtitle ? h('small', null, part.subtitle) : null),
        h('span', { class: 'part-count' }, `${done}/${part.sections.length}`),
        icon('chevron-down', 18, 'part-chevron')),
      h('div', { class: 'list' }, ...part.sections.map((s) => row({
        href: `#/c/${pack.id}/guide/${idx.id}/${s.id}`,
        title: s.title,
        sub: `~${s.readMinutes} min read`,
        leading: progress.read[s.id] ? h('span', { class: 'done-dot' }, icon('check', 14)) : h('span', { class: 'todo-dot' }),
        trailing: s.badges?.length ? h('span', { class: 'row-tags' }, ...s.badges.map(tagEl)) : null,
      }))));
  });

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('h1', null, idx.title),
      h('div', { class: 'progress-line' }, meter(readCount, total, { label: 'Sections studied' }), h('span', { class: 'muted small' }, `${readCount} of ${total} sections studied`))),
    lastSec ? h('a', { class: 'resume', href: `#/c/${pack.id}/guide/${idx.id}/${lastSec.id}` }, icon('book', 22),
      h('span', { class: 'resume-text' }, h('b', null, 'Continue reading'), h('span', null, lastSec.title)), icon('chevron-right', 20)) : null,
    ...parts);
  return {
    el, title: 'Study guide', subtitle: pack.code, back: '#/', tabs: { pack: pack.id, active: 'guide' },
    actions: [{ icon: 'search', label: 'Search', href: `#/c/${pack.id}/search` }],
  };
}

export async function guideReaderView({ params }) {
  const pack = await getPack(params.pack);
  const idx = await getGuideIndex(pack, params.gid);
  const sec = idx.byId.get(params.sid);
  if (!sec) throw new NotFoundError('That section does not exist.');
  const progress = data.getGuideProgress(pack.id);
  const base = `#/c/${pack.id}/guide/${idx.id}`;

  const fragment = sanitizeHtml(sec.html);
  linkSectionRefs(fragment, (num) => (idx.byNum.has(num) ? `${base}/${idx.byNum.get(num).id}` : null));
  const body = h('div', { class: 'prose reader' }, fragment);
  const headings = [...body.querySelectorAll('h3')];
  headings.forEach((el, i) => { el.id = `rd-h-${i}`; });

  const markBtn = h('button', { type: 'button', class: 'btn block' });
  let studied = Boolean(progress.read[sec.id]);
  const paintMark = () => {
    markBtn.className = `btn block ${studied ? 'ghost done' : 'primary'}`;
    markBtn.replaceChildren(icon(studied ? 'check-circle' : 'check', 20), studied ? 'Studied (tap to undo)' : 'Mark as studied');
  };
  markBtn.addEventListener('click', () => { studied = !studied; data.setSectionRead(pack.id, sec.id, studied); paintMark(); });
  paintMark();

  const prev = idx.sections[sec.order - 1];
  const next = idx.sections[sec.order + 1];
  const nav = h('div', { class: 'pager' },
    prev ? h('a', { class: 'pager-link', href: `${base}/${prev.id}` }, icon('arrow-left', 18), h('span', null, h('small', null, 'Previous'), prev.title)) : null,
    next ? h('a', { class: 'pager-link next', href: `${base}/${next.id}` }, h('span', null, h('small', null, 'Next'), next.title), icon('arrow-right', 18)) : null);

  const el = h('div', { class: 'page reader-page' },
    h('div', { class: 'crumbs' }, sec.partTitle),
    h('h1', { class: 'sec-title' }, sec.title, ...(sec.badges ?? []).map(tagEl)),
    h('div', { class: 'muted small' }, `About ${sec.readMinutes} min read`),
    body,
    h('div', { class: 'reader-foot' }, markBtn, nav));

  const actions = [];
  if (headings.length) {
    actions.push({
      icon: 'list', label: 'On this page',
      onClick: () => {
        const ref = openSheet({
          title: 'On this page',
          content: h('div', { class: 'list' }, ...headings.map((hd) => row({
            title: hd.textContent.trim(),
            onClick: () => { ref.close(); setTimeout(() => hd.scrollIntoView({ block: 'start', behavior: 'smooth' }), 240); },
          }))),
        });
      },
    });
  }
  actions.push({ icon: 'search', label: 'Search', href: `#/c/${pack.id}/search` });

  const restore = progress.last?.sid === sec.id ? progress.last.y : 0;
  let detach = null;
  return {
    el, title: sec.partTitle, subtitle: pack.code, back: base, tabs: { pack: pack.id, active: 'guide' }, actions, restoreScroll: restore,
    onMount: (main) => {
      // Recorded here rather than while building the view: the previous reader's onLeave runs after the build and would overwrite it.
      data.setLastRead(pack.id, idx.id, sec.id, main.scrollTop);
      const save = throttle(() => data.setLastRead(pack.id, idx.id, sec.id, main.scrollTop), 600);
      main.addEventListener('scroll', save, { passive: true });
      detach = () => { save.cancel(); main.removeEventListener('scroll', save); data.setLastRead(pack.id, idx.id, sec.id, main.scrollTop); };
    },
    onLeave: () => detach?.(),
  };
}
