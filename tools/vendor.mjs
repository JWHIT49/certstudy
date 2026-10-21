#!/usr/bin/env node
// Rebuilds js/vendor/auth-js.js: the Supabase sign-in client (@supabase/auth-js), pinned and bundled into one file so the app
// needs no CDN and no install step at runtime. The result is committed; run this only to change the version below.
//   node tools/vendor.mjs
// It installs the pinned packages into a throwaway folder in the system temp directory (never into the repository), bundles them with
// esbuild, and refuses to write the file if the bundle uses eval, Function(), dynamic import or Node globals, because the app's
// Content-Security-Policy forbids them.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSIONS = { '@supabase/auth-js': '2.117.3', tslib: '2.8.1', esbuild: '0.28.2' };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'js', 'vendor', 'auth-js.js');

const BUILD_SCRIPT = `
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
const result = await build({
  entryPoints: ['entry.mjs'], bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, legalComments: 'none', write: false,
});
await writeFile('bundle.js', result.outputFiles[0].text);
`;

function run(command, args, cwd, { shell = false } = {}) {
  execFileSync(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell });
}

async function main() {
  const work = await mkdtemp(path.join(os.tmpdir(), 'certstudy-vendor-'));
  try {
    await writeFile(path.join(work, 'package.json'), JSON.stringify({ name: 'vendor-build', private: true, type: 'module', dependencies: VERSIONS }, null, 2));
    await writeFile(path.join(work, 'entry.mjs'), "export { GoTrueClient } from '@supabase/auth-js';\n");
    await writeFile(path.join(work, 'build.mjs'), BUILD_SCRIPT);
    run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--package-lock=false'], work, { shell: process.platform === 'win32' }); // npm is npm.cmd on Windows
    run(process.execPath, ['build.mjs'], work);

    let code = (await readFile(path.join(work, 'bundle.js'), 'utf8')).replace(/\r\n/g, '\n').trimEnd();
    const forbidden = [[/\beval\s*\(/, 'eval()'], [/\bnew\s+Function\s*\(/, 'new Function()'], [/\bimport\s*\(/, 'dynamic import()'], [/\bprocess\.(env|versions|platform)\b/, 'a Node global']];
    for (const [pattern, what] of forbidden) {
      if (pattern.test(code)) throw new Error(`The bundle uses ${what}, which the app's Content-Security-Policy does not allow. Not writing the file.`);
    }
    if (!/export\s*\{[^}]*GoTrueClient/.test(code)) throw new Error('The bundle does not export GoTrueClient.');

    const license = (await readFile(path.join(work, 'node_modules', '@supabase', 'auth-js', 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n').trim();
    if (license.includes('*/')) throw new Error('The license text cannot be placed inside a comment.');
    const banner = [
      '/*!',
      ` * @supabase/auth-js ${VERSIONS['@supabase/auth-js']} (with tslib ${VERSIONS.tslib}), bundled for CertStudy by tools/vendor.mjs using esbuild ${VERSIONS.esbuild}.`,
      ' * Generated file: do not edit. To change it, edit VERSIONS in tools/vendor.mjs and run "node tools/vendor.mjs".',
      ' *',
      ...license.split('\n').map((line) => (line ? ` * ${line}` : ' *')),
      ' */',
    ].join('\n');

    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, `${banner}\n${code}\n`, 'utf8');
    console.log(`wrote ${path.relative(ROOT, OUT)} (${Math.round((banner.length + code.length) / 1024)} KB)`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err.message ?? err); process.exit(1); });
