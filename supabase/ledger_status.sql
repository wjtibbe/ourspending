-- OurSpending — email import ledger status.
--
-- READ-ONLY. Pure SELECT: nothing is created, altered, deleted or rolled back.
-- Safe on production at any time. Deliberately returns NO email content, no
-- merchant, no amount and no token -- only counts and states.
--
-- Use this to answer "why did a sync import nothing?" and to see which
-- messages are stuck versus genuinely finished.
--
--   imported   finished, an expense exists (or existed and was deleted)
--   duplicate  dedupe layers 2-4 matched an already-imported transaction
--   skipped    see the reason: most are deliberate and terminal, but
--              no_household / unresolved_slot are transient and DO retry
--   received   claimed but never finished -- a run died mid-batch. RETRYABLE
--   failed     errored before or during expense creation. RETRYABLE
--   unparsed   the parser did not recognise the template. RETRYABLE

-- 1. Overall shape of the ledger, with the retry verdict per state.
select
  status,
  coalesce(skip_reason, '-')                as skip_reason,
  count(*)                                  as messages,
  count(expense_id)                         as with_expense,
  case
    when status in ('received', 'failed', 'unparsed')            then 'RETRYABLE'
    when status = 'skipped'
     and skip_reason in ('no_household', 'unresolved_slot')      then 'RETRYABLE'
    else 'TERMINAL'
  end                                       as on_next_sync,
  min(received_at)                          as oldest,
  max(received_at)                          as newest
from public.email_import_messages
group by status, skip_reason
order by on_next_sync desc, messages desc;

-- 2. The specific problem this query exists to catch: rows that were claimed but
--    never produced an expense. Before the retry fix these were skipped as
--    duplicates forever; now they are picked up by the next sync, provided the
--    message is still inside the Gmail lookback window.
select
  count(*) filter (where status = 'received')  as stuck_at_received,
  count(*) filter (where status = 'failed')    as failed,
  count(*) filter (where status = 'unparsed')  as unparsed,
  count(*) filter (
    where status in ('received', 'failed', 'unparsed')
      and received_at < now() - interval '8 days'
  )                                            as retryable_but_outside_lookback
from public.email_import_messages;

-- 3. Messages that keep failing. attempt_count is populated from the retry
--    fix onward, so 0 here means "predates that column", not "never tried".
select
  id,
  status,
  coalesce(skip_reason, error_summary, '-') as reason,
  attempt_count,
  last_attempt_at
from public.email_import_messages
where attempt_count > 1
order by attempt_count desc, last_attempt_at desc nulls last
limit 50;
