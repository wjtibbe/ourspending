-- OurSpending — fix email_import_messages dedupe-key-1 upsert compatibility.
--
-- SAFETY: additive/idempotent. Replaces ONE index (drop + recreate under the
-- same name) with a behaviorally equivalent one. No column, table, policy,
-- grant or row is touched otherwise.
--
-- Run AFTER supabase/email_import.sql (and after supabase/gmail_import.sql,
-- if applied -- order between the two does not matter).
-- Then run supabase/verify_email_import_ledger_fix.sql.
--
-- ============================================================
--  ROOT CAUSE
-- ============================================================
-- claimMessage() in _shared/email-import-core.ts -- the FIRST step of
-- importing ANY message, Resend or Gmail -- claims dedupe key 1 with:
--
--   email_import_messages?on_conflict=connection_id,provider_message_id
--   Prefer: resolution=ignore-duplicates
--
-- PostgREST turns that into:
--
--   INSERT ... ON CONFLICT (connection_id, provider_message_id) DO NOTHING
--
-- with NO WHERE clause -- PostgREST's on_conflict query parameter has no
-- syntax for one. Postgres will only match a bare `ON CONFLICT (columns)`
-- (no WHERE) against a unique index that ALSO has no WHERE clause. The only
-- unique index that existed on those two columns was the PARTIAL one from
-- email_import.sql (`where provider_message_id is not null`), so Postgres
-- rejected every single claim attempt with:
--
--   ERROR: there is no unique or exclusion constraint matching the
--   ON CONFLICT specification
--
-- before a single ledger row could ever be written -- for every message,
-- deterministically, regardless of its content. This reproduces exactly
-- (confirmed against real PostgreSQL 16): messagesSeen > 0, every outcome
-- landing in the generic per-message catch as "failed", and
-- email_import_messages staying completely empty.
--
-- This was latent since email_import.sql first shipped the Resend adapter --
-- never exercised by the FakeDb-based unit tests (which do not replicate
-- Postgres's exact ON-CONFLICT-target-matching rules) or by
-- verify_email_import.sql (which inserts with plain SQL, never through
-- PostgREST's on_conflict). It first became visible now because this is the
-- first time a real sync actually POSTed through the live PostgREST
-- endpoint.
--
-- ============================================================
--  WHY THIS FIX DOES NOT WEAKEN DEDUPE OR WIDEN ANYTHING
-- ============================================================
-- Ordinary SQL UNIQUE semantics already treat NULL as never equal to
-- another NULL -- multiple rows with provider_message_id IS NULL were
-- always allowed to coexist under a plain UNIQUE index too, exactly as
-- under the partial one. The WHERE clause on the original index was an
-- (unnecessary, if harmless) optimisation to shrink the index, not what
-- gave NULLs their non-colliding behaviour -- that behaviour is
-- unconditional in SQL and is unaffected by this change.
--
-- The other three dedupe keys (rfc_message_id, external_ref, fingerprint)
-- are genuinely optional per-message and are checked with explicit SELECT
-- logic in importClaimedMessage(), never upserted via on_conflict -- so
-- their partial indexes are correct as they are and are untouched here.
-- provider_message_id is different: both current adapters (Resend, Gmail)
-- always supply a real, non-null id before a row is ever claimed -- an
-- envelope/message with no id is rejected before claimMessage() is called
-- at all (parseEnvelope()/gmailToInboundMessage() both return null) -- so
-- widening this one index to match every row costs nothing in practice and
-- fixes a hard failure in every practice.

drop index if exists public.email_import_messages_provider_msg_unique;

create unique index if not exists email_import_messages_provider_msg_unique
  on public.email_import_messages (connection_id, provider_message_id);

comment on index public.email_import_messages_provider_msg_unique is
  'Full (non-partial) index: required so PostgREST''s on_conflict=connection_id,provider_message_id upsert target (which cannot express a WHERE predicate) actually matches it. Behaviorally identical to the partial index it replaces -- ordinary SQL UNIQUE semantics already let multiple NULL provider_message_id rows coexist.';
