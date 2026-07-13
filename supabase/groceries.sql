-- Grocery list table for OurSpending.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

create table if not exists public.groceries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  done boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.groceries enable row level security;

create policy "Members can read groceries" on public.groceries
  for select using (household_id = (select household_id from public.profiles where id = auth.uid()));

create policy "Members can insert groceries" on public.groceries
  for insert with check (household_id = (select household_id from public.profiles where id = auth.uid()));

create policy "Members can update groceries" on public.groceries
  for update using (household_id = (select household_id from public.profiles where id = auth.uid()));

create policy "Members can delete groceries" on public.groceries
  for delete using (household_id = (select household_id from public.profiles where id = auth.uid()));

-- Live sync between your two phones
alter publication supabase_realtime add table public.groceries;
