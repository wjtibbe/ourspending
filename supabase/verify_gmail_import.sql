-- OurSpending — Gmail import verification.
-- READ-ONLY except for temporary rows it creates and rolls back.
-- Everything runs inside a transaction that ends in ROLLBACK, so production
-- data is never modified. Paste into the Supabase SQL editor and run.
--
-- A clean run ends with: "GMAIL IMPORT VERIFICATION PASSED".
--
-- Run AFTER supabase/gmail_import.sql.

begin;

-- ------------------------------------------------------------
-- 1. What is live?
-- ------------------------------------------------------------
-- Expect SELECT only for authenticated on the connection table, and NOTHING
-- at all on the credential and state tables.
select grantee, table_name, privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and table_name in ('email_import_connections', 'email_import_credentials',
                     'email_import_oauth_states')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- Expect zero rows: a table without RLS is a hole.
select c.relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
  and c.relname in ('email_import_connections', 'email_import_credentials',
                    'email_import_oauth_states');

-- ------------------------------------------------------------
-- 2. Structure
-- ------------------------------------------------------------
do $$
begin
  -- The secret tables must have RLS on and ZERO policies. Zero policies with
  -- RLS enabled means "deny everything", which is the intent -- a policy here
  -- would be a way in.
  if (select count(*) from pg_policies
       where schemaname = 'public'
         and tablename in ('email_import_credentials', 'email_import_oauth_states')) <> 0 then
    raise exception 'the credential/state tables must have NO policies at all';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'email_import_connections'
       and column_name = 'alias_token' and is_nullable = 'YES'
  ) then
    raise exception 'alias_token must be nullable so a Gmail connection can exist without one';
  end if;

  -- Retained bodies must STILL be unreadable, exactly as before this
  -- migration: widening the table must not have widened that.
  if exists (
    select 1 from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'email_import_messages'
       and grantee in ('anon', 'authenticated')
       and column_name in ('raw_text', 'raw_html')
  ) then
    raise exception 'raw_text/raw_html must remain unreadable by every client role';
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. Behavioural tests with real role switching
-- ------------------------------------------------------------
do $$
declare
  ua uuid := gen_random_uuid();   -- owns a Gmail connection
  ub uuid := gen_random_uuid();   -- a different user entirely
  ha uuid;
  hb uuid;
  conn_a uuid;
  conn_b uuid;
  st text := 'state-' || encode(extensions.gen_random_bytes(8), 'hex');
  got_user uuid;
  got_verifier text;
  n int;
  blocked boolean;
begin
  insert into auth.users (id, email, instance_id, aud, role) values
    (ua, 'gmail-a@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
    (ub, 'gmail-b@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

  insert into households (name, invite_code) values ('Gmail A', 'gaaacode') returning id into ha;
  insert into households (name, invite_code) values ('Gmail B', 'gbbbcode') returning id into hb;

  perform set_config('app.household_assign', 'on', true);
  insert into profiles (id, display_name, household_id, slot)
  values (ua, 'A', ha, 0), (ub, 'B', hb, 1);
  perform set_config('app.household_assign', 'off', true);

  -- ========================================================
  -- 3a. A Gmail connection needs no alias; a Resend one still does
  -- ========================================================
  insert into email_import_connections (user_id, provider, alias_token, account_email)
  values (ua, 'gmail', null, 'alex@example.com') returning id into conn_a;
  insert into email_import_connections (user_id, provider, alias_token, account_email)
  values (ub, 'gmail', null, 'sam@example.com') returning id into conn_b;

  blocked := false;
  begin
    insert into email_import_connections (user_id, provider, alias_token)
    values (ua, 'wise_email', null);
  exception when others then blocked := true;
  end;
  assert blocked, 'BROKEN: a forwarding connection was allowed with no alias to forward to';

  blocked := false;
  begin
    insert into email_import_connections (user_id, provider, alias_token)
    values (ub, 'gmail', 'an-alias-token-that-is-long-enough');
  exception when others then blocked := true;
  end;
  assert blocked, 'BROKEN: a Gmail connection was allowed to carry a forwarding alias';

  -- ========================================================
  -- 3b. OAuth state is single-use and bound to ONE user
  -- ========================================================
  insert into email_import_oauth_states (state, user_id, code_verifier)
  values (st, ua, 'verifier-abc');

  select s.user_id, s.code_verifier into got_user, got_verifier
    from consume_email_import_oauth_state(st) s;
  assert got_user = ua,
    format('BROKEN: state resolved to the wrong user: %s', got_user);
  assert got_verifier = 'verifier-abc', 'BROKEN: the PKCE verifier did not survive';

  -- THE replay test: the same state a second time must yield nothing.
  got_user := null;
  select s.user_id into got_user from consume_email_import_oauth_state(st) s;
  assert got_user is null, 'BYPASS: an OAuth state was replayable';

  -- An expired state is dead on arrival.
  insert into email_import_oauth_states (state, user_id, code_verifier, expires_at)
  values ('expired-state', ua, 'v', now() - interval '1 minute');
  got_user := null;
  select s.user_id into got_user from consume_email_import_oauth_state('expired-state') s;
  assert got_user is null, 'BYPASS: an expired OAuth state was accepted';

  -- An unknown state resolves to nobody rather than erroring in a way that
  -- would confirm which states exist.
  got_user := null;
  select s.user_id into got_user from consume_email_import_oauth_state('never-issued') s;
  assert got_user is null, 'BROKEN: an unknown state returned a user';

  -- ========================================================
  -- 3c. Credentials are invisible to every client
  -- ========================================================
  insert into email_import_credentials (connection_id, user_id, ciphertext, iv)
  values (conn_a, ua, 'ENCRYPTED-A', 'IV-A');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', ua, 'role', 'authenticated')::text, true);

  -- Even the OWNER cannot read their own stored token.
  blocked := false;
  begin
    perform ciphertext from email_import_credentials where connection_id = conn_a;
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, 'LEAK: a client could read a stored refresh token';

  -- Nor can a client read a pending OAuth state (which holds the verifier).
  blocked := false;
  begin
    perform code_verifier from email_import_oauth_states;
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, 'LEAK: a client could read a PKCE verifier';

  -- Nor execute the state-consuming function.
  blocked := false;
  begin
    perform public.consume_email_import_oauth_state('anything');
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, 'BYPASS: a client could consume OAuth states';

  -- ========================================================
  -- 3d. The safe metadata IS readable — but only your own
  -- ========================================================
  select count(*) into n from email_import_connections;
  assert n = 1, format('LEAK: user A sees %s connections, expected only their own 1', n);

  select count(*) into n from email_import_connections where account_email = 'alex@example.com';
  assert n = 1, 'BROKEN: the owner cannot read their own connected mailbox';

  select count(*) into n from email_import_connections where user_id = ub;
  assert n = 0, 'LEAK: user A can see user B''s Gmail connection';

  -- Writes stay closed: the Edge Functions own this table.
  blocked := false;
  begin
    update email_import_connections set account_email = 'attacker@evil.net' where id = conn_a;
    get diagnostics n = row_count;
    if n = 0 then blocked := true; end if;
  exception when others then blocked := true;
  end;
  assert blocked, 'BYPASS: a client rewrote their own connection row';

  perform set_config('role', 'postgres', true);

  -- ========================================================
  -- 3e. The ledger still dedupes, now scoped to a Gmail connection
  -- ========================================================
  insert into email_import_messages (connection_id, user_id, source, provider_message_id, status)
  values (conn_a, ua, 'gmail', 'gmail-msg-1', 'imported');

  blocked := false;
  begin
    insert into email_import_messages (connection_id, user_id, source, provider_message_id, status)
    values (conn_a, ua, 'gmail', 'gmail-msg-1', 'imported');
  exception when unique_violation then blocked := true;
  end;
  assert blocked, 'BROKEN: the same Gmail message id imported twice';

  -- The SAME Gmail id under a DIFFERENT user is a different message and must
  -- be allowed, or one of them silently loses an expense.
  insert into email_import_messages (connection_id, user_id, source, provider_message_id, status)
  values (conn_b, ub, 'gmail', 'gmail-msg-1', 'imported');
  select count(*) into n from email_import_messages where provider_message_id = 'gmail-msg-1';
  assert n = 2, format('BROKEN: two users sharing a Gmail id collapsed to %s row(s)', n);

  -- An unrecognised source must not be storable.
  blocked := false;
  begin
    insert into email_import_messages (connection_id, user_id, source, provider_message_id, status)
    values (conn_a, ua, 'carrier-pigeon', 'x-1', 'imported');
  exception when others then blocked := true;
  end;
  assert blocked, 'BROKEN: an unknown delivery source was accepted';

  -- ========================================================
  -- 3f. Disconnecting removes the credential with the connection
  -- ========================================================
  delete from email_import_connections where id = conn_a;
  select count(*) into n from email_import_credentials where connection_id = conn_a;
  assert n = 0, 'LEAK: a refresh token outlived the connection it belonged to';
  select count(*) into n from email_import_messages where connection_id = conn_a;
  assert n = 0, 'BROKEN: ledger rows outlived their connection';

  -- ========================================================
  -- 3g. Housekeeping only removes dead states
  -- ========================================================
  insert into email_import_oauth_states (state, user_id, code_verifier)
  values ('live-state', ub, 'v');
  perform public.purge_email_import_oauth_states();
  select count(*) into n from email_import_oauth_states where state = 'live-state';
  assert n = 1, 'BROKEN: the purge removed a live OAuth state';
  select count(*) into n from email_import_oauth_states where state = st;
  assert n = 0, 'BROKEN: the purge left a consumed OAuth state behind';

  raise notice 'GMAIL IMPORT VERIFICATION PASSED — OAuth state is single-use and user-bound, refresh tokens are unreadable by every client, Gmail message ids dedupe per connection, and disconnecting takes the credential with it.';
end $$;

rollback;
