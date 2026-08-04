-- OurSpending — inbound email import verification.
-- READ-ONLY except for temporary rows it creates and rolls back.
-- Everything runs inside a transaction that ends in ROLLBACK, so production
-- data is never modified. Paste into the Supabase SQL editor and run.
--
-- A clean run ends with: "EMAIL IMPORT VERIFICATION PASSED".
--
-- Run AFTER supabase/email_import.sql.

begin;

-- ------------------------------------------------------------
-- 1. What is live?
-- ------------------------------------------------------------
select tablename, policyname, cmd, qual::text
from pg_policies
where schemaname = 'public'
  and tablename in ('email_import_connections', 'email_import_messages')
order by tablename, cmd, policyname;

-- Expect SELECT only for authenticated on both, and nothing for anon.
select grantee, table_name, privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and table_name in ('email_import_connections', 'email_import_messages')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- Expect zero rows.
select c.relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
  and c.relname in ('email_import_connections', 'email_import_messages');

-- ------------------------------------------------------------
-- 2. Behavioural tests with real role switching
-- ------------------------------------------------------------
do $$
declare
  ua uuid := gen_random_uuid();   -- owns an inbound alias
  ub uuid := gen_random_uuid();   -- unrelated user, different household
  ha uuid;
  hb uuid;
  conn_a uuid;
  conn_b uuid;
  exp uuid;
  msg uuid;
  tok_a text;
  tok_b text;
  n int;
  blocked boolean;
begin
  insert into auth.users (id, email, instance_id, aud, role) values
    (ua, 'mail-a@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    (ub, 'mail-b@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

  insert into households (name, invite_code) values ('Mail A', 'maaacode') returning id into ha;
  insert into households (name, invite_code) values ('Mail B', 'mbbbcode') returning id into hb;

  perform set_config('app.household_assign', 'on', true);
  insert into profiles (id, display_name, household_id, slot)
  values (ua, 'A', ha, 0), (ub, 'B', hb, 1);
  perform set_config('app.household_assign', 'off', true);

  -- ========================================================
  -- 2a. Alias issuing is per-user, random and unguessable
  -- ========================================================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  tok_a := public.issue_email_import_alias();

  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  tok_b := public.issue_email_import_alias();

  assert tok_a is not null and length(tok_a) >= 24,
    format('BROKEN: alias token too short: %s', length(coalesce(tok_a, '')));
  assert tok_a <> tok_b, 'BROKEN: two users were issued the same alias token';

  -- The token must not leak identity. A token containing the user id or the
  -- household id would let anyone who sees the address derive them.
  assert position(replace(ua::text, '-', '') in tok_a) = 0,
    'LEAK: the alias token contains the user id';
  assert position(replace(ha::text, '-', '') in tok_a) = 0,
    'LEAK: the alias token contains the household id';

  -- Calling again without rotation is stable (the address does not churn).
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  assert public.issue_email_import_alias() = tok_a,
    'BROKEN: re-issuing changed the address without being asked to rotate';

  -- Rotation replaces it.
  assert public.issue_email_import_alias(true) <> tok_a,
    'BROKEN: rotation did not change the alias token';

  -- Read both connection ids with RLS OUT OF THE WAY. Under the authenticated
  -- role a user can only see their own row -- which is the point of the policy,
  -- and is asserted in 2c below -- so fetching user B's id here would silently
  -- yield NULL and make later inserts fail for the wrong reason.
  perform set_config('role', 'postgres', true);
  select alias_token, id into tok_a, conn_a
    from email_import_connections where user_id = ua;
  select id into conn_b from email_import_connections where user_id = ub;
  assert conn_a is not null and conn_b is not null,
    'BROKEN: alias rows were not created for both users';
  perform set_config('role', 'authenticated', true);

  -- ========================================================
  -- 2b. Connections are read-only to clients
  -- ========================================================
  blocked := false;
  begin
    insert into email_import_connections (user_id, provider, alias_token)
    values (ua, 'wise_email', 'forged-token-aaaaaaaaaaaaaaaaaaaaaaaa');
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client inserted an inbound alias directly';

  blocked := false;
  begin
    update email_import_connections set alias_token = 'stolen-aaaaaaaaaaaaaaaaaaaaaaaaaa' where id = conn_a;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client rewrote its own alias token directly';

  blocked := false;
  begin
    update email_import_connections set user_id = ub where id = conn_a;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client re-pointed an alias at another user';

  -- ========================================================
  -- 2c. Cross-user isolation on connections
  -- ========================================================
  select count(*) into n from email_import_connections;
  assert n = 1, format('LEAK: user A can see %s connections, expected only its own', n);
  select count(*) into n from email_import_connections where user_id = ub;
  assert n = 0, 'LEAK: user A can read user B''s inbound alias';

  -- ========================================================
  -- 2d. The four dedupe keys
  -- ========================================================
  perform set_config('role', 'postgres', true);

  insert into expenses (household_id, amount_orig, currency, amount_eur, rate_used,
                        kind, payer, category, note, spent_on, created_by)
  values (ha, 12.34, 'USD', 11.43, 1.08, 'shared', 0, 'transport', 'Uber', current_date, ua)
  returning id into exp;

  insert into email_import_messages (connection_id, user_id, household_id,
                                     provider_message_id, rfc_message_id, external_ref, fingerprint,
                                     status, merchant, amount_value, amount_currency,
                                     mapped_category, category_source, expense_id)
  values (conn_a, ua, ha, 'resend-1', '<abc@wise.com>', 'CARD-111', 'fp-1',
          'imported', 'Uber', 12.34, 'USD', 'transport', 'provider_category', exp)
  returning id into msg;

  -- Each key independently blocks a re-insert.
  blocked := false;
  begin
    insert into email_import_messages (connection_id, user_id, provider_message_id, status)
    values (conn_a, ua, 'resend-1', 'received');
  exception when unique_violation then blocked := true;
  end;
  assert blocked, 'BROKEN: the same provider message id was accepted twice';

  blocked := false;
  begin
    insert into email_import_messages (connection_id, user_id, rfc_message_id, status)
    values (conn_a, ua, '<abc@wise.com>', 'received');
  exception when unique_violation then blocked := true;
  end;
  assert blocked, 'BROKEN: the same RFC Message-ID was accepted twice';

  blocked := false;
  begin
    insert into email_import_messages (connection_id, user_id, external_ref, status)
    values (conn_a, ua, 'CARD-111', 'received');
  exception when unique_violation then blocked := true;
  end;
  assert blocked, 'BROKEN: the same transaction reference was accepted twice';

  blocked := false;
  begin
    insert into email_import_messages (connection_id, user_id, fingerprint, status)
    values (conn_a, ua, 'fp-1', 'received');
  exception when unique_violation then blocked := true;
  end;
  assert blocked, 'BROKEN: the same fingerprint was accepted twice';

  -- NULL identifiers must not collide with each other: two different messages
  -- that each lack a reference are still two messages.
  insert into email_import_messages (connection_id, user_id, provider_message_id, status)
  values (conn_a, ua, 'resend-2', 'unparsed');
  insert into email_import_messages (connection_id, user_id, provider_message_id, status)
  values (conn_a, ua, 'resend-3', 'unparsed');
  select count(*) into n from email_import_messages where connection_id = conn_a;
  assert n = 3, format('BROKEN: NULL dedupe keys collapsed rows, got %s expected 3', n);

  -- The SAME identifiers under a DIFFERENT connection are a different user's
  -- message and must be allowed, or one of them silently loses an expense.
  insert into email_import_messages (connection_id, user_id, provider_message_id,
                                     rfc_message_id, external_ref, fingerprint, status)
  values (conn_b, ub, 'resend-1', '<abc@wise.com>', 'CARD-111', 'fp-1', 'imported');
  select count(*) into n from email_import_messages where external_ref = 'CARD-111';
  assert n = 2, format('BROKEN: two users sharing a reference collapsed to %s row(s)', n);

  -- ========================================================
  -- 2e. Ledger is read-only to clients, and isolated per user
  -- ========================================================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  select count(*) into n from email_import_messages;
  assert n = 3, format('BROKEN: owner sees %s of their own 3 messages', n);

  blocked := false;
  begin
    insert into email_import_messages (connection_id, user_id, provider_message_id, status)
    values (conn_a, ua, 'forged', 'imported');
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client inserted a ledger row directly';

  blocked := false;
  begin
    update email_import_messages set household_id = hb where id = msg;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client re-pointed an imported message at another household';

  blocked := false;
  begin
    delete from email_import_messages where id = msg;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client deleted a ledger row directly';

  -- User B sees only their own.
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
  select count(*) into n from email_import_messages;
  assert n = 1, format('LEAK: user B sees %s messages, expected only their own 1', n);
  select count(*) into n from expenses where household_id = ha;
  assert n = 0, 'LEAK: user B can see household A''s imported expense';

  -- ========================================================
  -- 2f. Deleting an expense must not resurrect the import
  -- ========================================================
  perform set_config('role', 'postgres', true);
  delete from expenses where id = exp;
  select count(*) into n from email_import_messages where id = msg;
  assert n = 1, 'BROKEN: deleting an expense removed its ledger row, so it would re-import';
  select count(*) into n from email_import_messages where id = msg and expense_id is null;
  assert n = 1, 'BROKEN: the ledger still points at a deleted expense';

  -- Disconnecting cleans up its own history.
  delete from email_import_connections where id = conn_a;
  select count(*) into n from email_import_messages where connection_id = conn_a;
  assert n = 0, 'BROKEN: ledger rows outlived the connection they belong to';

  raise notice 'EMAIL IMPORT VERIFICATION PASSED — aliases are random and private, the ledger is client-read-only, and all four dedupe keys hold.';
end $$;

rollback;
