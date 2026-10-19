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

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
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
