-- OurSpending — multi-user / multi-household migration.
--
-- SAFETY: additive only. No table is dropped, no row is deleted, no historical
-- expense value is rewritten. Existing households keep working untouched:
-- every new column is nullable or has a backwards-compatible default, and a
-- household with no category rows behaves exactly as before (all built-ins on).
--
-- Run once: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- Then run supabase/verify_rls.sql, which proves the guarantees below.

-- ============================================================
--  1. Per-user preferences on profiles
-- ============================================================
alter table public.profiles
  add column if not exists preferred_currency text not null default 'EUR',
  add column if not exists color text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_preferred_currency_check'
  ) then
    alter table public.profiles
      add constraint profiles_preferred_currency_check
      check (preferred_currency in ('EUR', 'USD', 'COP'));
  end if;
end $$;

-- Colour for the "shared" bucket lives on the household.
alter table public.households
  add column if not exists shared_color text;

-- ============================================================
--  2. Household membership is assigned ONLY by trusted functions
-- ============================================================
-- Membership (household_id + slot) decides which household's data you can
-- read, so it must never be writable through an ordinary profile update or
-- insert. Two independent layers enforce that:
--
--   Layer 1 (privileges) — column-level GRANTs below mean the `authenticated`
--   role simply has no UPDATE/INSERT right on household_id or slot. This is
--   checked before RLS and cannot be re-opened by a policy mistake.
--
--   Layer 2 (trigger) — the guard below refuses any change to household_id or
--   slot unless a transaction-local flag is set, and only create_household()
--   and join_household() set it. This still holds if a future migration
--   re-grants the columns by accident.
--
-- SECURITY DEFINER functions run as the function owner (postgres), which keeps
-- full column privileges and owns the table, so they are unaffected by both
-- layers and remain the only way in.

create or replace function public.guard_household_assignment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Trusted path: create_household() / join_household() set this flag, scoped
  -- to their own transaction. PostgREST clients cannot call set_config(),
  -- because it lives in pg_catalog and is not exposed over the API.
  if coalesce(current_setting('app.household_assign', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Closes the sign-up hole: a brand-new user creating their own profile row
    -- must not be able to pre-set membership and land inside someone else's
    -- household without ever presenting an invite code.
    if new.household_id is not null or new.slot is not null then
      raise exception 'household_assignment_forbidden'
        using hint = 'Use create_household() or join_household().';
    end if;
    return new;
  end if;

  -- Closes the null -> any-UUID hole, and also pins slot: silently swapping
  -- slot 0/1 would re-attribute every past private expense of both members.
  if new.household_id is distinct from old.household_id
     or new.slot is distinct from old.slot then
    raise exception 'household_assignment_forbidden'
      using hint = 'Use create_household() or join_household().';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_single_household on public.profiles;   -- superseded
drop trigger if exists profiles_guard_household on public.profiles;
create trigger profiles_guard_household
  before insert or update on public.profiles
  for each row execute function public.guard_household_assignment();

-- The earlier, weaker guard is no longer referenced by any trigger.
drop function if exists public.enforce_single_household();

-- Two members must never occupy the same slot (that would merge their
-- private expenses). Created only if current data allows it.
do $$
declare dupes int;
begin
  select count(*) into dupes from (
    select household_id, slot
    from public.profiles
    where household_id is not null and slot is not null
    group by household_id, slot having count(*) > 1
  ) d;
  if dupes = 0 then
    create unique index if not exists profiles_household_slot_unique
      on public.profiles (household_id, slot)
      where household_id is not null and slot is not null;
  else
    raise notice 'Skipped profiles_household_slot_unique: % duplicate slot(s) found. Resolve manually.', dupes;
  end if;
end $$;

-- ============================================================
--  3. Household category configuration
-- ============================================================
-- Built-in categories stay defined in the app (stable ids such as 'groceries').
-- This table only stores per-household *configuration* plus custom categories,
-- so no built-in is duplicated per household and historical expense.category
-- values keep resolving.
--
-- Backwards compatible by design: zero rows for a household == every built-in
-- category active, which is exactly the pre-migration behaviour. That is also
-- how a brand-new household starts: with the complete built-in set, without a
-- single row being written.
--
-- Rows are sparse — one exists only where a household actually deviates:
--   is_custom = false  -> an override of a built-in. label/icon override the
--                         app's default for THIS household only; the built-in
--                         definition is global and never mutated, and
--                         category_key stays the stable key that historical
--                         expenses reference. A row whose override is undone
--                         is deleted rather than kept, so the table keeps
--                         holding only real differences.
--   is_custom = true   -> a category this household invented.
-- active = false (plus archived_at for custom rows) is the archive state used
-- when a category that has history is "removed".
create table if not exists public.household_categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  category_key text not null,
  is_custom boolean not null default false,
  label text,
  icon text,
  active boolean not null default true,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, category_key),
  constraint household_categories_custom_needs_label
    check (not is_custom or (label is not null and length(btrim(label)) > 0))
);

create index if not exists household_categories_household_idx
  on public.household_categories (household_id);

alter table public.household_categories enable row level security;

-- Explicit table grants: a newly created table only inherits privileges if the
-- project has ALTER DEFAULT PRIVILEGES configured. Granting here makes the
-- migration self-contained. RLS still decides which rows are visible.
grant select, insert, update, delete on public.household_categories to authenticated;
grant all on public.household_categories to service_role;

drop trigger if exists household_categories_touch on public.household_categories;
create trigger household_categories_touch
  before update on public.household_categories
  for each row execute function public.touch_updated_at();

-- ============================================================
--  4. Secure household create / join
-- ============================================================
-- These run SECURITY DEFINER so the households table never needs a permissive
-- SELECT policy just to look up an invite code. All guards live server-side.
create or replace function public.create_household(p_name text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_current uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select household_id into v_current from profiles where id = auth.uid();
  if v_current is not null then raise exception 'already_in_household'; end if;

  insert into households (name) values (coalesce(nullif(btrim(p_name), ''), 'Our household'))
  returning id into v_id;

  -- 12 hex chars (48 bits). Works whether or not the column has a default.
  update households
     set invite_code = encode(gen_random_bytes(6), 'hex')
   where id = v_id and (invite_code is null or btrim(invite_code) = '');

  -- Open the guarded path for this transaction only.
  perform set_config('app.household_assign', 'on', true);
  update profiles set household_id = v_id, slot = 0 where id = auth.uid();
  perform set_config('app.household_assign', 'off', true);

  return v_id;
end;
$$;

create or replace function public.join_household(p_code text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_current uuid;
  v_slot int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select household_id into v_current from profiles where id = auth.uid();
  if v_current is not null then raise exception 'already_in_household'; end if;

  if p_code is null or length(btrim(p_code)) < 4 then
    raise exception 'invalid_code';
  end if;

  select id into v_id from households
   where lower(btrim(invite_code)) = lower(btrim(p_code));
  if v_id is null then raise exception 'invalid_code'; end if;

  -- Expenses model members as slot 0 / slot 1, so a household holds two people.
  -- Lock the household row so two people racing the same code cannot both be
  -- handed the last free slot.
  perform 1 from households where id = v_id for update;

  select min(s) into v_slot
    from (select generate_series(0, 1) as s) g
   where not exists (
     select 1 from profiles p where p.household_id = v_id and p.slot = g.s
   );
  if v_slot is null then raise exception 'household_full'; end if;

  perform set_config('app.household_assign', 'on', true);
  update profiles set household_id = v_id, slot = v_slot where id = auth.uid();
  perform set_config('app.household_assign', 'off', true);

  return v_id;
end;
$$;

revoke all on function public.create_household(text) from public, anon;
revoke all on function public.join_household(text) from public, anon;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;

-- ============================================================
--  5. Column-level privileges (layer 1 of the membership guard)
-- ============================================================
-- The client only ever writes these columns; see the app's profile and
-- household update calls. Everything else — household_id, slot, invite_code,
-- id, created_at — is withheld from the API roles entirely.
revoke insert, update on public.profiles from authenticated, anon;
grant insert (id, display_name, preferred_currency, color) on public.profiles to authenticated;
grant update (display_name, preferred_currency, color)     on public.profiles to authenticated;

-- Members configure their household's rates, source, name and shared colour.
-- invite_code is deliberately excluded: rotating it is not a feature, and a
-- writable invite code is an easy way to lock a partner out or to squat a
-- guessable code.
revoke insert, update on public.households from authenticated, anon;
grant update (name, shared_color, usd_per_eur, cop_per_eur, rates_updated_at, rate_source)
  on public.households to authenticated;
-- No INSERT grant: households are created exclusively by create_household().

-- ============================================================
--  6. Row Level Security — canonical, household-scoped
-- ============================================================
-- Legacy policies are cleared first so no forgotten over-permissive rule can
-- survive (policies are OR'd, so an old broad policy would silently widen
-- access). This changes access rules only; it never touches data.
create or replace function public.my_household()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select household_id from public.profiles where id = auth.uid()
$$;
revoke all on function public.my_household() from public, anon;
grant execute on function public.my_household() to authenticated;

do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles', 'households', 'expenses', 'budgets', 'household_categories')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table public.profiles   enable row level security;
alter table public.households enable row level security;
alter table public.expenses   enable row level security;
alter table public.budgets    enable row level security;

-- --- profiles -------------------------------------------------
-- Read yourself, plus the members of your own household (needed for names,
-- slots and colours). Never anyone else.
create policy "profiles: read self or household" on public.profiles
  for select using (
    id = auth.uid()
    or (household_id is not null and household_id = public.my_household())
  );

-- Belt and braces alongside the column grants and the trigger: a profile is
-- always born without membership.
create policy "profiles: insert self without membership" on public.profiles
  for insert with check (
    id = auth.uid() and household_id is null and slot is null
  );

-- You may only ever edit your own row, and only the columns granted above.
create policy "profiles: update self" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- --- households -----------------------------------------------
create policy "households: read own" on public.households
  for select using (id = public.my_household());

-- No INSERT policy on purpose: create_household() is the only entry point,
-- and it runs as owner. A direct insert policy would let any signed-in user
-- create unlimited orphan households they cannot even read.

create policy "households: update own" on public.households
  for update using (id = public.my_household())
  with check (id = public.my_household());

-- --- expenses -------------------------------------------------
create policy "expenses: read own household" on public.expenses
  for select using (household_id = public.my_household());
create policy "expenses: insert own household" on public.expenses
  for insert with check (household_id = public.my_household());
create policy "expenses: update own household" on public.expenses
  for update using (household_id = public.my_household())
  with check (household_id = public.my_household());
create policy "expenses: delete own household" on public.expenses
  for delete using (household_id = public.my_household());

-- --- budgets --------------------------------------------------
create policy "budgets: read own household" on public.budgets
  for select using (household_id = public.my_household());
create policy "budgets: insert own household" on public.budgets
  for insert with check (household_id = public.my_household());
create policy "budgets: update own household" on public.budgets
  for update using (household_id = public.my_household())
  with check (household_id = public.my_household());
create policy "budgets: delete own household" on public.budgets
  for delete using (household_id = public.my_household());

-- --- household_categories ------------------------------------
-- Every member may manage their household's categories; no admin role.
create policy "categories: read own household" on public.household_categories
  for select using (household_id = public.my_household());
create policy "categories: insert own household" on public.household_categories
  for insert with check (household_id = public.my_household());
create policy "categories: update own household" on public.household_categories
  for update using (household_id = public.my_household())
  with check (household_id = public.my_household());
create policy "categories: delete own household" on public.household_categories
  for delete using (household_id = public.my_household());

-- Realtime for category changes between both members.
do $$
begin
  begin
    alter publication supabase_realtime add table public.household_categories;
  exception when duplicate_object then null;
  end;
end $$;

-- ============================================================
--  7. Verification (read-only — safe to run any time)
-- ============================================================
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public' order by tablename, policyname;
--
-- Which columns may the API roles actually write?
-- select grantee, table_name, column_name, privilege_type
--   from information_schema.column_privileges
--  where table_schema = 'public'
--    and table_name in ('profiles','households')
--    and grantee in ('authenticated','anon')
--  order by grantee, table_name, privilege_type, column_name;
