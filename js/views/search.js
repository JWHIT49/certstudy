import { h, icon, debounce } from '../dom.js';
import { getPack, getGuideIndex, getQuestionMap } from '../content.js';
import { textOf } from '../sanitize.js';
import { row, emptyState } from '../ui.js';

const indexCache = new Map();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function buildIndex(pack) {
  if (indexCache.has(pack.id)) return indexCache.get(pack.id);
  const docs = [];
  for (const g of pack.guides) {
    const idx = await getGuideIndex(pack, g.id);
    for (const s of idx.sections) {
      docs.push({ kind: 'section', title: s.title, where: s.partTitle, text: textOf(s.html), href: `#/c/${pack.id}/guide/${g.id}/${s.id}` });
    }
  }
  const { qmap } = await getQuestionMap(pack);
  for (const q of qmap.values()) {
    const extra = [...(q.options ?? []), ...(q.items ?? []), ...(q.statements?.map((s) => s.text) ?? []), ...(q.blanks?.flatMap((b) => b.options) ?? []), q.template ?? ''];
    docs.push({
      kind: 'question', title: `Question ${q.number}`, where: textOf(q.stem).slice(0, 140),
      text: textOf(`${q.stem} ${extra.join(' ')} ${q.explanation}`), href: `#/c/${pack.id}/q/${q.examId}/${q.id}`,
    });
  }
  for (const d of docs) { d.lower = `${d.title} ${d.text}`.toLowerCase(); d.titleLower = d.title.toLowerCase(); }
  indexCache.set(pack.id, docs);
  return docs;
}

function runSearch(docs, tokens) {
  const out = [];
  for (const d of docs) {
    if (!tokens.every((t) => d.lower.includes(t))) continue;
    let score = 0;
    for (const t of tokens) {
      if (d.titleLower.includes(t)) score += 8;
      let n = 0;
      let i = -1;
      while (n < 12 && (i = d.lower.indexOf(t, i + 1)) !== -1) n += 1;
      score += n;
    }
    out.push({ d, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

function snippet(text, tokens) {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  const start = Math.max(0, (pos === -1 ? 0 : pos) - 50);
  const slice = text.slice(start, start + 170);
  const re = new RegExp(`(${tokens.map(escapeRe).join('|')})`, 'ig');
  const frag = document.createDocumentFragment();
  if (start > 0) frag.append('… ');
  slice.split(re).forEach((part, i) => frag.append(i % 2 ? h('mark', null, part) : document.createTextNode(part)));
  if (start + 170 < text.length) frag.append(' …');
  return frag;
}

export async function searchView({ params, query }) {
  const pack = await getPack(params.pack);
  const input = h('input', {
    type: 'search', class: 'search-input', placeholder: 'Search the guide and questions', 'aria-label': 'Search',
    autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', value: query.q ?? '',
  });
  const results = h('div', { class: 'results', 'aria-live': 'polite' });
  let docs = null;

  async function update() {
    const raw = input.value.trim();
    const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
    if (raw.length < 2) {
      results.replaceChildren(h('p', { class: 'muted center' }, 'Type at least two letters. Every word must match.'));
      return;
    }
    docs ??= await buildIndex(pack);
    const hits = runSearch(docs, tokens);
    if (!hits.length) { results.replaceChildren(emptyState({ iconName: 'search', title: 'No matches', text: `Nothing found for “${raw}”.` })); return; }
    const group = (kind, title, iconName) => {
      const list = hits.filter((x) => x.d.kind === kind).slice(0, 25);
      if (!list.length) return null;
      return h('section', { class: 'card' }, h('h3', null, icon(iconName, 18), title, h('span', { class: 'muted small' }, ` ${list.length}${hits.filter((x) => x.d.kind === kind).length > 25 ? '+' : ''}`)),
        h('div', { class: 'list flush' }, ...list.map(({ d }) => row({
          href: d.href, title: d.title,
          sub: h('span', { class: 'snippet' }, d.kind === 'section' ? h('b', null, `${d.where} · `) : null, snippet(d.text, tokens)),
        }))));
    };
    results.replaceChildren(...[group('section', 'Study guide', 'book'), group('question', 'Questions', 'check-circle')].filter(Boolean));
  }

  const onInput = debounce(update, 140);
  input.addEventListener('input', onInput);
  const el = h('div', { class: 'page' }, h('div', { class: 'search-bar' }, icon('search', 20), input), results);
  update();
  return { el, title: 'Search', subtitle: pack.code, back: `#/c/${pack.id}`, tabs: { pack: pack.id, active: 'home' }, onMount: () => { if (!input.value) input.focus({ preventScroll: true }); } };
}
