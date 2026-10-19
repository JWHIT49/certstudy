import { h, icon, pct } from '../dom.js';
import { getPack, getSkills, getSectionMap, getQuestionMap } from '../content.js';
import * as data from '../data.js';
import { segmented, emptyState } from '../ui.js';

export async function skillsView({ params }) {
  const pack = await getPack(params.pack);
  const skills = await getSkills(pack);
  const tabs = { pack: pack.id, active: 'skills' };
  if (!skills) {
    return { el: h('div', { class: 'page' }, emptyState({ iconName: 'target', title: 'No skills list', text: 'This certification does not include a skills tracker.' })), title: 'Skills', subtitle: pack.code, back: '#/', tabs };
  }
  const sections = await getSectionMap(pack);
  const { qmap } = await getQuestionMap(pack);
  const stats = data.getQStats(pack.id);
  const ratings = data.getSkillRatings(pack.id);

  // practice accuracy per skill number, from stored per-question statistics
  const acc = {};
  for (const [key, s] of Object.entries(stats)) {
    const q = qmap.get(key);
    if (q?.skill === undefined) continue;
    const e = (acc[q.skill] ??= { a: 0, c: 0 });
    e.a += s.a;
    e.c += s.c;
  }

  const all = skills.groups.flatMap((g) => g.skills.map((s) => ({ ...s, group: g })));
  const filters = { show: 'all', domain: 0 };
  const summary = h('section', { class: 'card' });
  const list = h('div', { class: 'skills-list' });

  const renderSummary = () => {
    const rated = all.filter((s) => ratings[s.n]);
    const confident = all.filter((s) => ratings[s.n] >= 4).length;
    summary.replaceChildren(
      h('div', { class: 'sum-head' }, h('div', null, h('b', { class: 'big' }, `${confident}`), h('span', { class: 'muted' }, ` of ${all.length} skills rated 4 or 5`)),
        h('span', { class: 'muted small' }, `${rated.length} rated`)),
      h('div', { class: 'meter tall' }, h('span', { class: 'good', style: { width: `${pct(confident, all.length)}%` } }), h('span', { class: 'ok', style: { width: `${pct(rated.length - confident, all.length)}%` } })),
      ...pack.domains.map((d) => {
        const inDomain = all.filter((s) => s.group.domain === d.id);
        const ok = inDomain.filter((s) => ratings[s.n] >= 4).length;
        return h('div', { class: 'dom-mini' }, h('span', null, d.short ?? d.name), h('div', { class: 'meter' }, h('span', { style: { width: `${pct(ok, inDomain.length)}%` } })), h('b', null, `${ok}/${inDomain.length}`));
      }));
  };

  const ratingControl = (skill) => {
    const wrap = h('div', { class: 'rating', role: 'radiogroup', 'aria-label': `Confidence for skill ${skill.n}` });
    const paint = () => [...wrap.children].forEach((b, i) => {
      const on = ratings[skill.n] === i + 1;
      b.classList.toggle('on', on);
      b.classList.toggle('upto', ratings[skill.n] > i);
      b.setAttribute('aria-checked', String(on));
    });
    for (let v = 1; v <= 5; v += 1) {
      wrap.append(h('button', {
        type: 'button', role: 'radio', 'aria-label': `${v} of 5`, 'aria-checked': 'false',
        onclick: () => {
          const next = ratings[skill.n] === v ? 0 : v;
          data.setSkillRating(pack.id, skill.n, next);
          if (next) ratings[skill.n] = next; else delete ratings[skill.n];
          paint();
          renderSummary();
          if (filters.show !== 'all') renderList();
        },
      }, String(v)));
    }
    paint();
    return wrap;
  };

  function renderList() {
    list.replaceChildren();
    for (const g of skills.groups) {
      if (filters.domain && g.domain !== filters.domain) continue;
      const rows = g.skills.filter((s) => (filters.show === 'needs' ? !(ratings[s.n] >= 4) : filters.show === 'unrated' ? !ratings[s.n] : true));
      if (!rows.length) continue;
      list.append(h('section', { class: 'card skill-group' },
        h('h3', null, g.title, g.isNew ? h('span', { class: 'tag new' }, 'New') : null),
        ...rows.map((s) => {
          const a = acc[s.n];
          const links = (s.refs ?? []).map((id) => sections.get(id)).filter(Boolean);
          return h('div', { class: 'skill' },
            h('div', { class: 'skill-text' }, h('span', { class: 'skill-n' }, String(s.n)), h('span', null, s.text, s.isNew ? h('span', { class: 'tag new' }, 'New') : null)),
            h('div', { class: 'skill-tools' },
              ratingControl(s),
              h('div', { class: 'skill-links' },
                a ? h('span', { class: ['acc', a.c / a.a >= 0.8 ? 'good' : a.c / a.a >= 0.6 ? 'ok' : 'low'] }, `Practice ${a.c}/${a.a}`) : null,
                ...links.map((l) => h('a', { class: 'chip-link small', href: l.href }, icon('book', 14), l.num ? `§${l.num}` : 'Guide')))));
        })));
    }
    if (!list.children.length) list.append(emptyState({ iconName: 'check-circle', title: 'Nothing here', text: 'No skills match this filter.' }));
  }

  const controls = h('div', { class: 'controls' },
    segmented({ label: 'Filter', options: [{ value: 'all', label: 'All' }, { value: 'needs', label: 'Needs work' }, { value: 'unrated', label: 'Not rated' }], value: 'all', onChange: (v) => { filters.show = v; renderList(); } }),
    h('div', { class: 'chips' }, ...[{ id: 0, name: 'All areas' }, ...pack.domains.map((d) => ({ id: d.id, name: d.short ?? d.name }))].map((d) => {
      const chip = h('button', {
        type: 'button', class: ['chip-btn', d.id === 0 && 'on'], 'aria-pressed': String(d.id === 0),
        onclick: () => {
          filters.domain = d.id;
          chip.parentElement.querySelectorAll('.chip-btn').forEach((c) => { c.classList.remove('on'); c.setAttribute('aria-pressed', 'false'); });
          chip.classList.add('on');
          chip.setAttribute('aria-pressed', 'true');
          renderList();
        },
      }, d.name);
      return chip;
    })));

  renderSummary();
  renderList();
  const el = h('div', { class: 'page' },
    h('p', { class: 'muted' }, 'Rate your confidence from 1 (never seen it) to 5 (can build it and answer scenario questions). Book the exam when every skill is a 4 or 5.'),
    summary, controls, list);
  return { el, title: 'Skills tracker', subtitle: pack.code, back: '#/', tabs };
}
