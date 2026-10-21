-- CertStudy cloud sync: one private row per person per synced document.
--
-- Run this whole file once in the Supabase dashboard (SQL Editor > New query > paste > Run). It is safe to run again.
--
-- Security model
--   * Row level security: a signed-in person can only ever read or change their own rows (user_id = auth.uid()).
--   * Signed-out visitors can call only cs_ping(), which returns the time and touches no data.
--   * The app talks to the database only through the cs_* functions below; none of them is SECURITY DEFINER except
--     cs_delete_my_account(), which can delete nothing but the caller's own account.
--   * Limits per person: 1000 documents, 25 MB in total, 256 KB per document. Markers left by deleted documents do not count
--     towards the 1000, are trimmed automatically, and are capped separately (3000 rows in all).

-- ------------------------------------------------------------------ table
create table if not exists public.cs_docs (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  key        text        not null,
  value      jsonb,
  deleted    boolean     not null default false,
  rev        bigint      not null default 1,
  size       integer     not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  constraint cs_docs_pkey primary key (user_id, key),
  constraint cs_docs_key_format check (key ~ '^[A-Za-z0-9._-]{1,100}$'),
  constraint cs_docs_tombstone check ((deleted and value is null) or (not deleted and value is not null)),
  constraint cs_docs_rev_positive check (rev >= 1)
);

-- Safe on a table that was created with the earlier integer column.
alter table public.cs_docs alter column rev type bigint;

comment on table public.cs_docs is 'CertStudy synced documents. key: settings, guide.<pack>, skills.<pack>, qstats.<pack>, history.<pack>, sess.<id>. rev: a number nobody has seen before, assigned on every write and used for optimistic concurrency. deleted rows are markers so other devices learn about deletions.';

create index if not exists cs_docs_user_updated_idx on public.cs_docs (user_id, updated_at, key);

-- ------------------------------------------------------------------ write guard: limits, timestamps, revisions, immutable owner and key
create or replace function public.cs_docs_before_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  live_count integer;
  total_count integer;
  used bigint;
  fresh bigint := (extract(epoch from clock_timestamp()) * 1000000)::bigint;
begin
  if tg_op = 'UPDATE' and (new.user_id <> old.user_id or new.key <> old.key) then
    raise exception 'a document''s owner and key cannot be changed' using errcode = '42501';
  end if;

  -- One writer at a time per person, so two requests that run together cannot both slip under a limit.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 1));

  new.updated_at := clock_timestamp();
  -- Every write gets a revision that was never used before, even when a row is deleted and later created again. Another device that
  -- still remembers an old revision can therefore never mistake a stale copy for the current one. (Updates always move the revision
  -- forward from the row's own previous value. A new row takes the database clock in microseconds, which only repeats an earlier
  -- revision if the server clock were to step backwards onto exactly that microsecond.)
  new.rev := case when tg_op = 'UPDATE' then greatest(fresh, old.rev + 1) else fresh end;
  new.size := case when new.value is null then 0 else octet_length(new.value::text) end;
  if new.size > 262144 then
    raise exception 'document is larger than 256 KB' using errcode = '54000';
  end if;

  if tg_op = 'INSERT' or (old.deleted and not new.deleted) then
    select count(*) filter (where not d.deleted), count(*) into live_count, total_count
      from public.cs_docs d where d.user_id = new.user_id and d.key <> new.key;
    if not new.deleted and live_count >= 1000 then
      raise exception 'document limit reached (1000)' using errcode = '54000';
    end if;
    if tg_op = 'INSERT' and total_count >= 3000 then
      raise exception 'too many stored documents and deletion markers (3000)' using errcode = '54000';
    end if;
  end if;

  select coalesce(sum(d.size), 0) into used from public.cs_docs d where d.user_id = new.user_id and d.key <> new.key;
  if used + new.size > 26214400 then
    raise exception 'storage limit reached (25 MB)' using errcode = '54000';
  end if;
  return new;
end;
$$;

drop trigger if exists cs_docs_before_write on public.cs_docs;
create trigger cs_docs_before_write
  before insert or update on public.cs_docs
  for each row execute function public.cs_docs_before_write();

-- ------------------------------------------------------------------ row level security
alter table public.cs_docs enable row level security;

drop policy if exists cs_docs_select on public.cs_docs;
create policy cs_docs_select on public.cs_docs for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists cs_docs_insert on public.cs_docs;
create policy cs_docs_insert on public.cs_docs for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists cs_docs_update on public.cs_docs;
create policy cs_docs_update on public.cs_docs for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists cs_docs_delete on public.cs_docs;
create policy cs_docs_delete on public.cs_docs for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.cs_docs from public, anon;
grant select, insert, update, delete on public.cs_docs to authenticated;

-- ------------------------------------------------------------------ reading
-- A page of documents changed after (p_since, p_after_key), oldest first. The app pages through with the last row it received.
drop function if exists public.cs_list_docs(timestamptz, text, integer);
create function public.cs_list_docs(p_since timestamptz default null, p_after_key text default null, p_limit integer default 200)
returns table (key text, value jsonb, deleted boolean, rev bigint, updated_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.key, d.value, d.deleted, d.rev, d.updated_at
  from public.cs_docs d
  where d.user_id = (select auth.uid())
    and (p_since is null
         or d.updated_at > p_since
         or (d.updated_at = p_since and p_after_key is not null and d.key > p_after_key))
  order by d.updated_at, d.key
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
$$;

-- Specific documents by key (used to merge after a refused write). Answers for at most 100 keys.
drop function if exists public.cs_get_docs(text[]);
create function public.cs_get_docs(p_keys text[])
returns table (key text, value jsonb, deleted boolean, rev bigint, updated_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.key, d.value, d.deleted, d.rev, d.updated_at
  from public.cs_docs d
  where d.user_id = (select auth.uid())
    and d.key = any (p_keys[1:100])
  order by d.key
$$;

-- ------------------------------------------------------------------ writing
-- p_docs: [{ "key": "...", "value": {...}, "deleted": false, "base_rev": 3 }, ...] (at most 100).
-- A write succeeds only if base_rev is the revision the caller last saw (0 for a document that does not exist yet). Otherwise the
-- result says { conflict: true } and the caller reads the newer copy, merges, and tries again. One bad document never blocks the rest.
-- Returns [{ key, ok, rev }] or [{ key, ok: false, conflict: true }] or [{ key, ok: false, error }].
create or replace function public.cs_put_docs(p_docs jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  item jsonb;
  doc_key text;
  doc_value jsonb;
  doc_deleted boolean;
  base bigint;
  current_rev bigint;
  new_rev bigint;
  results jsonb := '[]'::jsonb;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if jsonb_typeof(p_docs) is distinct from 'array' or jsonb_array_length(p_docs) > 100 then
    raise exception 'p_docs must be an array of at most 100 documents' using errcode = '22023';
  end if;

  -- One writer at a time per person (the write guard takes the same lock), so requests from two devices cannot interleave.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(me::text, 1));

  -- Deletion markers only need to reach the person's other devices once: drop the old ones and keep at most the newest 1000.
  delete from public.cs_docs d
  where d.user_id = me and d.deleted
    and (d.updated_at < now() - interval '90 days'
         or d.key in (select t.key from public.cs_docs t where t.user_id = me and t.deleted order by t.updated_at desc, t.key offset 1000));

  for item in select e.value from jsonb_array_elements(p_docs) e loop
    doc_key := null;
    new_rev := null;
    begin
      doc_key := item ->> 'key';
      doc_deleted := coalesce(item ->> 'deleted', 'false')::boolean;
      doc_value := case when jsonb_typeof(item -> 'value') = 'null' then null else item -> 'value' end;
      base := coalesce(item ->> 'base_rev', '0')::bigint;

      if doc_key is null or doc_key !~ '^[A-Za-z0-9._-]{1,100}$' then
        results := results || jsonb_build_object('key', doc_key, 'ok', false, 'error', 'invalid key');
        continue;
      end if;
      if base < 0 or (not doc_deleted and doc_value is null) then
        results := results || jsonb_build_object('key', doc_key, 'ok', false, 'error', 'invalid document');
        continue;
      end if;

      select d.rev into current_rev from public.cs_docs d where d.user_id = me and d.key = doc_key for update;
      if not found then
        if base <> 0 then
          results := results || jsonb_build_object('key', doc_key, 'ok', false, 'conflict', true);
        elsif doc_deleted then
          results := results || jsonb_build_object('key', doc_key, 'ok', true, 'rev', 0);
        else
          insert into public.cs_docs (user_id, key, value, deleted)
            values (me, doc_key, doc_value, false)
            on conflict (user_id, key) do nothing
            returning rev into new_rev;
          if new_rev is null then
            results := results || jsonb_build_object('key', doc_key, 'ok', false, 'conflict', true);
          else
            results := results || jsonb_build_object('key', doc_key, 'ok', true, 'rev', new_rev);
          end if;
        end if;
      elsif current_rev <> base then
        results := results || jsonb_build_object('key', doc_key, 'ok', false, 'conflict', true);
      else
        update public.cs_docs d
          set value = case when doc_deleted then null else doc_value end, deleted = doc_deleted
          where d.user_id = me and d.key = doc_key
          returning d.rev into new_rev;
        results := results || jsonb_build_object('key', doc_key, 'ok', true, 'rev', new_rev);
      end if;
    exception when others then
      results := results || jsonb_build_object('key', doc_key, 'ok', false, 'error', sqlerrm);
    end;
  end loop;

  return results;
end;
$$;

-- ------------------------------------------------------------------ deleting
-- Removes all of the caller's documents. Returns how many rows were removed.
create or replace function public.cs_delete_my_data()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  removed integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(me::text, 1));
  with gone as (delete from public.cs_docs d where d.user_id = me returning 1)
  select count(*)::integer into removed from gone;
  return removed;
end;
$$;

-- Deletes the caller's account (their sign-in identity and, through the foreign key, all of their documents).
-- This is the only SECURITY DEFINER function. It can only ever delete the account of the person calling it.
create or replace function public.cs_delete_my_account()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  delete from auth.users where id = auth.uid();
  return found;
end;
$$;

-- ------------------------------------------------------------------ keep-alive
-- Free Supabase projects pause after a week without activity. A scheduled call to this function (see .github/workflows) keeps it awake.
create or replace function public.cs_ping()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select now()::text
$$;

-- ------------------------------------------------------------------ who may call what
revoke all on function public.cs_docs_before_write() from public, anon, authenticated;

revoke all on function public.cs_list_docs(timestamptz, text, integer) from public, anon;
revoke all on function public.cs_get_docs(text[]) from public, anon;
revoke all on function public.cs_put_docs(jsonb) from public, anon;
revoke all on function public.cs_delete_my_data() from public, anon;
revoke all on function public.cs_delete_my_account() from public, anon;
revoke all on function public.cs_ping() from public;

grant execute on function public.cs_list_docs(timestamptz, text, integer) to authenticated;
grant execute on function public.cs_get_docs(text[]) to authenticated;
grant execute on function public.cs_put_docs(jsonb) to authenticated;
grant execute on function public.cs_delete_my_data() to authenticated;
grant execute on function public.cs_delete_my_account() to authenticated;
grant execute on function public.cs_ping() to anon, authenticated;
