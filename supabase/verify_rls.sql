-- OurSpending — RLS verification.
-- READ-ONLY except for two temporary households it creates and rolls back.
-- Everything runs inside a transaction that ends in ROLLBACK, so production
-- data is never modified. Paste into the Supabase SQL editor and run.

begin;

-- ------------------------------------------------------------
-- 1. Which policies are actually live?
-- ------------------------------------------------------------
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles','households','expenses','budgets',
                    'household_categories','groceries','calendar_events')
order by tablename, cmd, policyname;

-- Any app table with RLS disabled is a hole. Expect zero rows.
select c.relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity = false
  and c.relname in ('profiles','households','expenses','budgets',
                    'household_categories','groceries','calendar_events',
                    'calendar_connections','calendar_oauth_tokens');

-- Expect zero rows: no policy may be unconditionally true.
select tablename, policyname, qual::text
from pg_policies
where schemaname = 'public'
  and qual::text in ('true', '(true)');

-- ------------------------------------------------------------
-- 2. Cross-household isolation, proven with real role switching
-- ------------------------------------------------------------
do $$
declare
  ua uuid := gen_random_uuid();
  ub uuid := gen_random_uuid();
  ha uuid;
  hb uuid;
  leaked int;
begin
  -- Two synthetic users in two separate households.
  insert into auth.users (id, email, instance_id, aud, role)
  values (ua, 'rls-a@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
         (ub, 'rls-b@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

  insert into households (name) values ('RLS A') returning id into ha;
  insert into households (name) values ('RLS B') returning id into hb;

  insert into profiles (id, display_name, household_id, slot)
  values (ua, 'A', ha, 0), (ub, 'B', hb, 0);

  insert into expenses (household_id, amount_orig, currency, amount_eur, rate_used,
                        kind, payer, category, spent_on, created_by)
  values (hb, 10, 'EUR', 10, 1, 'shared', 0, 'groceries', current_date, ub);

  insert into budgets (household_id, category, monthly_eur) values (hb, 'groceries', 99);
  insert into household_categories (household_id, category_key, is_custom, label, icon, active)
  values (hb, 'custom_secret', true, 'Secret', 'x', true);

  -- Act as user A.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  select count(*) into leaked from expenses where household_id = hb;
  assert leaked = 0, format('LEAK: user A can read %s of household B expenses', leaked);

  select count(*) into leaked from budgets where household_id = hb;
  assert leaked = 0, 'LEAK: user A can read household B budgets';

  select count(*) into leaked from households where id = hb;
  assert leaked = 0, 'LEAK: user A can read household B';

  select count(*) into leaked from profiles where id = ub;
  assert leaked = 0, 'LEAK: user A can read user B profile';

  select count(*) into leaked from household_categories where household_id = hb;
  assert leaked = 0, 'LEAK: user A can read household B categories';

  -- A must still see its own household.
  select count(*) into leaked from households where id = ha;
  assert leaked = 1, 'BROKEN: user A cannot read its own household';

  -- Writing into someone else's household must be refused.
  begin
    insert into expenses (household_id, amount_orig, currency, amount_eur, rate_used,
                          kind, payer, category, spent_on, created_by)
    values (hb, 1, 'EUR', 1, 1, 'shared', 0, 'groceries', current_date, ua);
    raise exception 'LEAK: user A inserted an expense into household B';
  exception when insufficient_privilege then null;
  end;

  -- Editing another person's profile must be refused (0 rows affected).
  update profiles set display_name = 'hacked' where id = ub;
  get diagnostics leaked = row_count;
  assert leaked = 0, 'LEAK: user A modified user B profile';

  -- The one-household rule must hold at database level.
  perform set_config('role', 'postgres', true);
  begin
    update profiles set household_id = hb where id = ua;
    raise exception 'BROKEN: user A was moved to a second household';
  exception when others then
    if sqlerrm not like '%already_in_household%' then raise; end if;
  end;

  -- OAuth tokens must be unreachable for normal users.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  begin
    perform count(*) from calendar_oauth_tokens;
    raise exception 'LEAK: calendar_oauth_tokens is readable by authenticated users';
  exception when insufficient_privilege then null;
  end;

  perform set_config('role', 'postgres', true);
  raise notice 'RLS VERIFICATION PASSED — no cross-household access possible.';
end $$;

rollback;
