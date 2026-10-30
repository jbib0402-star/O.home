-- ============================================================
-- O.HOME 서버 스키마 (Supabase)
-- 공개 홈 + Firebase → Supabase 이전 호환 버전
-- 여러 번 실행해도 안전합니다.
-- ============================================================

create schema if not exists private;

-- ── 1. 회원 프로필 ───────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  avatar_url text,
  avatar_color text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.invite_codes (
  code text primary key,
  created_at timestamptz not null default now(),
  used_by uuid references auth.users(id),
  used_at timestamptz
);

create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ── 2. 관리자 판별 / 가입 트리거 ─────────────────────────────
-- SECURITY DEFINER 함수는 Data API에 노출되는 public이 아니라 private에 둔다.
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  )
$$;

revoke all on function private.is_admin() from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.is_admin() to anon, authenticated;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare existing int;
begin
  select count(*) into existing from public.profiles;
  insert into public.profiles (id, nickname, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nickname', split_part(new.email, '@', 1)),
    case when existing = 0 then 'admin' else 'member' end
  );
  return new;
end
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ── 3. 콘텐츠 테이블 ─────────────────────────────────────────
-- author_id는 text로 둔다.
-- Supabase Auth UUID뿐 아니라 Firebase에서 이전한 기존 UID도 그대로 보존하기 위함.
do $$
declare t text;
declare content_tables text[] := array[
  'posts',
  'guestbook',
  'characters',
  'relations',
  'gallery',
  'roadview',
  'trpg_logs',
  'trpg_log_bodies',
  'trpg_chars',
  'dotori',
  'playlog',
  'rp_rooms',
  'rp_messages',
  'threads',
  'diary',
  'memos',
  'commissions',
  'applicants',
  'moods',
  'comments',
  'qa_answers'
];
begin
  foreach t in array content_tables loop
    execute format($f$
      create table if not exists public.%I (
        id          text primary key,
        data        jsonb not null default '{}'::jsonb,
        author_id   text,
        visibility  text not null default 'public',
        editor_ids  text[] not null default '{}',
        sort        double precision not null default 0,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now()
      )$f$, t);

    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "insert" on public.%I', t);
    execute format('drop policy if exists "update" on public.%I', t);
    execute format('drop policy if exists "delete" on public.%I', t);

    begin
      execute format('alter table public.%I drop constraint if exists %I', t, t || '_author_id_fkey');
    exception when others then null;
    end;

    execute format('alter table public.%I alter column author_id type text using author_id::text', t);
    execute format('alter table public.%I add column if not exists editor_ids text[] not null default ''{}''', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create index if not exists %I on public.%I (sort)', t || '_sort_idx', t);
    execute format('create index if not exists %I on public.%I (author_id)', t || '_author_idx', t);

    execute format($p$
      create policy "read" on public.%I
      for select to anon, authenticated
      using (
        visibility = 'public'
        or (visibility = 'member' and (select auth.uid()) is not null)
        or author_id = (select auth.uid())::text
        or (select auth.uid())::text = any(editor_ids)
        or (select private.is_admin())
      )$p$, t);

    execute format($p$
      create policy "insert" on public.%I
      for insert to authenticated
      with check (
        author_id is null
        or author_id = (select auth.uid())::text
        or (select private.is_admin())
      )$p$, t);

    execute format($p$
      create policy "update" on public.%I
      for update to authenticated
      using (
        author_id = (select auth.uid())::text
        or (select auth.uid())::text = any(editor_ids)
        or (select private.is_admin())
      )
      with check (
        author_id = (select auth.uid())::text
        or (select auth.uid())::text = any(editor_ids)
        or (select private.is_admin())
      )$p$, t);

    execute format($p$
      create policy "delete" on public.%I
      for delete to authenticated
      using (
        author_id = (select auth.uid())::text
        or (select private.is_admin())
      )$p$, t);

    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('grant insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- 방명록은 비로그인 방문자도 작성 가능.
drop policy if exists "insert" on public.guestbook;
create policy "insert" on public.guestbook
for insert to anon, authenticated
with check (true);

-- ── 4. 프로필 / 설정 권한 ───────────────────────────────────
alter table public.profiles enable row level security;
alter table public.invite_codes enable row level security;
alter table public.site_settings enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
for select to anon, authenticated
using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
for update to authenticated
using ((select auth.uid()) = id or (select private.is_admin()))
with check ((select auth.uid()) = id or (select private.is_admin()));

drop policy if exists "profiles_delete_admin" on public.profiles;
create policy "profiles_delete_admin" on public.profiles
for delete to authenticated
using ((select private.is_admin()));

drop policy if exists "invite_select" on public.invite_codes;
create policy "invite_select" on public.invite_codes
for select to anon, authenticated
using (true);

drop policy if exists "invite_write" on public.invite_codes;
create policy "invite_write" on public.invite_codes
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

drop policy if exists "invite_use" on public.invite_codes;
create policy "invite_use" on public.invite_codes
for update to anon, authenticated
using (used_by is null)
with check (used_by is not null);

drop policy if exists "settings_select" on public.site_settings;
create policy "settings_select" on public.site_settings
for select to anon, authenticated
using (true);

drop policy if exists "settings_write" on public.site_settings;
create policy "settings_write" on public.site_settings
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

grant select on public.profiles, public.invite_codes, public.site_settings to anon, authenticated;
grant insert, update, delete on public.profiles, public.invite_codes, public.site_settings to authenticated;

-- ── 5. 이미지 저장소 ─────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('ohome', 'ohome', true)
on conflict (id) do update set public = true;

drop policy if exists "ohome_read" on storage.objects;
create policy "ohome_read" on storage.objects
for select to anon, authenticated
using (bucket_id = 'ohome');

drop policy if exists "ohome_write" on storage.objects;
create policy "ohome_write" on storage.objects
for insert to authenticated
with check (bucket_id = 'ohome');

drop policy if exists "ohome_update" on storage.objects;
create policy "ohome_update" on storage.objects
for update to authenticated
using (
  bucket_id = 'ohome'
  and (owner_id = (select auth.uid()::text) or (select private.is_admin()))
)
with check (
  bucket_id = 'ohome'
  and (owner_id = (select auth.uid()::text) or (select private.is_admin()))
);

drop policy if exists "ohome_delete" on storage.objects;
create policy "ohome_delete" on storage.objects
for delete to authenticated
using (
  bucket_id = 'ohome'
  and (owner_id = (select auth.uid()::text) or (select private.is_admin()))
);

-- 자동 RLS를 켜고 프로젝트를 만든 경우 생성되는 public 함수는 RPC로 노출하지 않는다.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

-- 예전 스키마에서 public에 만들었던 함수가 있다면 제거.
drop function if exists public.is_admin();
drop function if exists public.handle_new_user();

-- ── 6. Realtime ──────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['rp_rooms', 'rp_messages', 'relations', 'posts', 'guestbook'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
