// Hash router: '#/c/ab-400/guide/study-guide' -> handler({ params, query, path }).
// A handler returns a view descriptor (see shell.js) or { redirect: '/path' }.
const table = [];
let render = () => {};
let token = 0;

export function on(pattern, handler) {
  const keys = [];
  const source = pattern.replace(/:[A-Za-z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; });
  table.push({ re: new RegExp(`^${source}/?$`), keys, handler });
}

export function parse() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  const path = (q === -1 ? raw : raw.slice(0, q)) || '/';
  const query = Object.fromEntries(new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)));
  return { path, query };
}

export function go(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (replace) location.replace(target);
  else if (location.hash === target) run();
  else location.hash = path;
}

async function run() {
  const mine = ++token;
  const { path, query } = parse();
  let slow = setTimeout(() => { if (mine === token) render({ loading: true }); }, 180);
  let view;
  try {
    const hit = table.find((r) => r.re.test(path));
    if (!hit) {
      view = { notFound: true };
    } else {
      const m = hit.re.exec(path);
      const params = {};
      let valid = true;
      hit.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); } catch { valid = false; } // a hand-typed "%" is a bad link, not an app error
      });
      view = valid ? await hit.handler({ params, query, path }) : { notFound: true };
    }
  } catch (err) {
    view = { error: err };
  }
  clearTimeout(slow);
  slow = null;
  if (mine !== token) return;
  if (view?.redirect) { go(view.redirect, { replace: true }); return; }
  render(view);
}

export function start(renderFn) {
  render = renderFn;
  window.addEventListener('hashchange', run);
  run();
}
