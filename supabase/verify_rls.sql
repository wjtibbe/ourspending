-- OurSpending — RLS + privilege verification.
-- READ-ONLY except for temporary rows it creates and rolls back.
-- Everything runs inside a transaction that ends in ROLLBACK, so production
-- data is never modified. Paste into the Supabase SQL editor and run.
--
-- A clean run ends with the notice: "VERIFICATION PASSED".
-- Any failure raises and aborts, so no partial "pass" can be mistaken for one.

begin;

-- ------------------------------------------------------------
-- 1. Which policies are live?
-- ------------------------------------------------------------
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles','households','expenses','budgets',
                    'household_categories','groceries','calendar_events')
order by tablename, cmd, policyname;

-- Which columns may the API roles write? Expect profiles/households to list
-- ONLY the personal + household-config columns, never household_id, slot or
-- invite_code.
select grantee, table_name, privilege_type, string_agg(column_name, ', ' order by column_name) as columns
from information_schema.column_privileges
where table_schema = 'public'
  and table_name in ('profiles','households')
  and grantee in ('authenticated','anon')
  and privilege_type in ('INSERT','UPDATE')
group by grantee, table_name, privilege_type
order by grantee, table_name, privilege_type;

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
where schemaname = 'public' and qual::text in ('true', '(true)');

-- ------------------------------------------------------------
-- 2. Behavioural tests with real role switching
-- ------------------------------------------------------------
do $$
declare
  ua uuid := gen_random_uuid();   -- member of household A
  ub uuid := gen_random_uuid();   -- member of household B
  uc uuid := gen_random_uuid();   -- signed in, no household (the attacker)
  ha uuid;
  hb uuid;
  n  int;
  blocked boolean;
begin
  insert into auth.users (id, email, instance_id, aud, role) values
    (ua, 'rls-a@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    (ub, 'rls-b@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    (uc, 'rls-c@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

  insert into households (name, invite_code) values ('RLS A', 'aaaacode') returning id into ha;
  insert into households (name, invite_code) values ('RLS B', 'bbbbcode') returning id into hb;

  -- Seed membership through the trusted path (the guard blocks direct writes).
  perform set_config('app.household_assign', 'on', true);
  insert into profiles (id, display_name, household_id, slot)
  values (ua, 'A', ha, 0), (ub, 'B', hb, 0);
  perform set_config('app.household_assign', 'off', true);

  insert into expenses (household_id, amount_orig, currency, amount_eur, rate_used,
                        kind, payer, category, spent_on, created_by)
  values (hb, 10, 'EUR', 10, 1, 'shared', 0, 'groceries', current_date, ub);
  insert into budgets (household_id, category, monthly_eur) values (hb, 'groceries', 99);
  insert into household_categories (household_id, category_key, is_custom, label, icon, active)
  values (hb, 'custom_secret', true, 'Secret', 'x', true);

  -- ========================================================
  -- 2a. THE REPORTED BYPASS: no household -> arbitrary household
  -- ========================================================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uc, 'role', 'authenticated')::text, true);

  -- The attacker creates their own profile row. It must be impossible to
  -- pre-set membership here (the sign-up hole).
  blocked := false;
  begin
    insert into profiles (id, display_name, household_id, slot) values (uc, 'C', hb, 1);
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a new user inserted a profile already inside household B';

  insert into profiles (id, display_name) values (uc, 'C');   -- the legitimate shape

  -- Now the reported hole: household_id is NULL, so the old trigger allowed
  -- NULL -> any UUID. It must be refused now.
  blocked := false;
  begin
    update profiles set household_id = hb where id = uc;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a household-less user joined household B by direct UPDATE';

  blocked := false;
  begin
    update profiles set household_id = hb, slot = 1 where id = uc;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: direct UPDATE of household_id + slot succeeded';

  -- Joining still requires a valid invite code.
  blocked := false;
  begin
    perform join_household('not-a-real-code');
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: join_household accepted an invalid code';

  -- The legitimate path works, and assigns the next free slot itself.
  perform join_household('bbbbcode');
  select slot into n from profiles where id = uc;
  assert n = 1, format('join_household assigned slot %s, expected 1', n);

  -- Already a member: a second join must fail.
  blocked := false;
  begin
    perform join_household('aaaacode');
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: an existing member joined a second household';

  -- Household full: user A cannot squeeze into B (both slots taken).
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  blocked := false;
  begin
    perform join_household('bbbbcode');
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a third member entered a full household';

  -- ========================================================
  -- 2b. Slot tampering (would re-attribute private expenses)
  -- ========================================================
  blocked := false;
  begin
    update profiles set slot = 1 where id = ua;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a member changed their own slot';

  -- ========================================================
  -- 2c. Legitimate profile edits must still work
  -- ========================================================
  update profiles set display_name = 'Renamed', preferred_currency = 'COP', color = '#123456'
   where id = ua;
  get diagnostics n = row_count;
  assert n = 1, 'BROKEN: a user cannot edit their own name/currency/colour';

  -- ========================================================
  -- 2d. Cross-household isolation
  -- ========================================================
  select count(*) into n from expenses where household_id = hb;
  assert n = 0, format('LEAK: user A can read %s of household B expenses', n);
  select count(*) into n from budgets where household_id = hb;
  assert n = 0, 'LEAK: user A can read household B budgets';
  select count(*) into n from households where id = hb;
  assert n = 0, 'LEAK: user A can read household B';
  select count(*) into n from profiles where id = ub;
  assert n = 0, 'LEAK: user A can read user B profile';
  select count(*) into n from household_categories where household_id = hb;
  assert n = 0, 'LEAK: user A can read household B categories';

  select count(*) into n from households where id = ha;
  assert n = 1, 'BROKEN: user A cannot read its own household';

  blocked := false;
  begin
    insert into expenses (household_id, amount_orig, currency, amount_eur, rate_used,
                          kind, payer, category, spent_on, created_by)
    values (hb, 1, 'EUR', 1, 1, 'shared', 0, 'groceries', current_date, ua);
  exception when others then blocked := true;
  end;
  assert blocked, 'LEAK: user A inserted an expense into household B';

  update profiles set display_name = 'hacked' where id = ub;
  get diagnostics n = row_count;
  assert n = 0, 'LEAK: user A modified user B profile';

  -- ========================================================
  -- 2e. Invite code and household creation are not client-writable
  -- ========================================================
  blocked := false;
  begin
    update households set invite_code = 'stolen01' where id = ha;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a member rewrote their household invite code';

  blocked := false;
  begin
    insert into households (name) values ('rogue');
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client created a household directly, skipping create_household()';

  -- Members may still configure rates / name / shared colour.
  update households set rate_source = 'xe.com', shared_color = '#1F6B4E' where id = ha;
  get diagnostics n = row_count;
  assert n = 1, 'BROKEN: a member cannot configure their own household';

  -- ========================================================
  -- 2f. Server-side secrets stay unreachable
  -- ========================================================
  -- Secure either way: a privilege error, or RLS returning nothing.
  blocked := false;
  begin
    select count(*) into n from calendar_oauth_tokens;
    if n > 0 then
      raise exception 'LEAK: % oauth token row(s) readable by an authenticated user', n;
    end if;
    blocked := true;
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, 'LEAK: calendar_oauth_tokens is readable by authenticated users';

  perform set_config('role', 'postgres', true);
  raise notice 'VERIFICATION PASSED — membership cannot be self-assigned and no cross-household access is possible.';
end $$;

rollback;
