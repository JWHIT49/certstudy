#!/usr/bin/env node
// CertStudy build tool.
//   node tools/build.mjs           validate every content pack, then (re)generate the derived files:
//                                    content/catalog.json  - library index (counts etc.)
//                                    build.json + precache.js - offline file list and BUILD_ID used by the service worker
//   node tools/build.mjs --check   validate only; fail if the generated files are out of date (use in CI)
// No dependencies. Deterministic: the same inputs always produce byte-identical outputs (no timestamps).
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLoadedPack } from '../js/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

// The build id hashes text files with LF line endings, so a Windows checkout (CRLF) and the Linux runner that publishes
// the site (LF) compute the same id for the same code.
const TEXT_EXT = new Set(['.html', '.js', '.json', '.css', '.svg', '.webmanifest']);
const forHash = (rel, bytes) => (TEXT_EXT.has(path.extname(rel)) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes);

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

async function loadPacks() {
  const contentDir = path.join(ROOT, 'content');
  const packs = [];
  let failed = false;
  for (const entry of await readdir(contentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(contentDir, entry.name);
    let pack;
    try { pack = await readJson(path.join(dir, 'pack.json')); } catch { continue; }
    const loaded = { pack, guides: {}, skills: null, exams: {} };
    try {
      for (const g of pack.guides ?? []) loaded.guides[g.id] = await readJson(path.join(dir, g.file));
      if (pack.skills) loaded.skills = await readJson(path.join(dir, pack.skills.file));
      for (const x of pack.exams ?? []) loaded.exams[x.id] = await readJson(path.join(dir, x.file));
    } catch (err) {
      console.error(`ERROR [${entry.name}] cannot read content file: ${err.message}`);
      failed = true;
      continue;
    }
    const errors = validateLoadedPack(loaded);
    if (pack.id !== entry.name) errors.push(`[pack] id "${pack.id}" must match its folder name "${entry.name}"`);
    if (errors.length) {
      failed = true;
      console.error(`ERROR pack "${entry.name}" has ${errors.length} problem(s):`);
      errors.slice(0, 40).forEach((m) => console.error(`  - ${m}`));
      if (errors.length > 40) console.error(`  ... and ${errors.length - 40} more`);
    } else {
      loaded.dir = entry.name;
      packs.push(loaded);
    }
  }
  return { packs, failed };
}

function catalogEntry({ pack, guides, skills, exams, dir }) {
  const sections = Object.values(guides).reduce((n, g) => n + g.parts.reduce((m, p) => m + p.sections.length, 0), 0);
  const skillCount = skills ? skills.groups.reduce((n, g) => n + g.skills.length, 0) : 0;
  const questions = Object.values(exams).reduce((n, x) => n + x.questions.length, 0);
  return {
    id: pack.id, order: pack.order ?? 100, code: pack.code, title: pack.title, short: pack.short ?? '', vendor: pack.vendor ?? '',
    version: pack.version, updated: pack.updated ?? '', accent: pack.accent ?? '#0f6cbd', description: pack.description ?? '',
    counts: { guides: pack.guides.length, sections, skills: skillCount, exams: pack.exams.length, questions },
    path: `${dir}/pack.json`,
  };
}

async function writeIfChanged(rel, text, problems) {
  const file = path.join(ROOT, rel);
  let current = null;
  try { current = await readFile(file, 'utf8'); } catch { /* new file */ }
  if (current === text) return false;
  if (CHECK) { problems.push(`${rel} is out of date - run "node tools/build.mjs"`); return true; }
  await writeFile(file, text, 'utf8');
  return true;
}

async function main() {
  const { packs, failed } = await loadPacks();
  if (failed) process.exit(1);
  if (packs.length === 0) { console.error('ERROR no content packs found in content/'); process.exit(1); }

  const problems = [];
  const catalog = {
    schema: 1,
    packs: packs.map(catalogEntry).sort((a, b) => a.order - b.order || a.code.localeCompare(b.code)),
  };
  const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
  await writeIfChanged('content/catalog.json', catalogText, problems);

  // Everything the app needs offline. sw.js, build.json and precache.js are handled separately.
  const roots = ['css', 'js', 'icons', 'content'];
  const files = ['index.html', 'manifest.webmanifest'];
  for (const r of roots) files.push(...(await walk(path.join(ROOT, r))));
  const list = [...new Set(files)].sort();

  const hash = createHash('sha256');
  for (const rel of list) {
    const data = rel === 'content/catalog.json' ? Buffer.from(catalogText) : await readFile(path.join(ROOT, rel));
    hash.update(rel).update('\0').update(forHash(rel, data)).update('\0');
  }
  const id = hash.digest('hex').slice(0, 12);
  const build = { id, files: ['./', ...list, 'build.json'] };
  await writeIfChanged('build.json', `${JSON.stringify({ id, files: build.files.length }, null, 2)}\n`, problems);
  await writeIfChanged(
    'precache.js',
    `// Generated by tools/build.mjs - do not edit.\nself.CERTSTUDY_BUILD = ${JSON.stringify(build, null, 2)};\n`,
    problems,
  );

  for (const p of catalog.packs) {
    console.log(`  ${p.code.padEnd(10)} ${p.counts.sections} guide sections, ${p.counts.skills} skills, ${p.counts.questions} questions in ${p.counts.exams} exam(s)`);
  }
  if (problems.length) { problems.forEach((m) => console.error(`ERROR ${m}`)); process.exit(1); }
  console.log(`${CHECK ? 'checked' : 'built'} ${packs.length} pack(s); ${build.files.length} offline files; build ${id}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
