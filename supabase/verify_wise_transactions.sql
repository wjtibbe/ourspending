-- OurSpending — Wise import ledger verification.
-- READ-ONLY except for temporary rows it creates and rolls back.
-- Everything runs inside a transaction that ends in ROLLBACK, so production
-- data is never modified. Paste into the Supabase SQL editor and run.
--
-- A clean run ends with the notice: "WISE LEDGER VERIFICATION PASSED".
--
-- Run AFTER supabase/wise_transactions.sql.

begin;

-- ------------------------------------------------------------
-- 1. What is live?
-- ------------------------------------------------------------
-- Expect one SELECT policy on wise_transactions, and none at all on
-- provider_sync_runs.
select tablename, policyname, cmd, qual::text
from pg_policies
where schemaname = 'public'
  and tablename in ('wise_transactions', 'provider_sync_runs')
order by tablename, cmd, policyname;

-- Expect: authenticated holds SELECT on wise_transactions and nothing on
-- provider_sync_runs. Any INSERT/UPDATE/DELETE row here is a hole.
select grantee, table_name, privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and table_name in ('wise_transactions', 'provider_sync_runs')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- Expect zero rows.
select c.relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
  and c.relname in ('wise_transactions', 'provider_sync_runs');

-- ------------------------------------------------------------
-- 2. Behavioural tests with real role switching
-- ------------------------------------------------------------
do $$
declare
  ua uuid := gen_random_uuid();   -- owns the Wise connection
  ub uuid := gen_random_uuid();   -- unrelated user, different household
  ha uuid;
  hb uuid;
  conn uuid;
  exp uuid;
  ledger uuid;
  n int;
  blocked boolean;
begin
  insert into auth.users (id, email, instance_id, aud, role) values
    (ua, 'wise-a@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    (ub, 'wise-b@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

  insert into households (name, invite_code) values ('Wise A', 'waaacode') returning id into ha;
  insert into households (name, invite_code) values ('Wise B', 'wbbbcode') returning id into hb;

  perform set_config('app.household_assign', 'on', true);
  insert into profiles (id, display_name, household_id, slot)
  values (ua, 'A', ha, 0), (ub, 'B', hb, 0);
  perform set_config('app.household_assign', 'off', true);

  insert into provider_connections (user_id, household_id, provider, status)
  values (ua, ha, 'wise', 'connected') returning id into conn;

  -- What the sync job does: an ordinary expense plus a ledger row.
  insert into expenses (household_id, amount_orig, currency, amount_eur, rate_used,
                        kind, payer, category, note, spent_on, created_by)
  values (ha, 12.34, 'USD', 11.43, 1.08, 'p0', 0, 'transport', 'Uber', current_date, ua)
  returning id into exp;

  insert into wise_transactions (connection_id, user_id, household_id, wise_reference,
                                 wise_profile_id, wise_balance_id,
                                 direction, amount_value, amount_currency,
                                 amount_source_path, mapped_category, category_source,
                                 import_status, expense_id, raw_json)
  values (conn, ua, ha, 'CARD-111', 'p1', 'b1', 'out', 12.34, 'USD',
          'amount', 'transport', 'provider_category', 'imported', exp, '{"x":1}'::jsonb)
  returning id into ledger;

  -- ========================================================
  -- 2a. Idempotency: the same Wise reference cannot land twice
  -- ========================================================
  blocked := false;
  begin
    insert into wise_transactions (connection_id, user_id, household_id, wise_reference,
                                   wise_profile_id, wise_balance_id, import_status, raw_json)
    values (conn, ua, ha, 'CARD-111', 'p1', 'b1', 'imported', '{"x":2}'::jsonb);
  exception when unique_violation then blocked := true;
  end;
  assert blocked, 'BROKEN: the same Wise transaction was recorded twice';

  -- The SAME reference under a different balance is a different movement and
  -- must be allowed through, or a real expense would be silently dropped.
  insert into wise_transactions (connection_id, user_id, household_id, wise_reference,
                                 wise_profile_id, wise_balance_id, import_status, raw_json)
  values (conn, ua, ha, 'CARD-111', 'p1', 'b2', 'imported', '{"x":3}'::jsonb);
  select count(*) into n from wise_transactions where wise_reference = 'CARD-111';
  assert n = 2, format('BROKEN: same reference on two balances collapsed to %s row(s)', n);

  -- ...and so is the same reference under a different profile.
  insert into wise_transactions (connection_id, user_id, household_id, wise_reference,
                                 wise_profile_id, wise_balance_id, import_status, raw_json)
  values (conn, ua, ha, 'CARD-111', 'p2', 'b1', 'imported', '{"x":4}'::jsonb);
  select count(*) into n from wise_transactions where wise_reference = 'CARD-111';
  assert n = 3, format('BROKEN: same reference on two profiles collapsed to %s row(s)', n);

  -- The profile/balance columns must never be NULL: NULLs do not collide in a
  -- unique constraint, which would quietly disable the dedupe guarantee.
  blocked := false;
  begin
    insert into wise_transactions (connection_id, user_id, household_id, wise_reference,
                                   wise_profile_id, import_status, raw_json)
    values (conn, ua, ha, 'CARD-999', null, 'imported', '{"x":5}'::jsonb);
  exception when not_null_violation then blocked := true;
  end;
  assert blocked, 'BROKEN: wise_profile_id accepts NULL, so the dedupe scope can be bypassed';

  insert into wise_transactions (connection_id, user_id, household_id, wise_reference,
                                 wise_profile_id, wise_balance_id, import_status, raw_json)
  values (conn, ua, ha, 'CARD-222', 'p1', 'b1', 'skipped', '{"x":6}'::jsonb);

  -- ========================================================
  -- 2b. The owner may read their own ledger, and nothing else
  -- ========================================================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  select count(*) into n from wise_transactions where connection_id = conn;
  assert n = 4, format('BROKEN: owner sees %s of their own 4 ledger rows', n);

  -- ========================================================
  -- 2c. The ledger is read-only to clients
  -- ========================================================
  blocked := false;
  begin
    insert into wise_transactions (connection_id, user_id, household_id, wise_reference,
                                   import_status, raw_json)
    values (conn, ua, ha, 'FORGED-1', 'imported', '{}'::jsonb);
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client inserted a Wise ledger row directly';

  blocked := false;
  begin
    update wise_transactions set household_id = hb where id = ledger;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client repointed an imported transaction at another household';

  blocked := false;
  begin
    delete from wise_transactions where id = ledger;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client deleted a Wise ledger row directly';

  -- ========================================================
  -- 2d. Cross-user isolation  (validation case 11)
  -- ========================================================
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);

  select count(*) into n from wise_transactions;
  assert n = 0, format('LEAK: an unrelated user can see %s imported Wise rows', n);

  select count(*) into n from expenses where household_id = ha;
  assert n = 0, 'LEAK: an unrelated user can see the imported expense';

  -- ========================================================
  -- 2e. The run log is invisible to every API role
  -- ========================================================
  blocked := false;
  begin
    select count(*) into n from provider_sync_runs;
    if n > 0 then
      raise exception 'LEAK: % sync-run row(s) readable by an authenticated user', n;
    end if;
    blocked := true;
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, 'LEAK: provider_sync_runs is readable by authenticated users';

  -- ========================================================
  -- 2f. Deleting an expense must not resurrect the import
  -- ========================================================
  perform set_config('role', 'postgres', true);
  delete from expenses where id = exp;

  select count(*) into n from wise_transactions where id = ledger;
  assert n = 1, 'BROKEN: deleting an expense removed its ledger row, so it would re-import';
  select count(*) into n from wise_transactions where id = ledger and expense_id is null;
  assert n = 1, 'BROKEN: the ledger still points at a deleted expense';

  -- ========================================================
  -- 2g. Disconnecting cleans up
  -- ========================================================
  delete from provider_connections where id = conn;
  select count(*) into n from wise_transactions where connection_id = conn;
  assert n = 0, 'BROKEN: ledger rows outlived the connection they belong to';

  raise notice 'WISE LEDGER VERIFICATION PASSED — imports are idempotent, client-read-only and invisible across users.';
end $$;

rollback;
