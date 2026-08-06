-- OurSpending — email_import_messages ledger-claim fix verification.
-- READ-ONLY except for temporary rows it creates and rolls back.
-- Everything runs inside a transaction that ends in ROLLBACK, so production
-- data is never modified. Paste into the Supabase SQL editor and run.
--
-- A clean run ends with: "LEDGER CLAIM FIX VERIFICATION PASSED".
--
-- Run AFTER supabase/email_import_ledger_fix.sql.

begin;

-- ------------------------------------------------------------
-- 1. The unique index is now non-partial (no WHERE predicate).
-- ------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'email_import_messages_provider_msg_unique'
       and indexdef ilike '%where%'
  ) then
    raise exception 'the provider_message_id index must no longer be partial -- PostgREST''s on_conflict cannot match a WHERE predicate';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'email_import_messages_provider_msg_unique'
  ) then
    raise exception 'the provider_message_id unique index is missing entirely';
  end if;

  -- The other three dedupe indexes are untouched: still partial, since they
  -- are never targeted by an on_conflict upsert.
  if (select count(*) from pg_indexes
       where schemaname = 'public'
         and indexname in ('email_import_messages_rfc_msg_unique',
                           'email_import_messages_external_ref_unique',
                           'email_import_messages_fingerprint_unique')
         and indexdef ilike '%where%') <> 3 then
    raise exception 'the other three dedupe indexes must remain partial -- this fix must not touch them';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. THE bug, reproduced and disproven: the exact insert shape
--    PostgREST generates for claimMessage()'s on_conflict target.
-- ------------------------------------------------------------
do $$
declare
  ua uuid := gen_random_uuid();
  ha uuid;
  conn_a uuid;
  conn_b uuid;
  n int;
  blocked boolean;
begin
  insert into auth.users (id, email, instance_id, aud, role) values
    (ua, 'ledger-fix-a@test.invalid', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');
  insert into households (name, invite_code) values ('Ledger Fix', 'lfixcode') returning id into ha;

  perform set_config('app.household_assign', 'on', true);
  insert into profiles (id, display_name, household_id, slot) values (ua, 'A', ha, 0);
  perform set_config('app.household_assign', 'off', true);

  insert into email_import_connections (user_id, provider, alias_token)
  values (ua, 'gmail', null) returning id into conn_a;
  -- A fixed placeholder is enough here: this test only needs a second,
  -- differently-shaped connection to prove per-connection scoping, not a
  -- real unguessable token.
  insert into email_import_connections (user_id, provider, alias_token)
  values (ua, 'wise_email', 'ledger-fix-test-alias-token-000001') returning id into conn_b;

  -- THE exact statement PostgREST issues for:
  --   email_import_messages?on_conflict=connection_id,provider_message_id
  --   Prefer: resolution=ignore-duplicates
  -- Before this fix, this raised "no unique or exclusion constraint
  -- matching the ON CONFLICT specification" on every single call.
  insert into email_import_messages
    (connection_id, user_id, source, provider_message_id, from_address, received_at, status)
  values (conn_a, ua, 'gmail', 'gmail-msg-1', 'noreply@wise.com', now(), 'received')
  on conflict (connection_id, provider_message_id) do nothing;

  select count(*) into n from email_import_messages where connection_id = conn_a;
  assert n = 1, format('BROKEN: the claim insert did not land a row, got %s', n);

  -- ========================================================
  -- 2a. Re-claiming the SAME (connection, provider_message_id) is a no-op,
  --     not an error and not a second row -- duplicate protection intact.
  -- ========================================================
  insert into email_import_messages
    (connection_id, user_id, source, provider_message_id, from_address, received_at, status)
  values (conn_a, ua, 'gmail', 'gmail-msg-1', 'noreply@wise.com', now(), 'received')
  on conflict (connection_id, provider_message_id) do nothing;

  select count(*) into n from email_import_messages where connection_id = conn_a and provider_message_id = 'gmail-msg-1';
  assert n = 1, format('BROKEN: re-claiming the same message id created a second row, got %s', n);

  -- ========================================================
  -- 2b. The SAME provider_message_id under a DIFFERENT connection is a
  --     different message and must still be claimable.
  -- ========================================================
  insert into email_import_messages
    (connection_id, user_id, source, provider_message_id, from_address, received_at, status)
  values (conn_b, ua, 'resend', 'gmail-msg-1', 'noreply@wise.com', now(), 'received')
  on conflict (connection_id, provider_message_id) do nothing;

  select count(*) into n from email_import_messages where provider_message_id = 'gmail-msg-1';
  assert n = 2, format('BROKEN: two connections sharing an id collapsed to %s row(s)', n);

  -- ========================================================
  -- 2c. Multiple NULL provider_message_id rows still coexist -- the
  --     widened index has not started colliding NULLs against each other.
  -- ========================================================
  insert into email_import_messages (connection_id, user_id, source, from_address, received_at, status)
  values (conn_a, ua, 'gmail', 'noreply@wise.com', now(), 'received');
  insert into email_import_messages (connection_id, user_id, source, from_address, received_at, status)
  values (conn_a, ua, 'gmail', 'noreply@wise.com', now(), 'received');

  select count(*) into n from email_import_messages where connection_id = conn_a and provider_message_id is null;
  assert n = 2, format('BROKEN: two NULL provider_message_id rows collided, got %s', n);

  -- ========================================================
  -- 2d. A malformed/duplicate claim never raises -- one failing message
  --     must not be able to abort a batch.
  -- ========================================================
  blocked := false;
  begin
    insert into email_import_messages
      (connection_id, user_id, source, provider_message_id, from_address, received_at, status)
    values (conn_a, ua, 'gmail', 'gmail-msg-1', 'noreply@wise.com', now(), 'received')
    on conflict (connection_id, provider_message_id) do nothing;
  exception when others then blocked := true;
  end;
  assert not blocked, 'BROKEN: a routine duplicate claim raised instead of silently no-opping';

  raise notice 'LEDGER CLAIM FIX VERIFICATION PASSED — the exact PostgREST on_conflict shape claimMessage() sends now lands a row, re-claims no-op, different connections stay independent, and NULL ids still never collide.';
end $$;

rollback;
