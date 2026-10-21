#!/usr/bin/env node
// Tiny static dev server (no dependencies). Usage: node tools/serve.mjs [port] [--lan]
//   --lan  listen on all interfaces so a phone on the same Wi-Fi can open http://<this-pc-ip>:<port>
// iOS only registers service workers over HTTPS (or localhost), so the offline features need a real HTTPS host.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8080);
const host = process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- mock cloud (development only; mirrors supabase/migrations)
// js/cloud-mock.js talks to this on localhost with ?cloud=mock. Nothing here is deployed.
const mockUsers = new Map(); // user id -> Map(key -> row)
let mockFail = null; // null | 'offline' | 'auth' | 'server', changed with POST /__mock/control
let lastStamp = 0;
const stamp = () => { lastStamp = Math.max(Date.now(), lastStamp + 1); return new Date(lastStamp).toISOString(); };
// Like the database: every write gets a revision nobody has seen before, even when a row is deleted and created again.
let lastRev = 0;
const nextRev = () => { lastRev = Math.max(Date.now() * 1000, lastRev + 1); return lastRev; };
const KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;

function mockRpc(user, fn, a) {
  const rows = mockUsers.get(user) ?? mockUsers.set(user, new Map()).get(user);
  const view = (r) => ({ key: r.key, value: r.deleted ? null : r.value, deleted: r.deleted, rev: r.rev, updated_at: r.updated_at });
  if (fn === 'cs_list_docs') {
    const since = a.p_since ?? null;
    const after = a.p_after_key ?? null;
    return [...rows.values()]
      .filter((r) => since === null || r.updated_at > since || (r.updated_at === since && after !== null && r.key > after))
      .sort((x, y) => (x.updated_at < y.updated_at ? -1 : x.updated_at > y.updated_at ? 1 : x.key < y.key ? -1 : 1))
      .slice(0, Math.min(Number(a.p_limit) || 200, 500)).map(view);
  }
  if (fn === 'cs_get_docs') return (a.p_keys ?? []).slice(0, 100).filter((k) => rows.has(k)).map((k) => view(rows.get(k)));
  if (fn === 'cs_put_docs') {
    return (a.p_docs ?? []).map((d) => {
      if (!KEY_RE.test(d.key ?? '')) return { key: d.key, ok: false, error: 'bad key' };
      const base = Number(d.base_rev) || 0;
      const row = rows.get(d.key);
      if (!row) {
        if (base !== 0) return { key: d.key, ok: false, conflict: true };
        if (d.deleted) return { key: d.key, ok: true, rev: 0 };
        const created = { key: d.key, value: d.value, deleted: false, rev: nextRev(), updated_at: stamp() };
        rows.set(d.key, created);
        return { key: d.key, ok: true, rev: created.rev };
      }
      if (row.rev !== base) return { key: d.key, ok: false, conflict: true };
      Object.assign(row, { value: d.deleted ? null : d.value, deleted: !!d.deleted, rev: nextRev(), updated_at: stamp() });
      return { key: d.key, ok: true, rev: row.rev };
    });
  }
  if (fn === 'cs_delete_my_data' || fn === 'cs_delete_my_account') { mockUsers.delete(user); return null; }
  return undefined;
}

async function handleMock(req, res, url) {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  let text = '';
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : {};
  if (url.pathname === '/__mock/control') { mockFail = body.fail ?? null; send(200, { fail: mockFail }); return; }
  if (url.pathname === '/__mock/state') {
    const who = url.searchParams.get('user');
    const docs = who && mockUsers.has(who) ? [...mockUsers.get(who).values()].map((r) => ({ key: r.key, rev: r.rev, deleted: r.deleted, value: r.value })) : undefined;
    send(200, { users: [...mockUsers.keys()], fail: mockFail, docs });
    return;
  }
  const m = /^\/__mock\/rpc\/([a-z_]+)$/.exec(url.pathname);
  if (!m) { send(404, { message: 'unknown mock endpoint' }); return; }
  if (mockFail === 'offline') { send(503, { message: 'offline' }); return; }
  if (mockFail === 'auth') { send(401, { message: 'expired' }); return; }
  if (mockFail === 'server') { send(500, { message: 'boom' }); return; }
  const user = req.headers['x-mock-user'];
  if (!user) { send(401, { message: 'no user' }); return; }
  const out = mockRpc(String(user), m[1], body);
  if (out === undefined) { send(404, { message: 'unknown function' }); return; }
  send(200, out);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/__mock/')) { await handleMock(req, res, url); return; }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, `.${rel}`);
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403).end('Forbidden'); return; }
    let target = file;
    try { if ((await stat(file)).isDirectory()) target = path.join(file, 'index.html'); } catch { /* handled below */ }
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, host, () => console.log(`CertStudy dev server: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/  (Ctrl+C to stop)`));
