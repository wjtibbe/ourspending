-- OurSpending — merchant category rules verification.
-- READ-ONLY except for temporary rows it creates and rolls back.
-- Everything runs inside a transaction that ends in ROLLBACK, so production
-- data is never modified. Paste into the Supabase SQL editor and run.
--
-- A clean run ends with: "MERCHANT CATEGORY RULES VERIFICATION PASSED".
--
-- Run AFTER supabase/merchant_category_rules.sql.

begin;

-- ------------------------------------------------------------
-- 1. What is live?
-- ------------------------------------------------------------
select tablename, policyname, cmd, qual::text
from pg_policies
where schemaname = 'public' and tablename = 'merchant_category_rules'
order by cmd, policyname;

-- Expect select/insert/update for authenticated, nothing for anon.
select grantee, table_name, privilege_type
from information_schema.table_privileges
where table_schema = 'public' and table_name = 'merchant_category_rules'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;

-- Expect zero rows.
select c.relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
  and c.relname = 'merchant_category_rules';

-- Expect category_match present and readable by authenticated.
select 1/count(*) from information_schema.column_privileges
where table_schema = 'public' and table_name = 'email_import_messages'
  and column_name = 'category_match' and grantee = 'authenticated' and privilege_type = 'SELECT';

-- ------------------------------------------------------------
-- 2. Behavioural tests with real role switching
-- ------------------------------------------------------------
do $$
declare
  ua uuid := gen_random_uuid();   -- household A
  ub uuid := gen_random_uuid();   -- household B, unrelated
  ha uuid;
  hb uuid;
  rule_id uuid;
  n int;
  got_category text;
  blocked boolean;
begin
  insert into auth.users (id, email, instance_id, aud, role) values
    (ua, 'mcr-a@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    (ub, 'mcr-b@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

  insert into households (name, invite_code) values ('MCR A', 'mcracode') returning id into ha;
  insert into households (name, invite_code) values ('MCR B', 'mcrbcode') returning id into hb;

  perform set_config('app.household_assign', 'on', true);
  insert into profiles (id, display_name, household_id, slot) values (ua, 'A', ha, 0), (ub, 'B', hb, 0);
  perform set_config('app.household_assign', 'off', true);

  -- ========================================================
  -- 2a. A household member can create and read their own rule
  -- ========================================================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  insert into merchant_category_rules (household_id, normalized_merchant, display_merchant, category_key, created_by)
  values (ha, 'uber', 'UBER *TRIP', 'transport', ua)
  returning id into rule_id;

  select count(*) into n from merchant_category_rules where household_id = ha;
  assert n = 1, 'BROKEN: the owner cannot read their own new rule';

  -- ========================================================
  -- 2b. Updating (re-teaching) the same merchant updates in place
  -- ========================================================
  update merchant_category_rules
     set category_key = 'travel', usage_count = usage_count + 1
   where household_id = ha and normalized_merchant = 'uber';

  select count(*) into n from merchant_category_rules where household_id = ha;
  assert n = 1, format('BROKEN: re-teaching the same merchant created a second row, got %s', n);

  select category_key into got_category from merchant_category_rules where id = rule_id;
  assert got_category = 'travel', format('BROKEN: re-teaching did not update the category, got %s', got_category);

  -- ========================================================
  -- 2c. One household's rule is invisible to, and unwritable by, another
  -- ========================================================
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);

  select count(*) into n from merchant_category_rules;
  assert n = 0, format('LEAK: household B can see household A''s merchant rules, got %s', n);

  blocked := false;
  begin
    insert into merchant_category_rules (household_id, normalized_merchant, category_key, created_by)
    values (ha, 'jumbo', 'groceries', ub);
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: household B inserted a rule into household A';

  blocked := false;
  begin
    update merchant_category_rules set category_key = 'other' where id = rule_id;
    get diagnostics n = row_count;
    if n = 0 then blocked := true; end if;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: household B updated household A''s rule';

  -- Household B can create its OWN rule for the SAME normalized merchant --
  -- the unique constraint is scoped per household, not global.
  insert into merchant_category_rules (household_id, normalized_merchant, category_key, created_by)
  values (hb, 'uber', 'transport', ub);
  select count(*) into n from merchant_category_rules where household_id = hb and normalized_merchant = 'uber';
  assert n = 1, 'BROKEN: household B could not create its own rule for a merchant household A already has';

  -- Duplicate within the SAME household must still be rejected as a second
  -- insert (the app upserts instead, but the constraint is the real guarantee).
  blocked := false;
  begin
    insert into merchant_category_rules (household_id, normalized_merchant, category_key, created_by)
    values (hb, 'uber', 'travel', ub);
  exception when unique_violation then blocked := true;
  end;
  assert blocked, 'BROKEN: two rules for the same household+merchant were both allowed to exist';

  -- ========================================================
  -- 2d. An unauthenticated/anon caller has no privilege on this table at all
  -- ========================================================
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
  blocked := false;
  begin
    perform count(*) from merchant_category_rules;
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, 'LEAK: anon has SELECT privilege on merchant_category_rules';
  perform set_config('role', 'postgres', true);

  -- ========================================================
  -- 2e. A blank/whitespace-only normalized_merchant is rejected
  -- ========================================================
  blocked := false;
  begin
    insert into merchant_category_rules (household_id, normalized_merchant, category_key)
    values (ha, '   ', 'other');
  exception when others then blocked := true;
  end;
  assert blocked, 'BROKEN: a blank normalized_merchant was accepted';

  raise notice 'MERCHANT CATEGORY RULES VERIFICATION PASSED — rules are created, read and updated only within their own household, one rule exists per household+merchant, and a blank merchant is rejected.';
end $$;

rollback;
