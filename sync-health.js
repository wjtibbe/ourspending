// OurSpending — Gmail sync health, and household timezone validation.
//
// Pure and dependency-free (no React, no DOM, no network) so it can be loaded
// as a classic script by the browser and required directly by tests, the same
// way expense-display.js, i18n.js and theme.js are.
//
// Everything here decides only what to SHOW. Nothing schedules, syncs, or
// writes; a wrong answer here can mislead but cannot corrupt data.
(function () {
  // ---------------------------------------------------------------------
  // Sync health
  // ---------------------------------------------------------------------
  //
  // Four states, in strict priority order. The order matters more than the
  // thresholds: a dead refresh token must never be reported as "delayed",
  // because waiting does not fix it -- only reconnecting does.
  //
  //   reconnect  the OAuth grant is gone. Terminal until the user acts.
  //   failed     the last run errored for some other reason.
  //   delayed    no SUCCESSFUL sync within the window, but nothing errored.
  //   healthy    a successful sync inside the window.
  //
  // "delayed" is deliberately measured from last_synced_at (the last SUCCESS)
  // rather than last_checked_at (the last ATTEMPT). A job that runs hourly and
  // fails silently every time would otherwise look healthy forever.

  /** Hours after which a connection with no successful sync is "delayed". */
  const DELAY_HOURS = 2;

  /** Errors that only a reconnect can clear. */
  const RECONNECT_ERRORS = new Set([
    "reconnect_required",
    "insufficient_scope",
    "invalid_grant",
  ]);

  function hoursSince(iso, now) {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return (now.getTime() - t) / 3600000;
  }

  /**
   * @param {object|null} conn  an email_import_connections row
   * @param {Date} now
   * @returns {{state:string, lastSuccessAt:string|null, nextExpectedAt:string|null,
   *            hoursSinceSuccess:number|null, reason:string|null}}
   */
  function syncHealth(conn, now) {
    const at = now instanceof Date ? now : new Date();
    if (!conn) {
      return {
        state: "none",
        lastSuccessAt: null,
        nextExpectedAt: null,
        hoursSinceSuccess: null,
        reason: null,
      };
    }

    const lastSuccessAt = conn.last_synced_at || null;
    const since = hoursSince(lastSuccessAt, at);

    // The cron runs at minute 0 of every hour, so the next attempt is the top
    // of the next hour -- not "last sync + 1h", which would drift and would be
    // wrong for a connection that has never synced.
    const next = new Date(at.getTime());
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    const nextExpectedAt = next.toISOString();

    const err = conn.last_error ? String(conn.last_error) : null;

    if (err && RECONNECT_ERRORS.has(err)) {
      return { state: "reconnect", lastSuccessAt, nextExpectedAt, hoursSinceSuccess: since, reason: err };
    }
    if (err) {
      return { state: "failed", lastSuccessAt, nextExpectedAt, hoursSinceSuccess: since, reason: err };
    }
    // Disabled is not a health problem; it is a deliberate choice.
    if (conn.enabled === false) {
      return { state: "disabled", lastSuccessAt, nextExpectedAt, hoursSinceSuccess: since, reason: null };
    }
    if (since === null) {
      // Connected but never synced yet. Not an error, and not "delayed":
      // there is nothing late, the first run simply has not happened.
      return { state: "awaiting", lastSuccessAt, nextExpectedAt, hoursSinceSuccess: null, reason: null };
    }
    if (since > DELAY_HOURS) {
      return { state: "delayed", lastSuccessAt, nextExpectedAt, hoursSinceSuccess: since, reason: null };
    }
    return { state: "healthy", lastSuccessAt, nextExpectedAt, hoursSinceSuccess: since, reason: null };
  }

  // ---------------------------------------------------------------------
  // Timezone
  // ---------------------------------------------------------------------

  /**
   * True only for a zone the runtime actually knows.
   *
   * Intl is the authority rather than a hand-written list: it is the same
   * mechanism the importer uses to render a calendar day, so a zone accepted
   * here is by construction a zone the importer can use. A hard-coded list
   * would drift from it.
   *
   * Rejects "UTC+2"-style offsets on purpose. They are not IANA names and do
   * not carry DST rules, so storing one would silently break the calendar day
   * twice a year.
   */
  function isValidTimezone(tz) {
    if (typeof tz !== "string") return false;
    const name = tz.trim();
    if (!name) return false;
    // An IANA name is Area/Location (optionally Area/Sub/Location), or one of
    // a few single-word zones. Anything with an offset sign is not one.
    if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(name)) return false;
    // Reject bare offset SYNTAX ("UTC+2", "GMT+5", "+05:00") -- not IANA names,
    // and carrying no DST rules. A namespaced name like "Etc/GMT+5" IS a real
    // IANA zone and is left alone: rejecting a name Intl accepts would be
    // overreach, and the slash is what distinguishes the two.
    if (!name.includes("/") && /^(utc|gmt)[+-]?\d/i.test(name)) return false;
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: name });
      return true;
    } catch (e) {
      return false;
    }
  }

  /** The browser's own zone, or null if the runtime will not say. */
  function browserTimezone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return isValidTimezone(tz) ? tz : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * What the Settings field should show, and whether it is a suggestion.
   *
   * A stored value ALWAYS wins. The browser zone is only ever a suggestion for
   * a household that has none, so opening Settings on a trip cannot silently
   * repoint an existing household's calendar days -- the user has to choose.
   */
  function timezoneFieldState(storedTimezone, browserTz) {
    const stored = typeof storedTimezone === "string" ? storedTimezone.trim() : "";
    if (stored) {
      return { value: stored, isSuggestion: false, storedValue: stored, suggestion: browserTz || null };
    }
    const suggestion = isValidTimezone(browserTz) ? browserTz : null;
    return { value: suggestion || "", isSuggestion: !!suggestion, storedValue: null, suggestion };
  }

  const api = {
    DELAY_HOURS,
    RECONNECT_ERRORS,
    syncHealth,
    isValidTimezone,
    browserTimezone,
    timezoneFieldState,
  };
  if (typeof window !== "undefined") window.SyncHealth = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
