import { h } from '../dom.js';
import { loadCatalog } from '../content.js';
import * as data from '../data.js';
import { installHint } from '../ui.js';

const stat = (label, value) => h('div', { class: 'stat' }, h('b', null, value), h('span', null, label));

function packCard(p) {
  const read = Object.keys(data.getGuideProgress(p.id).read).length;
  const confident = Object.values(data.getSkillRatings(p.id)).filter((r) => r >= 4).length;
  const history = data.getHistory(p.id);
  const best = history.length ? Math.max(...history.map((x) => x.pct)) : null;
  return h('a', { class: 'pack-card', href: `#/c/${p.id}`, style: { '--accent': p.accent } },
    h('div', { class: 'pack-top' },
      h('span', { class: 'pack-code' }, p.code),
      p.vendor ? h('span', { class: 'pack-vendor' }, p.vendor) : null,
      data.getActive(p.id) ? h('span', { class: 'badge' }, 'In progress') : null),
    h('div', { class: 'pack-title' }, p.title),
    p.short ? h('div', { class: 'pack-short' }, p.short) : null,
    h('div', { class: 'pack-stats' },
      stat('Guide read', `${read}/${p.counts.sections}`),
      stat('Skills ≥ 4', `${confident}/${p.counts.skills}`),
      stat('Best score', best === null ? '–' : `${best}%`)),
    h('div', { class: 'pack-foot' }, `${p.counts.questions} practice questions · v${p.version}`));
}

/** Groups packs by their optional `family` (keeps catalog order inside a family and between families). */
function packsByFamily(packs) {
  const map = new Map();
  for (const p of packs) {
    const key = p.family || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  return [...map.entries()];
}

export async function libraryView() {
  const catalog = await loadCatalog();
  const families = packsByFamily(catalog.packs);
  const grouped = families.some(([name]) => name);
  const body = grouped
    ? families.map(([name, list]) => h('section', { class: 'family' },
      name ? h('h2', { class: 'family-title' }, name) : null,
      h('div', { class: 'stack' }, ...list.map(packCard))))
    : [h('div', { class: 'stack' }, ...catalog.packs.map(packCard))];
  const el = h('div', { class: 'page' },
    installHint(),
    h('div', { class: 'page-head' },
      h('h1', null, 'Your certifications'),
      h('p', { class: 'muted' }, 'Study guides, skill tracking and practice exams. Works offline once installed.')),
    ...body,
    h('p', { class: 'muted small center footnote' }, 'Add more certifications by dropping a content pack into the content folder (see the README).'));
  return { el, title: 'CertStudy', actions: [{ icon: 'sliders', label: 'Settings', href: '#/settings' }] };
}
