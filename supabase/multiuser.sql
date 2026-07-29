-- OurSpending — multi-user / multi-household migration.
--
-- SAFETY: additive only. No table is dropped, no row is deleted, no historical
-- expense value is rewritten. Existing households keep working untouched:
-- every new column is nullable or has a backwards-compatible default, and a
-- household with no category rows behaves exactly as before (all built-ins on).
--
-- Run once: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.

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
--  2. One household per user, one member per slot
-- ============================================================
-- profiles.household_id is single-valued, so a user is structurally incapable
-- of belonging to two households. What we still need to block is silently
-- hopping from one household to another.
create or replace function public.enforce_single_household()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.household_id is not null
     and new.household_id is not null
     and new.household_id <> old.household_id then
    raise exception 'already_in_household'
      using hint = 'Leave the current household before joining another one.';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_single_household on public.profiles;
create trigger profiles_single_household
  before update on public.profiles
  for each row execute function public.enforce_single_household();

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
-- category active, which is exactly the pre-migration behaviour.
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
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_current uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select household_id into v_current from profiles where id = auth.uid();
  if v_current is not null then raise exception 'already_in_household'; end if;

  insert into households (name) values (coalesce(nullif(btrim(p_name), ''), 'Our household'))
  returning id into v_id;

  -- Works whether or not the column already has a default.
  update households
     set invite_code = encode(gen_random_bytes(4), 'hex')
   where id = v_id and (invite_code is null or btrim(invite_code) = '');

  update profiles set household_id = v_id, slot = 0 where id = auth.uid();
  return v_id;
end;
$$;

create or replace function public.join_household(p_code text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_current uuid;
  v_slot int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;

  select household_id into v_current from profiles where id = auth.uid();
  if v_current is not null then raise exception 'already_in_household'; end if;

  select id into v_id from households
   where lower(btrim(invite_code)) = lower(btrim(p_code));
  if v_id is null then raise exception 'invalid_code'; end if;

  -- Expenses model members as slot 0 / slot 1, so a household holds two people.
  select min(s) into v_slot
    from (select generate_series(0, 1) as s) g
   where not exists (
     select 1 from profiles p where p.household_id = v_id and p.slot = g.s
   );
  if v_slot is null then raise exception 'household_full'; end if;

  update profiles set household_id = v_id, slot = v_slot where id = auth.uid();
  return v_id;
end;
$$;

revoke all on function public.create_household(text) from public, anon;
revoke all on function public.join_household(text) from public, anon;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;

-- ============================================================
--  5. Row Level Security — canonical, household-scoped
-- ============================================================
-- Legacy policies are cleared first so no forgotten over-permissive rule can
-- survive (policies are OR'd, so an old broad policy would silently widen
-- access). This changes access rules only; it never touches data.
create or replace function public.my_household()
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.profiles where id = auth.uid()
$$;
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

create policy "profiles: insert self" on public.profiles
  for insert with check (id = auth.uid());

-- You may only ever edit your own row (display name, currency, colour, and the
-- household_id written by the create/join functions).
create policy "profiles: update self" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- --- households -----------------------------------------------
create policy "households: read own" on public.households
  for select using (id = public.my_household());

-- Direct inserts are not needed (create_household does it), but allowing an
-- authenticated user to create a household keeps the flow resilient.
create policy "households: insert authenticated" on public.households
  for insert with check (auth.uid() is not null);

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
--  6. Verification (read-only — safe to run any time)
-- ============================================================
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public' order by tablename, policyname;
--
-- select id, display_name, slot, household_id, preferred_currency, color
--   from public.profiles order by household_id, slot;
