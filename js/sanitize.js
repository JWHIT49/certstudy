// Allowlist HTML sanitizer. Content packs contain HTML (tables, code, callouts); it is parsed in an inert document and
// REBUILT node by node, so only known tags, a few attributes and known class names can ever reach the live page.
const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'code', 'pre', 'kbd', 'mark', 'small', 'span', 'br', 'hr', 'p', 'div',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'h2', 'h3', 'h4', 'h5', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'colgroup', 'col', 'blockquote', 'details', 'summary',
]);
// Tags removed together with their content (everything else unknown is unwrapped, keeping its text).
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'template', 'noscript', 'svg', 'math', 'form', 'input', 'button',
  'select', 'textarea', 'img', 'video', 'audio', 'canvas', 'base', 'frame', 'frameset', 'head', 'title',
]);

// Class names that content may use; the stylesheet defines them. Unknown classes are dropped.
export const ALLOWED_CLASSES = new Set([
  'callout', 'tip', 'trap', 'new', 'warn', 'note', 'ct', 'tag', 'ga', 'prev', 'carry', 'removed', 'tight', 'c', 'small', 'muted', 'src',
  'grid2', 'grid3', 'card', 'dom', 'w', 'b', 'bars', 'bar-row', 'bar-label', 'bar-track', 'bar-fill', 'bar-val', 'cols2', 'check',
  'nobullet', 'stem', 'secref',
]);

const ATTRS = { a: ['href'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], col: ['span'], ol: ['start'] };

function safeHref(value) {
  const v = value.trim();
  return /^(https?:\/\/|mailto:|#\/)/i.test(v) ? v : null;
}

function copyAttributes(from, to, tag) {
  const classes = (from.getAttribute('class') ?? '').split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c));
  if (classes.length) to.className = classes.join(' ');
  const title = from.getAttribute('title');
  if (title) to.title = title;
  for (const name of ATTRS[tag] ?? []) {
    const v = from.getAttribute(name);
    if (v === null) continue;
    if (name === 'href') {
      const href = safeHref(v);
      if (!href) continue;
      to.setAttribute('href', href);
      if (/^https?:/i.test(href)) { to.target = '_blank'; to.rel = 'noopener noreferrer'; }
    } else if (/^\d{1,3}$/.test(v)) to.setAttribute(name, v);
  }
  // Bar widths arrive as data-w="NN" and are applied through the CSSOM, because the CSP forbids inline style attributes.
  const w = from.getAttribute('data-w');
  if (w && /^\d{1,3}(?:\.\d+)?$/.test(w)) to.style.width = `${Math.min(100, Number(w))}%`;
}

function rebuild(src, out) {
  for (const child of src.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { out.append(document.createTextNode(child.data)); continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.localName;
    if (DROP_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) { rebuild(child, out); continue; }
    const el = document.createElement(tag);
    copyAttributes(child, el, tag);
    rebuild(child, el);
    if (tag === 'table') out.append(wrapTable(el));
    else out.append(el);
  }
}

// Tables scroll sideways inside a rounded wrapper; 4+ column tables get a minimum width so cells stay readable on a phone.
function wrapTable(table) {
  const cols = Math.max(0, ...[...table.rows].map((r) => r.cells.length));
  const wrap = document.createElement('div');
  wrap.className = cols >= 4 ? 'table-wrap wide' : 'table-wrap';
  wrap.append(table);
  return wrap;
}

/** Returns a DocumentFragment that is safe to insert into the page. */
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html ?? ''}`, 'text/html');
  const fragment = document.createDocumentFragment();
  rebuild(doc.body, fragment);
  return fragment;
}

/** Plain text of an HTML string (for search and snippets). */
export function textOf(html) {
  return (new DOMParser().parseFromString(`<!doctype html><body>${html ?? ''}`, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const SECTION_REF = /§\s?(\d+\.\d+)/g;

/** Turns "§3.1" in running text into links, using hrefFor('3.1') -> '#/...' (or null to leave the text alone). */
export function linkSectionRefs(root, hrefFor) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.data.includes('§') && !(n.parentElement && n.parentElement.closest('a, code, pre'))) nodes.push(n);
  }
  for (const node of nodes) {
    const text = node.data;
    SECTION_REF.lastIndex = 0;
    const parts = [];
    let last = 0;
    let m;
    while ((m = SECTION_REF.exec(text))) {
      const href = hrefFor(m[1]);
      if (!href) continue;
      parts.push(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = href;
      a.className = 'secref';
      a.textContent = m[0];
      parts.push(a);
      last = m.index + m[0].length;
    }
    if (!parts.length) continue;
    parts.push(document.createTextNode(text.slice(last)));
    node.replaceWith(...parts);
  }
  return root;
}
