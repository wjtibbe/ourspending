# Tests

No build step and no dependencies: these run the exact `.ts` modules the Edge
Functions import, using Node's native type stripping (Node 22.6+).

    node --experimental-strip-types tests/categories.test.ts
    node --experimental-strip-types tests/sync.test.ts
    node --experimental-strip-types tests/wise-connect.test.ts
    node --experimental-strip-types tests/wise-sync-client.test.ts
    node --experimental-strip-types tests/import-core.test.ts
    node --experimental-strip-types tests/inbound-email.test.ts
    node --experimental-strip-types tests/gmail-import.test.ts
    node --experimental-strip-types tests/gmail-cors.test.ts
    node --experimental-strip-types tests/merchant-categorization.test.ts
    node --experimental-strip-types tests/import-retry.test.ts
    node --experimental-strip-types tests/gmail-discovery.test.ts
    node tests/expense-display.test.js

`categories.test.ts` covers the mapping layer: multilingual aliases, MCC codes,
resolution priority, deactivated household categories, and the guarantee that
an unknown value always lands on an existing app category rather than inventing
one.

`sync.test.ts` drives `_shared/sync.ts` — the same core used by both the hourly
cron job and the "Sync now" button — against a fake PostgREST and a fake Wise
API. It covers idempotency, the pending/reversed/cancelled/declined/failed and
incoming skips, the balance-vs-merchant amount choice under currency
conversion, and isolation of a failing transaction or a failing connection.

`wise-connect.test.ts` drives `verifyWiseToken()` in `_shared/wise.ts` — the
only place Connect/Reconnect checks a token — against a fake fetch. It proves
the request is exactly `GET {base}/v1/me` with `Authorization: Bearer
<trimmed token>`, that whitespace around a pasted token is stripped before the
call, that `/v1/profiles`/balances/statement are never requested at connect
time, that a 200 marks the connection `connected` (via `buildConnectionRow` in
`provider-connect/index.ts`), that 401/403/429/5xx/network map to distinct
`token_refused` / `token_forbidden` / `wise_rate_limited` /
`wise_temporarily_unavailable` codes, and that nothing beyond a name and an id
ever leaves `verifyWiseToken` — no token, no raw response, no email, phone,
address or date of birth.

`wise-sync-client.test.ts` drives `createWiseClient()` in `_shared/wise.ts` —
the client the hourly job and "Sync now" use to actually read data — against a
fake fetch. It proves profile listing is exactly `GET {base}/v2/profiles`
(not `/v1/profiles`, which requires broader permissions than a plain Personal
Access Token carries and rejected a real, confirmed-valid token), that
`balances()`/`statement()` are unchanged, that a PERSONAL profile is accepted
with no business-profile requirement, that 401/403/429 map to three distinct
`WiseAuthError` codes (`invalid_token` / `insufficient_permissions` /
`wise_rate_limited`) rather than being collapsed into one, that a 5xx or a
network failure is deliberately NOT a `WiseAuthError` (so it maps to
`provider_unreachable` upstream in `_shared/sync.ts`), and that Connect
(`verifyWiseToken`, `/v1/me`) and Sync (`createWiseClient`, `/v2/profiles`)
never cross-call each other's endpoint.

`import-core.test.ts` drives `_shared/import-core.ts` — the provider-neutral
importer shared by every input method. It proves the rules that must hold no
matter where a transaction came from: household and payer slot resolved from
the database (never a payload, never defaulted), shared expenses with the
owner as payer, EUR conversion identical to `app.js`, EUR/USD/COP enforced,
declined/reversed/refund/incoming never imported, disabled household
categories not resurrected, and per-user isolation.

It also covers the authoritative-amount/merchant-metadata rules for
converted-currency imports (the Éxito Express example: deducted 19.76 EUR,
merchant charged 71,362 COP): the deducted amount is always what is stored as
`amount_orig`/`currency`, the merchant amount is retained separately in
`merchant_amount`/`merchant_currency` and flagged via
`had_currency_conversion` only when the two currencies genuinely differ, a
later household rate change never rewrites either stored figure, a
direct-currency payment (or one with no merchant amount at all) never
invents a conversion, and `createExpense` still creates exactly one expense
per transaction. `amount_authority` is asserted to be set unconditionally —
it records a fact of the `NormalizedTransaction` contract itself, not
something a caller opts into — while `source_provider`/`conversion_source`
are asserted to default to `null` when a caller (like every pre-existing
test in this file) does not pass them.

`inbound-email.test.ts` covers the inbound plumbing that does not depend on
any bank's template: Svix signature verification (tampering, wrong secret,
missing headers, replay via old and future timestamps, multi-signature key
rotation), alias resolution, sender authenticity including lookalike domains,
locale-aware money parsing (`45.000` → 45000, the Colombian 1000x trap), HTML
reduction, and fingerprint dedupe bucketing. It also covers the 7-day
retention layer: sanitisation removing scripts/styles/images/remote URLs and
redacting emails, card numbers and IBANs while KEEPING amounts, merchants and
references (the parse targets), the size cap, the exact 7-day expiry, and that
a non-matching message is recorded as `unparsed` without ever creating an
expense.

It also covers the one template implemented so far — the completed
card-payment email ("You spent 71,362 COP at Éxito Express." / "This used
19.76 EUR from your account.") — against both a plain-text and an
HTML-reduced fixture built from the same real anonymised sample: the deducted
account amount becomes the expense amount, the merchant amount is kept only
as metadata, no reference or date is invented, and mail that does not match
this exact template (declined/reversed/refunds, anything else) still falls
through to `unparsed` / `parser_awaiting_samples` rather than being guessed
at. An end-to-end case then runs that extracted transaction through
`import-core.ts` and asserts the resulting expense row: one expense created,
the deducted EUR amount stored as `amount_orig`, the merchant COP amount
stored separately, and `had_currency_conversion` true.

`gmail-import.test.ts` covers the Gmail half of the import path: base64url
decoding (including the multi-byte UTF-8 trap that turns "Éxito" into
"Ãxito" if the bytes skip TextDecoder), MIME walking across flat,
multipart/alternative and nested multipart/mixed structures with attachments
skipped, RFC 2047 encoded-word headers, the deliberately narrow Gmail search
(`from:(wise.com OR transferwise.com) newer_than:8d`, plus an optional
label — see `gmail-discovery.test.ts` for why it is domains, not one address),
message-list pagination, OAuth state/PKCE generation and the consent URL
(gmail.readonly only, `access_type=offline`, S256, consent forced on first
connect but not on reconnect), the token-endpoint error taxonomy — with
`invalid_grant` mapped to its own `reconnect_required` code rather than being
collapsed into a generic failure — and end to end: one completed Wise email
becomes exactly one shared expense with the connected user as payer, the
daily lookback overlap creates no duplicate, the same mail under two Gmail
ids still dedupes on `Message-ID`, an unparsed email creates no expense, one
malformed message does not stop the ones after it, one failing connection
does not stop other users, an expired access token is refreshed and a rotated
refresh token is honoured, and no token ever reaches the ledger.

It also has dedicated regression coverage for a real production incident: 14
production-shaped Gmail messages all reaching `email_import_messages` (not
zero — the exact symptom when the ledger-claim insert cannot match its unique
index; see `supabase/migrations/20260806211500_email_import_ledger_fix.sql`), a repeat run over the
same messages producing zero new expenses and all 14 counted as duplicates,
and — using a FakeDb that reproduces the exact failure mode being fixed — that
a broken claim path logs `stage=ledger_claim` plus a sanitised reason for
every one of the 14 (never the merchant, amount, subject, a token or
ciphertext), that the connection is not wrongly reported as failed for a
per-message problem, and that one failing message never stops the ones after
it.

The Wise parsing and expense rules are deliberately NOT re-tested there: both
adapters run the same `_shared/email-import-core.ts`, so those rules are
covered once, by `inbound-email.test.ts` and `import-core.test.ts`.

`gmail-cors.test.ts` drives the actual `Deno.serve` handler in
`gmail-oauth-start`, `gmail-sync` and `gmail-disconnect` — not a
reimplementation, the real callback each file passes to `Deno.serve()`,
captured via a stubbed `Deno.serve` — against a simulated CORS preflight and
real POST requests. It is regression coverage for a real bug: their
`Access-Control-Allow-Headers` omitted `apikey` and `x-client-info`, which
supabase-js's `functions.invoke()` always sends, so the browser silently
refused to send the POST after an OPTIONS that returned 200. It proves the
preflight response covers every header a real `functions.invoke()` call
sends, that a POST response carries the identical CORS headers (success,
missing-auth and wrong-secret cases alike), that a request with no
Authorization header — and one with a bearer token Supabase rejects — both
still get a 401 rather than silently proceeding, and that a genuinely
signed-in POST to `gmail-oauth-start` still returns a usable Google consent
URL with no secret in the response. Checked out against the pre-fix code, 33
of these assertions fail; against the fix, all pass.

`merchant-categorization.test.ts` drives `_shared/merchant-categorization.ts`
— the five-layer categoriser (household rule → existing global/keyword
mapping via `resolveCategory` → AI → `other`) that `email-import-core.ts`
calls for every Wise Gmail import. It proves priority order end to end: a
household's own learned rule beats every other source (and a rule pointing
at a category the household has since disabled is not resurrected — it falls
through to the keyword layer instead); `normalizeMerchant()` collapses
`UBER *TRIP` / `Uber BV` / `UBER COLOMBIA` onto the same normalized form
without merging genuinely different merchants like `Uber Eats`; the EN/ES/NL
keyword groups (transport, groceries, dining, subscriptions, entertainment)
each map every listed word to the same canonical category; an unrecognised
merchant reaches the AI classifier with exactly `{merchant, subject,
categories}` and nothing amount/currency/email-shaped; a low-confidence
(<0.85) or invalid AI reply is discarded in favour of `other`, at an exact
boundary check on `AI_CONFIDENCE_THRESHOLD`; a throwing, disabled, or hung AI
classifier never blocks categorisation, and `createAiClassifier`'s own
10-second `AbortController` timeout resolves to `null` rather than hanging;
a manually-taught household rule is picked up by later imports for the same
merchant without rewriting any historical expense already stored under the
old category; one household's rule never leaks into another's; and a broken
rule lookup still falls through to the keyword layer rather than failing the
import.

`import-retry.test.ts` is regression coverage for a real production incident:
a manual sync reported `messagesSeen: 39, duplicatesSkipped: 39,
expensesImported: 0` on a day the user had definitely made purchases.
`claimMessage()` treated ANY existing `(connection_id, provider_message_id)`
row as a duplicate without reading that row's status, so a row left at
`received` (a run that died mid-batch), `failed`, or `unparsed` blocked its
message from ever importing again. It pins the replacement rule — a message is
skipped only when a previous run genuinely imported it or deliberately and
terminally skipped it — across: the full retryable/terminal state table
(including that an unknown or future status is treated as terminal, never
retryable); first import; repeat import as a duplicate; failure before expense
creation; retry after that failure actually creating the expense; retrying
again being a duplicate with still exactly one expense; a row stuck at
`received` being recovered; an `unparsed` message importing once the parser
supports it; a declined transaction staying terminally skipped; an `imported`
row never re-importing even when `expense_id` is null (a deliberately deleted
expense is not resurrected); one bad message not blocking the ones after it;
the 39-message incident reproduced at scale and then becoming a clean no-op;
retry still working when the diagnostics migration has not been applied; and
an unreadable ledger failing closed rather than double-importing. Gmail ids are
production-shaped 16-character hex, and each message is a distinct amount so
the fingerprint dedupe layer is not what is being measured.

`gmail-discovery.test.ts` covers the layer before everything else: which
messages Gmail is even asked for. It is regression coverage for the third act
of a real incident — after the ledger-claim fix and the retry fix, a sync still
reported 39 seen / 39 duplicates / 0 imported on a day with real purchases,
with nothing stuck in the ledger. Nothing was failing because nothing was being
found: discovery asked for the single literal address `from:noreply@wise.com`
while the sender gate that runs afterwards (`isWiseSender`) has always accepted
any `wise.com`/`transferwise.com` address including subdomains, so a notice
from any other Wise address passed every check in the importer but was never
listed — leaving no ledger row, no failure and no counter.

It pins: the query covers exactly the domains `WISE_SENDER_DOMAINS` trusts (a
loop over that constant, so discovery can never again be narrower than
validation), stays sender-scoped and time-bounded, uses one `from:(a OR b)`
term rather than two ANDed terms that would match nothing, and never reaches
into Spam or Trash (a From header is trivially spoofable, so Gmail's own spam
classification is load-bearing). Then end to end against a fake Gmail that
actually honours the `from:` term: `noreply@wise.com` still imports; the same
notice from `no-reply@`, `notifications@`, `e.wise.com` and `transferwise.com`
now imports; **the same message under the old narrow query lists nothing and
reports zero failures, zero skips and zero duplicates** — proving the test is
meaningful and that the symptom was silent absence; Wise marketing mail is
discovered but rejected at the template gate with a ledger row rather than
vanishing; a lookalike domain is never listed and is independently refused by
the sender gate; today's message imports on the very next sync; a message
outside the lookback is excluded; and duplicate safety is intact — including
that the same transaction arriving from two different Wise addresses still
creates only one expense.

`expense-display.test.js` drives `expense-display.js` — the pure function
`app.js` uses to decide what an expense row's large/small amounts show. It
proves: a display currency matching the deducted amount shows that amount
exactly with the merchant amount as the secondary line; a display currency
matching the merchant amount shows *that* exactly instead, with the deducted
amount as secondary; a genuine third currency is the only case that calls the
app's normal EUR-based conversion; a stale/updated rate cannot affect the two
exact-match branches, because they never call the conversion function at all;
a direct (unconverted) payment and a plain manual expense both behave exactly
as they did before this module existed, with no secondary line when the
currencies already match.

## Database-level verification

Run in the Supabase SQL editor. Each wraps itself in a transaction that ends in
`ROLLBACK`, so production data is never modified.

    supabase/verify_rls.sql                        -> VERIFICATION PASSED
    supabase/verify_provider_connections.sql       -> PROVIDER VERIFICATION PASSED
    supabase/verify_wise_transactions.sql          -> WISE LEDGER VERIFICATION PASSED
    supabase/verify_email_import.sql               -> EMAIL IMPORT VERIFICATION PASSED
    supabase/verify_expense_conversion_fields.sql  -> EXPENSE CONVERSION FIELDS VERIFICATION PASSED
    supabase/verify_gmail_import.sql               -> GMAIL IMPORT VERIFICATION PASSED
    supabase/verify_email_import_ledger_fix.sql    -> LEDGER CLAIM FIX VERIFICATION PASSED
    supabase/verify_merchant_category_rules.sql    -> MERCHANT CATEGORY RULES VERIFICATION PASSED

`verify_email_import.sql` additionally proves the retention contract: the
default expiry is seven days, the purge leaves unexpired content alone, an
expired purge clears the body while preserving ids, hashes, status, metadata
and the linked expense, the purge is idempotent, and neither the owner nor any
other user can read `raw_text`/`raw_html` or execute the purge.

`verify_expense_conversion_fields.sql` proves the six new `expenses` columns
exist and stay optional (a pre-existing plain expense gets
`had_currency_conversion = false` and no invented merchant amount), that a
Wise-style conversion row stores both exact amounts and the right flags, that
a simulated later household rate change leaves an already-stored row
untouched, and that exactly one expense exists per import (no double
counting). Verified on real PostgreSQL 16.

`verify_gmail_import.sql` proves the Gmail-specific database contract: an
OAuth state is single-use (a replay resolves to no user), expires, and is
bound to the user who started the flow; refresh tokens and PKCE verifiers are
unreadable by every client role including the row's own owner; the
`alias_token` shape constraint keeps a forwarding connection from existing
without an alias and a Gmail one from carrying a stray alias; Gmail message
ids dedupe per connection but not across users; and disconnecting takes the
credential and the ledger rows with it. Verified on real PostgreSQL 16.

`verify_email_import_ledger_fix.sql` proves the fix for a real production
incident where every inbound message failed at the very first ledger insert.
It reproduces the exact statement PostgREST issues for
`claimMessage()`'s `on_conflict=connection_id,provider_message_id` target —
confirmed, checked out against the pre-fix schema, to fail with "there is no
unique or exclusion constraint matching the ON CONFLICT specification" on
every attempt — and proves that with the fix applied: the claim lands a row,
re-claiming the same id no-ops rather than duplicating, the same id under a
different connection is still claimable, multiple `NULL` `provider_message_id`
rows still never collide with each other, and the other three dedupe indexes
(which are never targeted by an `on_conflict` upsert) are untouched and still
partial. Verified on real PostgreSQL 16, both against a fresh database and
after `email_import.sql`/`gmail_import.sql` have already been applied.

`verify_merchant_category_rules.sql` proves the household-learned-rule table:
a household can create and read its own rule; re-teaching the same merchant
updates the existing row in place rather than duplicating it; another
household can neither read, update, nor insert into the first household's
rows, but can freely create its own rule for the same normalized merchant
because the unique constraint is per-household; a second rule for the same
household+merchant is rejected as a `unique_violation`; the `anon` role has
no privilege on the table at all; and a blank or whitespace-only
`normalized_merchant` is rejected by a CHECK constraint. Verified on real
PostgreSQL 16, including a clean idempotent re-run of the migration and a
re-run of every pre-existing verify script above with no regression.
