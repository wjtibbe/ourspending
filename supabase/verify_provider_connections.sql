-- OurSpending — connected-accounts security verification.
-- READ-ONLY except for temporary rows it creates and rolls back.
-- Everything runs inside a transaction that ends in ROLLBACK, so production
-- data is never modified. Paste into the Supabase SQL editor and run.
--
-- A clean run ends with the notice: "PROVIDER VERIFICATION PASSED".
-- Any failure raises and aborts, so no partial "pass" can be mistaken for one.
--
-- Run this AFTER supabase/provider_connections.sql.

begin;

-- ------------------------------------------------------------
-- 1. What is live?
-- ------------------------------------------------------------
-- Expect exactly one policy: a SELECT policy on provider_connections.
-- provider_credentials must appear with NO policies at all.
select tablename, policyname, cmd, qual::text
from pg_policies
where schemaname = 'public'
  and tablename in ('provider_connections', 'provider_credentials')
order by tablename, cmd, policyname;

-- Expect: authenticated holds SELECT on provider_connections and nothing on
-- provider_credentials. Any INSERT/UPDATE/DELETE row here is a hole.
select grantee, table_name, privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and table_name in ('provider_connections', 'provider_credentials')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- Expect zero rows: both tables must have RLS enabled.
select c.relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relrowsecurity = false
  and c.relname in ('provider_connections', 'provider_credentials');

-- ------------------------------------------------------------
-- 2. Behavioural tests with real role switching
-- ------------------------------------------------------------
do $$
declare
  ua uuid := gen_random_uuid();   -- owns the Wise connection
  ub uuid := gen_random_uuid();   -- a different user, different household
  ha uuid;
  hb uuid;
  conn uuid;
  n  int;
  blocked boolean;
begin
  insert into auth.users (id, email, instance_id, aud, role) values
    (ua, 'prov-a@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    (ub, 'prov-b@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

  insert into households (name, invite_code) values ('Prov A', 'paaacode') returning id into ha;
  insert into households (name, invite_code) values ('Prov B', 'pbbbcode') returning id into hb;

  -- Seed membership through the trusted path (the guard blocks direct writes).
  perform set_config('app.household_assign', 'on', true);
  insert into profiles (id, display_name, household_id, slot)
  values (ua, 'A', ha, 0), (ub, 'B', hb, 0);
  perform set_config('app.household_assign', 'off', true);

  -- What the Edge Function does, running as service_role/owner.
  insert into provider_connections (user_id, household_id, provider, status, account_label, secret_hint)
  values (ua, ha, 'wise', 'connected', 'Personal', 'ab12')
  returning id into conn;

  insert into provider_credentials (connection_id, user_id, provider, ciphertext, iv)
  values (conn, ua, 'wise', 'ZmFrZS1jaXBoZXJ0ZXh0', 'ZmFrZS1pdg==');

  -- ========================================================
  -- 2a. The owner sees their own connection — and only metadata
  -- ========================================================
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  select count(*) into n from provider_connections where id = conn;
  assert n = 1, 'BROKEN: a user cannot read their own provider connection';

  -- ========================================================
  -- 2b. The token is unreachable from the API roles
  -- ========================================================
  -- Secure either way: a privilege error, or RLS returning nothing.
  blocked := false;
  begin
    select count(*) into n from provider_credentials;
    if n > 0 then
      raise exception 'LEAK: % credential row(s) readable by an authenticated user', n;
    end if;
    blocked := true;
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, 'LEAK: provider_credentials is readable by authenticated users';

  blocked := false;
  begin
    insert into provider_credentials (connection_id, user_id, provider, ciphertext, iv)
    values (conn, ua, 'wise', 'x', 'y');
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: an authenticated user wrote to provider_credentials';

  -- ========================================================
  -- 2c. Connections are read-only to the client
  -- ========================================================
  -- Every mutation must go through the Edge Function, so that user_id and
  -- household_id are always derived server-side and never taken from a request.
  blocked := false;
  begin
    insert into provider_connections (user_id, household_id, provider)
    values (ua, ha, 'revolut');
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client inserted a provider connection directly';

  blocked := false;
  begin
    update provider_connections set household_id = hb where id = conn;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client repointed a connection at another household';

  blocked := false;
  begin
    delete from provider_connections where id = conn;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client deleted a provider connection directly';

  -- ========================================================
  -- 2d. Cross-user isolation
  -- ========================================================
  perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);

  select count(*) into n from provider_connections where id = conn;
  assert n = 0, 'LEAK: another user can see someone else''s connected account';

  select count(*) into n from provider_connections;
  assert n = 0, 'LEAK: connections are visible outside their owner';

  -- ========================================================
  -- 2e. One connection per provider per user
  -- ========================================================
  perform set_config('role', 'postgres', true);
  blocked := false;
  begin
    insert into provider_connections (user_id, household_id, provider)
    values (ua, ha, 'wise');
  exception when unique_violation then blocked := true;
  end;
  assert blocked, 'BROKEN: a duplicate connection for the same user+provider was allowed';

  -- ========================================================
  -- 2f. Disconnecting takes the token with it
  -- ========================================================
  delete from provider_connections where id = conn;
  select count(*) into n from provider_credentials where connection_id = conn;
  assert n = 0, 'LEAK: the credential outlived the connection it belonged to';

  raise notice 'PROVIDER VERIFICATION PASSED — tokens are unreachable from the browser and connections cannot be forged or repointed.';
end $$;

rollback;
