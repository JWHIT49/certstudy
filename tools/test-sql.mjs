#!/usr/bin/env node
// Checks supabase/migrations/*.sql against a real Postgres engine (PGlite, run in-process) that is set up like a Supabase project:
// the anon / authenticated roles, auth.users, auth.uid() driven by the request.jwt.claims setting, and Supabase's default privileges.
//   node tools/test-sql.mjs
// PGlite is installed into a throwaway folder in the system temp directory (never into the repository), so this needs a network
// connection once per run. It is a manual check, not part of `npm test`, which has to stay dependency-free for CI.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const PGLITE_VERSION = '0.5.10';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// For mutation testing: CERTSTUDY_PGLITE_DIR reuses an existing PGlite install (skips the download), CERTSTUDY_MIGRATIONS tests another folder.
const MIGRATIONS = process.env.CERTSTUDY_MIGRATIONS ?? path.join(ROOT, 'supabase', 'migrations');
const REUSE_DIR = process.env.CERTSTUDY_PGLITE_DIR ?? null;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Supabase gives these roles access to everything created later in public; the migration has to take it away where needed.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, err }); }
}

async function main() {
  const work = REUSE_DIR ?? await mkdtemp(path.join(os.tmpdir(), 'certstudy-sqltest-'));
  try {
    if (!REUSE_DIR) {
      await writeFile(path.join(work, 'package.json'), JSON.stringify({ name: 'sql-test', private: true, dependencies: { '@electric-sql/pglite': PGLITE_VERSION } }));
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--package-lock=false'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
    }
    const { PGlite } = createRequire(path.join(work, 'package.json'))('@electric-sql/pglite');
    const db = new PGlite();
    await db.waitReady;

    const migrationDir = MIGRATIONS;
    const files = (await readdir(migrationDir)).filter((f) => f.endsWith('.sql')).sort();
    const migration = (await Promise.all(files.map((f) => readFile(path.join(migrationDir, f), 'utf8')))).join('\n');

    await db.exec(STUB);
    await db.exec(migration);
    await db.exec(migration); // running it again must change nothing and fail nothing
    await db.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)', [A, 'a@example.test', B, 'b@example.test']);

    // ---- helpers: act as a role, the way PostgREST does for each request
    const as = async (role, uid = null) => {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claims', $1, false)", [uid ? JSON.stringify({ sub: uid, role }) : '']);
      await db.exec(`set role ${role}`);
    };
    const admin = () => db.exec('reset role');
    const put = async (docs) => (await db.query('select public.cs_put_docs($1::jsonb) as r', [JSON.stringify(docs)])).rows[0].r;
    const list = async (since = null, afterKey = null, limit = 200) => (await db.query('select key, value, deleted, rev, updated_at::text as updated_at from public.cs_list_docs($1::timestamptz, $2, $3)', [since, afterKey, limit])).rows;
    const get = async (keys) => (await db.query('select key, value, deleted, rev from public.cs_get_docs($1::text[])', [keys])).rows;
    const fails = async (promise, pattern) => assert.rejects(promise, (err) => { assert.match(String(err.message), pattern); return true; });
    const rowsOf = async (sql, params) => (await db.query(sql, params)).rows;
    const withoutTrigger = async (fn) => {
      await admin();
      await db.exec('alter table public.cs_docs disable trigger cs_docs_before_write');
      try { await fn(); } finally { await db.exec('alter table public.cs_docs enable trigger cs_docs_before_write'); }
    };

    const revs = {}; // the revision each test last saw, so later tests can build on it

    await test('writes use optimistic concurrency, and every conflict is reported rather than overwritten', async () => {
      await as('authenticated', A);
      const [first] = await put([{ key: 'skills.p1', value: { 1: 3 }, base_rev: 0 }]);
      assert.equal(first.ok, true);
      assert.ok(Number.isSafeInteger(first.rev) && first.rev > 0); // revisions travel as JSON numbers, so they must stay exact in JavaScript
      assert.deepEqual(await put([{ key: 'skills.p1', value: { 1: 9 }, base_rev: 0 }]), [{ key: 'skills.p1', ok: false, conflict: true }]);
      const [second] = await put([{ key: 'skills.p1', value: { 1: 4 }, base_rev: first.rev }]);
      assert.equal(second.ok, true);
      assert.ok(second.rev > first.rev);
      assert.deepEqual(await put([{ key: 'skills.p1', value: { 1: 5 }, base_rev: first.rev }]), [{ key: 'skills.p1', ok: false, conflict: true }]);
      assert.deepEqual((await get(['skills.p1']))[0].value, { 1: 4 });
      revs.skills = second.rev;
    });

    await test('deletions leave a marker; a document can come back; a document the cloud lost is a conflict, not an error', async () => {
      await as('authenticated', A);
      const [gone] = await put([{ key: 'skills.p1', value: null, deleted: true, base_rev: revs.skills }]);
      assert.equal(gone.ok, true);
      assert.ok(gone.rev > revs.skills);
      const [tomb] = await list();
      assert.equal(tomb.key, 'skills.p1');
      assert.equal(tomb.deleted, true);
      assert.equal(tomb.value, null);
      const [back] = await put([{ key: 'skills.p1', value: { 2: 2 }, base_rev: gone.rev }]);
      assert.equal(back.ok, true);
      assert.ok(back.rev > gone.rev);
      assert.deepEqual(await put([{ key: 'guide.p1', value: { read: {} }, base_rev: back.rev }]), [{ key: 'guide.p1', ok: false, conflict: true }]);
      assert.deepEqual(await put([{ key: 'never.existed', deleted: true, base_rev: 0 }]), [{ key: 'never.existed', ok: true, rev: 0 }]);
      assert.equal((await get(['never.existed'])).length, 0);
      revs.skills = back.rev;
    });

    await test('a revision number is never used twice for a document, even when the row is deleted and created again', async () => {
      await as('authenticated', A);
      const seen = [];
      let base = 0;
      for (let i = 0; i < 6; i += 1) {
        const [r] = await put([{ key: 'cycle.doc', value: { i }, base_rev: base }]);
        assert.equal(r.ok, true);
        assert.ok(!seen.includes(r.rev), `revision ${r.rev} was used before`);
        seen.push(r.rev);
        base = r.rev;
        if (i % 2 === 1) { // the whole row disappears, as it does after "Delete my cloud data", and is created again later
          await admin();
          await db.query("delete from public.cs_docs where key = 'cycle.doc' and user_id = $1", [A]);
          await as('authenticated', A);
          base = 0;
        }
      }
      const [current] = await put([{ key: 'cycle.doc', value: { current: true }, base_rev: 0 }]);
      assert.equal(current.ok, true);
      assert.ok(!seen.includes(current.rev));
      // a revision another device remembers from before the row was recreated can no longer be mistaken for the current one
      for (const old of seen) assert.deepEqual(await put([{ key: 'cycle.doc', value: { stale: true }, base_rev: old }]), [{ key: 'cycle.doc', ok: false, conflict: true }]);
      assert.deepEqual((await get(['cycle.doc']))[0].value, { current: true });
    });

    await test('one bad document does not block the others, and bad requests are refused', async () => {
      await as('authenticated', A);
      const out = await put([
        { key: 'bad key!', value: {}, base_rev: 0 },
        { key: 'ok.one', value: { a: 1 }, base_rev: 0 },
        { key: 'no.value', base_rev: 0 },
        { key: 'null.value', value: null, base_rev: 0 },
        { key: 'ok.two', value: [1, 2], base_rev: 0 },
        { key: 'x'.repeat(101), value: {}, base_rev: 0 },
        { key: 'neg.base', value: {}, base_rev: -1 },
      ]);
      assert.deepEqual(out.map((r) => [r.key, r.ok]), [['bad key!', false], ['ok.one', true], ['no.value', false], ['null.value', false], ['ok.two', true], ['x'.repeat(101), false], ['neg.base', false]]);
      await fails(put({ not: 'an array' }), /array/);
      await fails(put(Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, value: {}, base_rev: 0 }))), /at most 100/);
    });

    await test('a document over 256 KB is refused per document', async () => {
      await as('authenticated', A);
      const [r] = await put([{ key: 'huge', value: { s: 'x'.repeat(270000) }, base_rev: 0 }]);
      assert.equal(r.ok, false);
      assert.match(r.error, /256 KB/);
    });

    await test('people cannot see or change each other\'s documents, through the functions or the table', async () => {
      await as('authenticated', B);
      assert.deepEqual(await list(), []);
      assert.deepEqual(await get(['skills.p1', 'ok.one']), []);
      const [mine] = await put([{ key: 'skills.p1', value: { 1: 1 }, base_rev: 0 }]); // B's own copy, independent of A's
      assert.equal(mine.ok, true);
      assert.equal((await rowsOf('select count(*)::int as n from public.cs_docs'))[0].n, 1);
      assert.equal((await db.query("update public.cs_docs set value = '{\"hacked\":true}' where user_id = $1", [A])).affectedRows, 0);
      assert.equal((await db.query('delete from public.cs_docs where user_id = $1', [A])).affectedRows, 0);
      await fails(db.query("insert into public.cs_docs (user_id, key, value) values ($1, 'planted', '{}')", [A]), /row-level security/);
      await fails(db.query("update public.cs_docs set user_id = $1 where user_id = $2", [A, B]), /row-level security|cannot be changed/);
      await fails(db.query("update public.cs_docs set key = 'renamed' where user_id = $1", [B]), /cannot be changed/);
      await as('authenticated', A);
      assert.deepEqual((await get(['skills.p1']))[0].value, { 2: 2 }); // untouched by B
    });

    await test('signed-out visitors can only ping', async () => {
      await as('anon');
      assert.match((await rowsOf('select public.cs_ping() as t'))[0].t, /^\d{4}-/);
      // Each layer is checked on its own: the function grants, and (separately) the table grants.
      await fails(db.query('select * from public.cs_list_docs()'), /permission denied for function cs_list_docs/);
      await fails(db.query("select * from public.cs_get_docs(array['x'])"), /permission denied for function cs_get_docs/);
      await fails(db.query("select public.cs_put_docs('[]'::jsonb)"), /permission denied for function cs_put_docs/);
      await fails(db.query('select public.cs_delete_my_data()'), /permission denied for function cs_delete_my_data/);
      await fails(db.query('select public.cs_delete_my_account()'), /permission denied for function cs_delete_my_account/);
      await fails(db.query('select * from public.cs_docs'), /permission denied for table cs_docs/);
      await fails(db.query("insert into public.cs_docs (user_id, key, value) values ($1, 'x', '{}')", [A]), /permission denied for table cs_docs/);
    });

    await test('a signed-in role without a user id (a malformed token) is refused', async () => {
      await as('authenticated');
      await fails(put([{ key: 'k', value: {}, base_rev: 0 }]), /not signed in/);
      await fails(db.query('select public.cs_delete_my_data()'), /not signed in/);
      assert.deepEqual(await list(), []);
    });

    await test('the trigger function cannot be called directly', async () => {
      await as('authenticated', A);
      await fails(db.query('select public.cs_docs_before_write()'), /permission denied|trigger functions can only be called as triggers/);
    });

    await test('paging returns every document exactly once, even when many share a timestamp', async () => {
      await admin();
      await db.query('delete from public.cs_docs where user_id = $1', [A]);
      await as('authenticated', A);
      await put(Array.from({ length: 9 }, (_, i) => ({ key: `page.${String(i).padStart(2, '0')}`, value: { i }, base_rev: 0 })));
      await withoutTrigger(() => db.query("update public.cs_docs set updated_at = case when key < 'page.05' then '2026-01-01T00:00:00Z'::timestamptz else '2026-01-02T00:00:00Z'::timestamptz end where user_id = $1", [A]));
      await as('authenticated', A);
      const seen = [];
      let since = null;
      let afterKey = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await list(since, afterKey, 2);
        seen.push(...page.map((r) => r.key));
        if (page.length < 2) break;
        since = page.at(-1).updated_at;
        afterKey = page.at(-1).key;
      }
      assert.deepEqual(seen, Array.from({ length: 9 }, (_, i) => `page.${String(i).padStart(2, '0')}`));
      assert.equal((await list('2026-01-01T00:00:00Z', null, 200)).length, 4); // strictly newer than "since", as the app's overlap expects
      assert.equal((await list(null, null, 1000)).length, 9); // the page size is capped, never unbounded
    });

    await test('a lookup by key answers for at most 100 keys', async () => {
      await admin();
      await db.query('delete from public.cs_docs where user_id = $1', [A]);
      await as('authenticated', A);
      await db.query("insert into public.cs_docs (key, value) select 'look.' || g, '{}'::jsonb from generate_series(1, 120) g");
      const keys = Array.from({ length: 120 }, (_, i) => `look.${i + 1}`);
      assert.equal((await get(keys)).length, 100);
      assert.equal((await get(keys.slice(0, 40))).length, 40);
      await admin();
      await db.query('delete from public.cs_docs where user_id = $1', [A]);
    });

    await test('the document count and storage limits hold', async () => {
      await admin();
      await db.query('delete from public.cs_docs where user_id = $1', [A]);
      await as('authenticated', A);
      await db.query("insert into public.cs_docs (key, value) select 'bulk.' || g, '{}'::jsonb from generate_series(1, 1000) g");
      const [over] = await put([{ key: 'one.too.many', value: {}, base_rev: 0 }]);
      assert.match(over.error, /document limit/);
      const [bulk1] = await get(['bulk.1']);
      assert.equal((await put([{ key: 'bulk.1', value: { updated: true }, base_rev: Number(bulk1.rev) }]))[0].ok, true); // changing an existing one is still fine
      await admin();
      await db.query('delete from public.cs_docs where user_id = $1', [A]);
      await as('authenticated', A);
      const chunk = 'x'.repeat(200000);
      let accepted = 0;
      let refused = null;
      for (let i = 0; i < 140 && !refused; i += 1) {
        const [r] = await put([{ key: `big.${i}`, value: { chunk }, base_rev: 0 }]);
        if (r.ok) accepted += 1; else refused = r;
      }
      assert.ok(accepted >= 120 && accepted <= 132, `accepted ${accepted}`);
      assert.match(refused.error, /storage limit/);
      await admin();
      await db.query('delete from public.cs_docs where user_id = $1', [A]);
    });

    await test('deletion markers do not use up the allowance of 1000 live documents', async () => {
      await admin();
      await db.query('delete from public.cs_docs where user_id = $1', [A]);
      await as('authenticated', A);
      await db.query("insert into public.cs_docs (key, value) select 'live.' || g, '{}'::jsonb from generate_series(1, 1000) g");
      const keys = Array.from({ length: 50 }, (_, i) => `live.${i + 1}`);
      const before = await get(keys);
      const deleted = await put(before.map((r) => ({ key: r.key, value: null, deleted: true, base_rev: Number(r.rev) })));
      assert.ok(deleted.every((r) => r.ok), 'the markers were written');
      assert.equal((await rowsOf('select count(*)::int as n from public.cs_docs where deleted'))[0].n, 50);
      // 950 live documents and 50 markers: there is room for 50 more live documents
      const added = await put(Array.from({ length: 50 }, (_, i) => ({ key: `fresh.${i}`, value: { i }, base_rev: 0 })));
      assert.ok(added.every((r) => r.ok), `added: ${JSON.stringify(added.filter((r) => !r.ok))}`);
      // now the allowance is used up: a new document is refused, and so is bringing a deleted one back
      const [over] = await put([{ key: 'one.too.many', value: {}, base_rev: 0 }]);
      assert.match(over.error, /document limit/);
      const [marker] = await get(['live.1']);
      const [revive] = await put([{ key: 'live.1', value: { back: true }, base_rev: Number(marker.rev) }]);
      assert.match(revive.error, /document limit/);
      // deleting makes room again
      const [fresh0] = await get(['fresh.0']);
      assert.equal((await put([{ key: 'fresh.0', value: null, deleted: true, base_rev: Number(fresh0.rev) }]))[0].ok, true);
      assert.equal((await put([{ key: 'live.1', value: { back: true }, base_rev: Number(marker.rev) }]))[0].ok, true);
    });

    await test('the total number of rows, markers included, is capped, and old markers are trimmed to the newest 1000', async () => {
      await admin();
      await db.query('delete from public.cs_docs where user_id = $1', [A]);
      await withoutTrigger(() => db.query(
        "insert into public.cs_docs (user_id, key, value, deleted, rev, updated_at) select $1, 'marker.' || g, null, true, 1, now() - make_interval(secs => g) from generate_series(1, 3000) g",
        [A],
      ));
      await as('authenticated', A);
      // someone writing to the table directly, around the functions, cannot grow it without limit
      await fails(db.query("insert into public.cs_docs (key, value) values ('direct.one', '{}')"), /too many stored documents/);
      // the app's own requests trim the oldest markers first, so they keep working
      const [ok] = await put([{ key: 'normal.use', value: {}, base_rev: 0 }]);
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal((await rowsOf('select count(*)::int as n from public.cs_docs where deleted'))[0].n, 1000);
      const newest = (await rowsOf("select count(*)::int as n from public.cs_docs where deleted and key in (select 'marker.' || g from generate_series(1, 1000) g)"))[0].n;
      assert.equal(newest, 1000); // the markers that were kept are the 1000 newest ones
      await admin();
      await db.query('delete from public.cs_docs where user_id = $1', [A]);
    });

    await test('old deletion markers are cleaned up, recent ones are kept', async () => {
      await as('authenticated', A);
      const made = await put([{ key: 'old.gone', value: {}, base_rev: 0 }, { key: 'new.gone', value: {}, base_rev: 0 }]);
      await put([{ key: 'old.gone', deleted: true, base_rev: made[0].rev }, { key: 'new.gone', deleted: true, base_rev: made[1].rev }]);
      await withoutTrigger(() => db.query("update public.cs_docs set updated_at = now() - interval '91 days' where key = 'old.gone' and user_id = $1", [A]));
      await as('authenticated', A);
      await put([{ key: 'trigger.cleanup', value: {}, base_rev: 0 }]);
      const keys = (await list()).map((r) => r.key);
      assert.ok(!keys.includes('old.gone'));
      assert.ok(keys.includes('new.gone'));
    });

    await test('deleting my data removes only my documents', async () => {
      await as('authenticated', B);
      assert.equal((await list()).length, 1);
      await as('authenticated', A);
      const n = (await rowsOf('select public.cs_delete_my_data() as n'))[0].n;
      assert.ok(n >= 1);
      assert.deepEqual(await list(), []);
      await as('authenticated', B);
      assert.equal((await list()).length, 1);
    });

    await test('deleting my account removes the account and its documents, and nobody else\'s', async () => {
      await as('authenticated', A);
      await put([{ key: 'goodbye', value: {}, base_rev: 0 }]);
      assert.equal((await rowsOf('select public.cs_delete_my_account() as ok'))[0].ok, true);
      await admin();
      assert.equal((await rowsOf('select count(*)::int as n from auth.users where id = $1', [A]))[0].n, 0);
      assert.equal((await rowsOf('select count(*)::int as n from public.cs_docs where user_id = $1', [A]))[0].n, 0);
      assert.equal((await rowsOf('select count(*)::int as n from auth.users where id = $1', [B]))[0].n, 1);
      assert.equal((await rowsOf('select count(*)::int as n from public.cs_docs where user_id = $1', [B]))[0].n, 1);
    });

    await test('the account-deletion function refuses a caller without a user id, and removes exactly the caller', async () => {
      await as('authenticated');
      await fails(db.query('select public.cs_delete_my_account()'), /not signed in/);
      await as('authenticated', B);
      assert.equal((await rowsOf('select public.cs_delete_my_account() as ok'))[0].ok, true);
      await admin();
      assert.equal((await rowsOf('select count(*)::int as n from auth.users'))[0].n, 0);
      assert.equal((await rowsOf('select count(*)::int as n from public.cs_docs'))[0].n, 0);
    });

    await admin();
    await db.close();
  } finally {
    if (!REUSE_DIR) await rm(work, { recursive: true, force: true });
  }

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (!r.ok) { failed += 1; console.log(`      ${String(r.err?.message ?? r.err).split('\n').join('\n      ')}`); }
  }
  console.log(`\n${results.length - failed} of ${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
