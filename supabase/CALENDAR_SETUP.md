# Calendar setup

## 1. Database (required — do this first)

Supabase dashboard → **SQL Editor** → New query → paste the contents of
`supabase/calendar.sql` → **Run**.

This creates three tables and leaves all existing data untouched:

| Table | Purpose |
|---|---|
| `calendar_events` | The shared household calendar |
| `calendar_connections` | One row per connected external calendar, per user |
| `calendar_oauth_tokens` | OAuth tokens — RLS on, **no policies**, so only Edge Functions using the `service_role` key can read them. Never reachable from the browser. |

Until this runs, the Calendar tab shows a clear message telling you to run it.

---

## 2. What works right now, with zero extra configuration

**Download `.ics`** — Settings (Budgets tab) → *Calendar sync* → **Download .ics file**.

Produces a standards-compliant RFC 5545 file including recurrence rules
(`RRULE`), all-day events, locations and descriptions. Import it into Apple
Calendar, Google Calendar or Outlook. This is a one-time snapshot, not a live
feed.

---

## 3. Live subscription feed (optional — needs one Edge Function deploy)

A subscribe-by-URL feed keeps the phone calendar updating automatically and
needs **no OAuth and no developer account** — it is the cheapest path to
"my events show up on my phone".

Deploy `supabase/functions/calendar-feed` (dashboard → Edge Functions → create
`calendar-feed` → paste `index.ts` → Deploy), then set its config to
**Verify JWT = OFF** (calendar apps cannot send an auth header).

Security model: the feed is protected by an unguessable per-household token
rather than a login. Generate one with:

```sql
insert into public.calendar_feeds (household_id, token)
values ('<your-household-id>', encode(gen_random_bytes(24), 'hex'))
returning token;
```

Subscribe URL:

```
https://cleeaaqyhmevacsfjawi.supabase.co/functions/v1/calendar-feed?token=<token>
```

- **iOS**: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar
- **Google Calendar**: Other calendars → + → From URL
- **Outlook**: Add calendar → Subscribe from web

Anyone holding the token can read the calendar, so treat it like a password.
Revoke by deleting the row.

---

## 4. Google / Apple / Outlook two-way sync (not connected — needs credentials)

The data model, the connection UI, the sync-status/`last_synced_at` fields, the
external-ID de-duplication index and the server-only token table are all built.
What is **not** built is a working OAuth handshake, because it cannot exist
without credentials that only you can create. The UI therefore labels these
providers *Setup required* and does not pretend to connect.

To finish each provider you need to supply:

### Google Calendar
1. Google Cloud project → enable **Google Calendar API**
2. OAuth consent screen (External), scope `https://www.googleapis.com/auth/calendar`
3. OAuth 2.0 Client ID (Web application)
4. Authorised redirect URI:
   `https://cleeaaqyhmevacsfjawi.supabase.co/functions/v1/calendar-oauth/google/callback`
5. Supabase secrets:
   `supabase secrets set GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=…`

### Microsoft Outlook
1. Azure Portal → App registrations → new registration
2. Microsoft Graph delegated permission `Calendars.ReadWrite`
3. Redirect URI:
   `https://cleeaaqyhmevacsfjawi.supabase.co/functions/v1/calendar-oauth/outlook/callback`
4. Secrets: `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`

### Apple Calendar
Apple publishes no OAuth calendar API. Two real options:
- **CalDAV** with an app-specific password (iCloud → Sign-In and Security →
  App-Specific Passwords), stored in `calendar_oauth_tokens`; or
- the subscription feed from section 3, which is what most people actually want.

Nothing above is hardcoded anywhere in the repo, and no secret is ever sent to
the browser: the client only ever reads `calendar_connections`, never
`calendar_oauth_tokens`.

---

## 5. Sync semantics already encoded in the schema

- `sync_direction` — `import` / `export` / `both`
- `sync_status` — `disconnected` / `connected` / `syncing` / `error`
- `last_synced_at`, `last_error`
- Duplicate protection: unique index on
  `(household_id, provider, external_event_id)` where `external_event_id` is not
  null, so re-importing the same external event can never create a second copy.
- `external_etag` is reserved for conditional fetches once a provider is wired up.
