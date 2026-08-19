-- OurSpending — retry visibility on the email import ledger.
--
-- SAFETY: additive and idempotent. Two new columns on the existing
-- email_import_messages ledger, both defaulted or nullable. No table, column,
-- policy, grant, function, index or row is dropped, renamed or rewritten.
-- `expenses` is untouched, and no historical ledger row changes meaning.
--
-- CONTEXT
--
-- claimMessage() used to treat ANY existing (connection_id,
-- provider_message_id) row as a duplicate, without reading that row's status.
-- A row left at `received` (the run died mid-batch), `failed`, or `unparsed`
-- therefore blocked its message from ever being imported again -- the message
-- was seen on every subsequent sync and skipped every time.
--
-- The fix is in code: the existing row's own state now decides whether the
-- message is retried or genuinely skipped. That fix needs NO schema change,
-- because `status` (received/imported/skipped/unparsed/failed/duplicate) and
-- `expense_id` already carry enough state to tell the cases apart.
--
-- These two columns are therefore diagnostics, not mechanism: they make
-- "this message has been retried 40 times and still fails" visible, which the
-- status alone cannot express. Nothing branches on them, and in particular
-- there is deliberately NO retry cap: capping retries would reintroduce the
-- exact failure mode being fixed here -- a message permanently stuck through
-- no fault of its own.

alter table public.email_import_messages
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_attempt_at timestamptz;

comment on column public.email_import_messages.attempt_count is
  'How many times this message has been claimed for import, including retries. '
  'Diagnostic only -- nothing branches on it and there is no retry cap.';

comment on column public.email_import_messages.last_attempt_at is
  'When this message was most recently claimed for import. Diagnostic only.';

-- Existing rows keep attempt_count = 0 rather than being backfilled to 1: a
-- rewrite of historical rows would be a claim about attempts that were never
-- actually recorded. 0 honestly means "predates this column".

-- Column-level SELECT grants on this table are additive in PostgREST: naming
-- a column here never revokes one granted earlier. Re-issued so the two new
-- columns are readable by the owner alongside the existing ones. The raw
-- retention columns (raw_text, raw_html) remain deliberately absent.
grant select (
  id, connection_id, user_id, household_id, source,
  provider_message_id, rfc_message_id, external_ref, fingerprint,
  received_at, from_address, status, skip_reason, error_summary,
  merchant, amount_value, amount_currency,
  merchant_amount_value, merchant_amount_currency,
  occurred_at, mapped_category, category_source, category_match,
  expense_id, attempt_count, last_attempt_at
) on public.email_import_messages to authenticated;
