-- OurSpending — recover ledger rows that deduplicated against themselves.
--
-- WHY THIS EXISTS
--
-- Dedupe layers 2-4 in email-import-core.ts searched for another ledger row
-- with the same rfc_message_id / external_ref / fingerprint, but did not
-- exclude the row being processed. On a FIRST attempt that was harmless: the
-- row has no rfc_message_id yet at that point. On a RETRY it was not -- the
-- previous attempt had already stamped the value onto that very row, so the
-- retry found itself, marked the row `duplicate`, and returned "duplicate".
--
-- `duplicate` is a terminal state, so each retried row was converted from
-- retryable (`unparsed` / `failed` / `received`) into permanently skipped, on
-- its first retry. That is the opposite of what the retry path exists to do,
-- and it is why a sync could report 31 retried rows with imported, unparsed,
-- skipped and failed all at zero.
--
-- The code fix (`&id=neq.<rowId>` on all three dedupe lookups) stops it
-- happening again. It cannot repair rows that were already converted, because
-- they now look exactly like a legitimate terminal duplicate.
--
-- WHAT THIS DOES
--
-- Resets ONLY rows that are provably self-collisions: marked
-- `duplicate` / `rfc_message_id` while being the ONLY row that carries that
-- rfc_message_id for that connection. A genuine cross-row duplicate always has
-- a sibling holding the same id, so it is never touched.
--
-- Rows are reset to `unparsed`, which is retryable, so the next sync
-- re-processes them through the corrected parser. Nothing is deleted, no
-- expense is created, altered or removed, and no historical expense is
-- rewritten.
--
-- HOW TO RUN
--
-- Step 1 is read-only: run it first and check the count looks like what you
-- expect. Step 2 performs the update. Both are safe to re-run; step 2 is
-- idempotent because a repaired row no longer matches the filter.

-- ---------------------------------------------------------------------------
-- STEP 1 — inspect (read-only, changes nothing)
-- ---------------------------------------------------------------------------
select
  count(*) as self_deduped_rows_to_repair
from public.email_import_messages m
where m.status = 'duplicate'
  and m.skip_reason = 'rfc_message_id'
  and m.rfc_message_id is not null
  -- Same guard as the UPDATE below, so this count and the number of rows
  -- actually repaired always agree. A `duplicate` row that nonetheless has an
  -- expense_id did produce an expense and must not be re-run.
  and m.expense_id is null
  and not exists (
    select 1
    from public.email_import_messages other
    where other.connection_id = m.connection_id
      and other.rfc_message_id = m.rfc_message_id
      and other.id <> m.id
  );

-- For contrast: genuine cross-row duplicates, which this script leaves alone.
select
  count(*) as genuine_duplicates_left_untouched
from public.email_import_messages m
where m.status = 'duplicate'
  and m.skip_reason = 'rfc_message_id'
  and m.rfc_message_id is not null
  and exists (
    select 1
    from public.email_import_messages other
    where other.connection_id = m.connection_id
      and other.rfc_message_id = m.rfc_message_id
      and other.id <> m.id
  );

-- ---------------------------------------------------------------------------
-- STEP 2 — repair
-- ---------------------------------------------------------------------------
-- Wrapped so you can inspect the affected count and ROLLBACK instead of
-- COMMIT if it does not match step 1. Replace ROLLBACK with COMMIT to apply.

begin;

update public.email_import_messages m
   set status      = 'unparsed',
       skip_reason = 'reset_self_dedupe',
       -- expense_id stays exactly as it is. These rows never created an
       -- expense (that is why they were being retried), and clearing a
       -- populated one would orphan a real expense.
       updated_at  = now()
 where m.status = 'duplicate'
   and m.skip_reason = 'rfc_message_id'
   and m.rfc_message_id is not null
   and m.expense_id is null            -- belt and braces: never touch a row that imported
   and not exists (
     select 1
     from public.email_import_messages other
     where other.connection_id = m.connection_id
       and other.rfc_message_id = m.rfc_message_id
       and other.id <> m.id
   );

-- Confirm before deciding.
select count(*) as rows_now_retryable
  from public.email_import_messages
 where skip_reason = 'reset_self_dedupe';

rollback;  -- <<< change to COMMIT to apply

-- ---------------------------------------------------------------------------
-- AFTER COMMITTING
-- ---------------------------------------------------------------------------
-- Run a manual sync. The repaired rows are `unparsed`, which the retry path
-- treats as retryable, so they are re-processed through the corrected parser.
--
-- Only messages still inside the Gmail lookback window are re-fetched
-- (`newer_than:8d` by default). `supabase/ledger_status.sql` reports how many
-- retryable rows fall outside it as `retryable_but_outside_lookback`; if that
-- is greater than zero, temporarily raise GMAIL_LOOKBACK_DAYS, sync, then set
-- it back. See DEPLOYMENT.md.
