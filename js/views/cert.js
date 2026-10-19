import { h, icon, pct, fmtDate, plural } from '../dom.js';
import { getPack, getSectionMap, getSkills, getQuestionMap } from '../content.js';
import * as data from '../data.js';

const tile = ({ href, iconName, title, sub }) => h('a', { class: 'tile', href },
  h('span', { class: 'tile-icon' }, icon(iconName, 24)),
  h('span', { class: 'tile-title' }, title),
  h('span', { class: 'tile-sub' }, sub));

async function weakAreas(pack, sections) {
  const stats = data.getQStats(pack.id);
  if (!Object.keys(stats).length) return [];
  const { qmap } = await getQuestionMap(pack);
  const bySection = {};
  for (const [key, s] of Object.entries(stats)) {
    const q = qmap.get(key);
    if (!q?.section) continue;
    const e = (bySection[q.section] ??= { a: 0, c: 0 });
    e.a += s.a;
    e.c += s.c;
  }
  return Object.entries(bySection)
    .map(([sid, e]) => ({ sid, ...e, acc: e.c / e.a, section: sections.get(sid) }))
    .filter((x) => x.section && x.acc < 0.85)
    .sort((a, b) => a.acc - b.acc || b.a - a.a)
    .slice(0, 4);
}

export async function certHomeView({ params }) {
  const pack = await getPack(params.pack);
  const sections = await getSectionMap(pack);
  const skills = await getSkills(pack);
  const progress = data.getGuideProgress(pack.id);
  const active = data.getActive(pack.id);
  const history = data.getHistory(pack.id);
  const ratings = data.getSkillRatings(pack.id);
  const skillCount = skills ? skills.groups.reduce((n, g) => n + g.skills.length, 0) : 0;
  const confident = Object.values(ratings).filter((r) => r >= 4).length;
  const best = history.length ? Math.max(...history.map((x) => x.pct)) : null;
  const firstGuide = pack.guides[0];

  let resume;
  if (active) {
    const answered = Object.keys(active.answers ?? {}).length;
    resume = h('a', { class: 'resume', href: `#/c/${pack.id}/run` },
      icon('play', 22),
      h('span', { class: 'resume-text' }, h('b', null, 'Resume practice'), h('span', null, `${active.title} · ${answered} of ${active.keys.length} answered`)),
      icon('chevron-right', 20));
  } else if (progress.last && sections.get(progress.last.sid)) {
    const s = sections.get(progress.last.sid);
    resume = h('a', { class: 'resume', href: s.href },
      icon('book', 22),
      h('span', { class: 'resume-text' }, h('b', null, 'Continue reading'), h('span', null, s.title)),
      icon('chevron-right', 20));
  } else if (firstGuide) {
    const first = [...sections.values()][0];
    resume = h('a', { class: 'resume', href: first?.href ?? `#/c/${pack.id}/guide` },
      icon('book', 22),
      h('span', { class: 'resume-text' }, h('b', null, 'Start here'), h('span', null, first?.title ?? 'Open the study guide')),
      icon('chevron-right', 20));
  }

  const weakBox = h('section', { class: 'card', hidden: true });
  weakAreas(pack, sections).then((list) => {
    if (!list.length) return;
    weakBox.hidden = false;
    weakBox.replaceChildren(
      h('h3', null, 'Needs another look'),
      h('p', { class: 'muted small' }, 'Lowest accuracy across your practice attempts.'),
      ...list.map((w) => h('a', { class: 'row', href: w.section.href },
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, w.section.title), h('span', { class: 'row-sub' }, `${pct(w.c, w.a)}% correct · ${plural(w.a, 'answer')}`)),
        icon('chevron-right', 18, 'row-chevron'))));
  }).catch(() => {});

  const info = pack.examInfo?.length ? h('details', { class: 'card disclosure' },
    h('summary', null, 'Exam at a glance', icon('chevron-down', 18)),
    h('dl', { class: 'facts' }, ...pack.examInfo.flatMap((f) => [h('dt', null, f.label), h('dd', null, f.value)]))) : null;

  const links = pack.links?.length ? h('section', { class: 'card' }, h('h3', null, 'Official links'),
    ...pack.links.map((l) => h('a', { class: 'row', href: l.url, target: '_blank', rel: 'noopener noreferrer' },
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, l.title)), icon('external', 16, 'row-chevron')))) : null;

  const el = h('div', { class: 'page' },
    h('section', { class: 'hero', style: { '--accent': pack.accent } },
      h('span', { class: 'pack-code' }, pack.code),
      h('h1', null, pack.title),
      pack.short ? h('p', null, pack.short) : null,
      h('p', { class: 'small hero-meta' }, `Version ${pack.version}${pack.updated ? ` · updated ${fmtDate(pack.updated)}` : ''}`)),
    resume,
    h('div', { class: 'tiles' },
      tile({ href: `#/c/${pack.id}/guide`, iconName: 'book', title: 'Study guide', sub: `${Object.keys(progress.read).length} of ${sections.size} sections read` }),
      tile({ href: `#/c/${pack.id}/practice`, iconName: 'check-circle', title: 'Practice', sub: best === null ? `${pack.exams.length} exam${pack.exams.length === 1 ? '' : 's'} + drills` : `Best score ${best}%` }),
      tile({ href: `#/c/${pack.id}/skills`, iconName: 'target', title: 'Skills', sub: skillCount ? `${confident} of ${skillCount} confident` : 'Not available' }),
      tile({ href: `#/c/${pack.id}/search`, iconName: 'search', title: 'Search', sub: 'Guide and questions' })),
    weakBox,
    info,
    links,
    pack.disclaimer ? h('p', { class: 'muted small footnote' }, pack.disclaimer) : null);
  return { el, title: pack.code, subtitle: pack.short || pack.title, back: '#/', tabs: { pack: pack.id, active: 'home' }, actions: [{ icon: 'search', label: 'Search', href: `#/c/${pack.id}/search` }] };
}
