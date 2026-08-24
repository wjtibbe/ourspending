// Sync health + household timezone tests.
//
//   node tests/sync-health.test.js
//
// Drives sync-health.js -- the pure module app.js uses to decide the Gmail
// card's status badge and the Settings timezone field. No React, no DOM, no
// network: everything here is a pure function, so the rules can be asserted
// directly rather than through a browser.
//
// Two rules carry the most weight:
//
//   * a dead OAuth grant must never be reported as merely "delayed", because
//     waiting does not fix it -- only reconnecting does;
//   * "delayed" is measured from the last SUCCESS, not the last ATTEMPT. An
//     hourly job that fails silently every hour would otherwise look healthy
//     forever, which is precisely the failure this card exists to surface.

const H = require("../sync-health.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

const NOW = new Date("2026-08-24T14:30:00.000Z");
const ago = (hours) => new Date(NOW.getTime() - hours * 3600000).toISOString();

const conn = (over = {}) => ({
  id: "conn-1",
  enabled: true,
  status: "active",
  last_checked_at: ago(0.1),
  last_synced_at: ago(0.5),
  last_error: null,
  ...over,
});

console.log("\n-- healthy --");
{
  const h = H.syncHealth(conn(), NOW);
  check("a recent successful sync is healthy", h.state === "healthy", JSON.stringify(h));
  check("it reports the last success", h.lastSuccessAt === ago(0.5));
  check("and the next expected run", typeof h.nextExpectedAt === "string");

  check("exactly at the threshold is still healthy",
    H.syncHealth(conn({ last_synced_at: ago(H.DELAY_HOURS) }), NOW).state === "healthy");
  check("the threshold is 2 hours", H.DELAY_HOURS === 2);
}

console.log("\n-- delayed --");
{
  const h = H.syncHealth(conn({ last_synced_at: ago(3) }), NOW);
  check("no successful sync for 3 hours is delayed", h.state === "delayed", JSON.stringify(h));
  check("just past the threshold flips to delayed",
    H.syncHealth(conn({ last_synced_at: ago(2.01) }), NOW).state === "delayed");

  // The case that matters: the job RUNS hourly but never SUCCEEDS.
  const silentlyStuck = H.syncHealth(
    conn({ last_checked_at: ago(0.05), last_synced_at: ago(9) }), NOW);
  check("a job that keeps running but never succeeds is delayed, not healthy",
    silentlyStuck.state === "delayed", JSON.stringify(silentlyStuck));
}

console.log("\n-- reconnect needed --");
{
  for (const err of ["reconnect_required", "insufficient_scope", "invalid_grant"]) {
    const h = H.syncHealth(conn({ last_error: err }), NOW);
    check(`"${err}" -> reconnect`, h.state === "reconnect", JSON.stringify(h));
    check(`  and carries the reason`, h.reason === err);
  }
  // Priority: reconnect must win even when the sync is also stale.
  check("reconnect outranks delayed",
    H.syncHealth(conn({ last_error: "reconnect_required", last_synced_at: ago(50) }), NOW)
      .state === "reconnect");
  // ...and even when a sync succeeded moments ago.
  check("reconnect outranks a recent success",
    H.syncHealth(conn({ last_error: "reconnect_required", last_synced_at: ago(0.1) }), NOW)
      .state === "reconnect");
}

console.log("\n-- last sync failed --");
{
  for (const err of ["provider_unreachable", "rate_limited", "gmail_error", "sync_failed"]) {
    const h = H.syncHealth(conn({ last_error: err }), NOW);
    check(`"${err}" -> failed (not reconnect)`, h.state === "failed", JSON.stringify(h));
  }
  check("failed outranks delayed",
    H.syncHealth(conn({ last_error: "rate_limited", last_synced_at: ago(50) }), NOW)
      .state === "failed");
}

console.log("\n-- other states --");
{
  check("no connection at all", H.syncHealth(null, NOW).state === "none");
  check("a paused connection is 'disabled', not a health problem",
    H.syncHealth(conn({ enabled: false }), NOW).state === "disabled");
  check("connected but never synced is 'awaiting', not 'delayed'",
    H.syncHealth(conn({ last_synced_at: null }), NOW).state === "awaiting");
  check("an unparseable last_synced_at is treated as never synced",
    H.syncHealth(conn({ last_synced_at: "not-a-date" }), NOW).state === "awaiting");
}

console.log("\n-- next expected sync tracks the hourly cron --");
{
  // The cron fires at minute 0, so the next run is the top of the next hour --
  // not "last sync + 1h", which would drift and be wrong for a connection
  // that has never synced.
  const h = H.syncHealth(conn(), new Date("2026-08-24T14:30:00.000Z"));
  check("14:30 -> next expected 15:00", h.nextExpectedAt === "2026-08-24T15:00:00.000Z",
    String(h.nextExpectedAt));
  const onTheHour = H.syncHealth(conn(), new Date("2026-08-24T15:00:00.000Z"));
  check("exactly 15:00 -> next expected 16:00",
    onTheHour.nextExpectedAt === "2026-08-24T16:00:00.000Z", String(onTheHour.nextExpectedAt));
  const lateNight = H.syncHealth(conn(), new Date("2026-08-24T23:40:00.000Z"));
  check("23:40 rolls over the day boundary correctly",
    lateNight.nextExpectedAt === "2026-08-25T00:00:00.000Z", String(lateNight.nextExpectedAt));
  const never = H.syncHealth(conn({ last_synced_at: null }), NOW);
  check("a never-synced connection still gets a next expected time",
    never.nextExpectedAt === "2026-08-24T15:00:00.000Z", String(never.nextExpectedAt));
}

console.log("\n-- timezone validation --");
{
  for (const tz of ["America/Bogota", "Europe/Amsterdam", "UTC", "Asia/Kolkata",
                    "America/Argentina/Buenos_Aires", "Pacific/Auckland"]) {
    check(`"${tz}" is valid`, H.isValidTimezone(tz) === true);
  }
  for (const tz of ["", "   ", "Mars/Olympus_Mons", "Not A Zone", "America/Nowhere",
                    "UTC+2", "GMT+5", "+05:00", null, undefined, 42, {}]) {
    check(`${JSON.stringify(tz)} is rejected`, H.isValidTimezone(tz) === false);
  }
  // Offset-style strings are rejected on purpose: they carry no DST rules, so
  // storing one would break the calendar day twice a year.
  check("an offset is not accepted even though it looks plausible",
    H.isValidTimezone("UTC+2") === false && H.isValidTimezone("Etc/GMT+5") === true,
    "Etc/GMT+5 IS a real IANA name; UTC+2 is not");
}

console.log("\n-- browser suggestion never overwrites a stored value --");
{
  // The rule that protects an established household: opening Settings while
  // travelling must not repoint its calendar days.
  const stored = H.timezoneFieldState("America/Bogota", "Europe/Amsterdam");
  check("a stored timezone wins over the browser's", stored.value === "America/Bogota",
    JSON.stringify(stored));
  check("and is not presented as a suggestion", stored.isSuggestion === false);
  check("the stored value is reported for display", stored.storedValue === "America/Bogota");
  check("the browser zone is still offered as context",
    stored.suggestion === "Europe/Amsterdam");

  const unset = H.timezoneFieldState(null, "Europe/Amsterdam");
  check("with nothing stored, the browser zone is suggested",
    unset.value === "Europe/Amsterdam" && unset.isSuggestion === true, JSON.stringify(unset));
  check("and storedValue is null", unset.storedValue === null);

  const blank = H.timezoneFieldState("   ", "America/Bogota");
  check("a whitespace-only stored value counts as unset",
    blank.isSuggestion === true && blank.value === "America/Bogota");

  const noBrowser = H.timezoneFieldState(null, null);
  check("no stored value and no browser zone -> empty, no suggestion",
    noBrowser.value === "" && noBrowser.isSuggestion === false, JSON.stringify(noBrowser));

  const junkBrowser = H.timezoneFieldState(null, "Mars/Olympus_Mons");
  check("an invalid browser zone is not suggested",
    junkBrowser.value === "" && junkBrowser.isSuggestion === false, JSON.stringify(junkBrowser));

  // Explicitly: the function is a pure read. It cannot write.
  check("timezoneFieldState returns a plain object and mutates nothing",
    typeof H.timezoneFieldState("America/Bogota", "Europe/Amsterdam") === "object");
}

console.log("\n-- browserTimezone --");
{
  const tz = H.browserTimezone();
  check("returns a valid zone or null, never junk",
    tz === null || H.isValidTimezone(tz), String(tz));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
