// Tiny DOM helpers. No framework, no innerHTML: untrusted markup only enters the page through sanitize.js.
const SVG_NS = 'http://www.w3.org/2000/svg';

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** h('div', {class: 'x', onclick: fn, style: {'--w': '4px'}}, child, child...) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v === undefined || v === null) continue;
      if (key.startsWith('aria-')) { el.setAttribute(key, String(v)); continue; }
      if (v === false) continue;
      if (key === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      else if (key === 'style') {
        for (const [p, val] of Object.entries(v)) {
          if (p.startsWith('--')) el.style.setProperty(p, val);
          else el.style[p] = val;
        }
      } else if (key === 'dataset') Object.assign(el.dataset, v);
      else if (key.length > 2 && key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(v));
    }
  }
  return append(el, children);
}

export const clear = (el) => { el.replaceChildren(); return el; };

// ---------------------------------------------------------------- icons (24x24 stroke icons, drawn for this app)
const ICONS = {
  library: ['M12 3.5l9 4.8-9 4.8-9-4.8 9-4.8z', 'M3 12.6l9 4.8 9-4.8', 'M3 16.8l9 4.8 9-4.8'],
  home: ['M3.5 11.2L12 3.5l8.5 7.7', 'M5.5 9.8V20h4.5v-5.5h4V20h4.5V9.8'],
  book: ['M3 5.5h5.5A3.5 3.5 0 0 1 12 9v11a2.5 2.5 0 0 0-2.5-2.5H3z', 'M21 5.5h-5.5A3.5 3.5 0 0 0 12 9v11a2.5 2.5 0 0 1 2.5-2.5H21z'],
  'check-circle': [{ c: [12, 12, 9] }, 'M8 12.5l2.7 2.7L16 9.6'],
  target: [{ c: [12, 12, 9] }, { c: [12, 12, 5] }, { c: [12, 12, 1] }],
  'chevron-right': ['M9 5l7 7-7 7'],
  'chevron-left': ['M15 5l-7 7 7 7'],
  'chevron-down': ['M5 9l7 7 7-7'],
  search: [{ c: [11, 11, 6.5] }, 'M20 20l-4.2-4.2'],
  sliders: ['M4 6h9', 'M17 6h3', { c: [15, 6, 2] }, 'M4 12h3', 'M11 12h9', { c: [9, 12, 2] }, 'M4 18h11', 'M19 18h1', { c: [17, 18, 2] }],
  flag: ['M5 21V4', 'M5 4h12l-2.5 4 2.5 4H5'],
  clock: [{ c: [12, 12, 9] }, 'M12 7v5l3 2'],
  grid: [{ r: [4, 4, 6.5, 6.5, 1.5] }, { r: [13.5, 4, 6.5, 6.5, 1.5] }, { r: [4, 13.5, 6.5, 6.5, 1.5] }, { r: [13.5, 13.5, 6.5, 6.5, 1.5] }],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  play: ['M7 4.5v15l12-7.5z'],
  refresh: ['M20 12a8 8 0 1 1-2.6-5.9', 'M20 4v5h-5'],
  share: ['M12 15V3.5', 'M8 7.5l4-4 4 4', 'M5 12v8h14v-8'],
  info: [{ c: [12, 12, 9] }, 'M12 11v5.5', 'M12 7.8h.01'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', { c: [12, 12, 3] }],
  'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
  'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  bolt: ['M13 2.5L4.5 14H11l-1 7.5L19.5 10H13z'],
  history: ['M3.5 12a8.5 8.5 0 1 0 2.6-6.1', 'M3.5 4v5h5', 'M12 8v4l3 2'],
  trash: ['M4 7h16', 'M9.5 7V4h5v3', 'M6 7l1 13h10l1-13'],
  list: ['M8.5 6h12', 'M8.5 12h12', 'M8.5 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  download: ['M12 3.5v12', 'M7 11l5 5 5-5', 'M5 21h14'],
  upload: ['M12 16.5v-13', 'M7 8.5l5-5 5 5', 'M5 21h14'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
  award: [{ c: [12, 9, 6] }, 'M8.5 14l-1.5 7 5-3 5 3-1.5-7'],
  moon: ['M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z'],
  layers: ['M12 3.5l9 4.8-9 4.8-9-4.8 9-4.8z'],
  cloud: ['M7.5 18.5h9a4 4 0 0 0 .6-7.95a5.5 5.5 0 0 0-10.6 1.45a3.2 3.2 0 0 0 1 6.5z'],
  user: [{ c: [12, 8, 4] }, 'M4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6'],
  'log-out': ['M10 4.5H5.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1H10', 'M15 8l4 4-4 4', 'M19 12H9'],
};

export function icon(name, size = 22, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon ${cls}`.trim());
  for (const spec of ICONS[name] ?? []) {
    let node;
    if (typeof spec === 'string') {
      node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', spec);
    } else if (spec.c) {
      node = document.createElementNS(SVG_NS, 'circle');
      node.setAttribute('cx', String(spec.c[0]));
      node.setAttribute('cy', String(spec.c[1]));
      node.setAttribute('r', String(spec.c[2]));
    } else if (spec.r) {
      node = document.createElementNS(SVG_NS, 'rect');
      const [x, y, w, hh, rx] = spec.r;
      node.setAttribute('x', x); node.setAttribute('y', y); node.setAttribute('width', w); node.setAttribute('height', hh); node.setAttribute('rx', rx);
    }
    if (node) svg.append(node);
  }
  return svg;
}

// ---------------------------------------------------------------- small utilities
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const pad = (n) => String(n).padStart(2, '0');

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60);
  return `${hh} h ${m % 60} min`;
}

export const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const fmtDateTime = (ts) => `${fmtDate(ts)}, ${new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
export const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

export const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  const wrapped = (...args) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) { last = now; fn(...args); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(...args); }, wait);
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}
