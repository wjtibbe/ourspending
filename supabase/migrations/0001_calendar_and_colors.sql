-- OurSpending: calendar events (with weekday-only recurrence) + configurable
-- person/shared colors.
--
-- This app has no migration tooling / CLI wired up in this repo - schema
-- lives directly in the Supabase project. Run this file once, in order,
-- via the Supabase SQL editor (or `supabase db execute` if you have the CLI
-- linked). It is purely additive:
--   - two new NULLABLE columns on existing tables (no data loss, no
--     behavior change for existing rows - the app already treats a null
--     color as "use the original default")
--   - one new table, scoped to your household the same way expenses/budgets
--     already are
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / DROP POLICY
-- IF EXISTS + CREATE POLICY).

-- ------------------------------------------------------------------
-- 1) Configurable colors (Part 2)
-- ------------------------------------------------------------------
-- Nullable on purpose: null means "use the app's built-in default color"
-- (see DEFAULT_COLORS in lib.js) until the household explicitly picks one
-- in Settings.
alter table profiles add column if not exists color text;
alter table households add column if not exists shared_color text;

-- ------------------------------------------------------------------
-- 2) Calendar events with recurrence, incl. weekday-only (Part 1)
-- ------------------------------------------------------------------
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title text not null,
  event_date date not null,
  -- Conceptually equivalent to an RRULE FREQ (+ BYDAY=MO,TU,WE,TH,FR for
  -- "weekday") - kept as a plain enum-like column rather than a full RRULE
  -- string to match this schema's existing style (expenses.kind,
  -- expenses.currency are plain checked text columns too).
  recurrence text not null default 'none'
    check (recurrence in ('none', 'daily', 'weekday', 'weekly', 'monthly', 'yearly')),
  -- Same ownership tag as expenses.kind, so an event can be shown in the
  -- same person/shared color as everything else.
  kind text not null default 'shared' check (kind in ('shared', 'p0', 'p1')),
  note text,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists events_household_id_idx on events (household_id);

alter table events enable row level security;

-- Mirrors the same household-scoped access pattern implied by how the app
-- already queries expenses/budgets (`.eq("household_id", hhId)`, gated by
-- each user's own `profiles.household_id`). If your existing RLS policies
-- for expenses/budgets use a different mechanism (e.g. a security-definer
-- function), adapt these four policies to match it instead of assuming this
-- exact shape.
drop policy if exists "Household members can read events" on events;
create policy "Household members can read events"
  on events for select
  using (household_id in (select household_id from profiles where id = auth.uid()));

drop policy if exists "Household members can insert events" on events;
create policy "Household members can insert events"
  on events for insert
  with check (household_id in (select household_id from profiles where id = auth.uid()));

drop policy if exists "Household members can update events" on events;
create policy "Household members can update events"
  on events for update
  using (household_id in (select household_id from profiles where id = auth.uid()));

drop policy if exists "Household members can delete events" on events;
create policy "Household members can delete events"
  on events for delete
  using (household_id in (select household_id from profiles where id = auth.uid()));

-- If your project's `supabase_realtime` publication lists tables explicitly
-- (rather than "all tables"), the app's realtime subscription for calendar
-- events needs this too - safe/idempotent, a no-op if already added or if
-- the publication already covers all tables:
--   alter publication supabase_realtime add table events;
