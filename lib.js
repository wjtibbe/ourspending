// ============================================================
//  OurSpending — shared pure logic (calendar recurrence, colors, nav)
// ============================================================
// No React/DOM/Supabase dependency on purpose, so this file can be loaded
// both in the browser (as a plain <script>, exposing window.OSLib) and in
// plain Node for the regression tests in test.js - the app has no bundler/
// build step, so this is the simplest way to keep new pure logic testable
// without pulling in a test framework.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.OSLib = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ----------------------------------------------------------
  //  Recurrence
  // ----------------------------------------------------------
  // Every recurrence option the calendar supports. "weekday" is the new
  // option (Part 1) - it is its own first-class rule (excludes Sat/Sun by
  // construction in `eventOccursOn` below), not "daily" with weekends hidden
  // in the UI.
  var RECURRENCE_OPTIONS = [
    { id: "none", label: "Does not repeat" },
    { id: "daily", label: "Every day" },
    { id: "weekday", label: "Every weekday" },
    { id: "weekly", label: "Every week" },
    { id: "monthly", label: "Every month" },
    { id: "yearly", label: "Every year" }
  ];

  function recurrenceLabel(id) {
    for (var i = 0; i < RECURRENCE_OPTIONS.length; i++) {
      if (RECURRENCE_OPTIONS[i].id === id) return RECURRENCE_OPTIONS[i].label;
    }
    return RECURRENCE_OPTIONS[0].label;
  }

  // Plain "YYYY-MM-DD" string date helpers - deliberately never construct a
  // `Date` from a bare local constructor for calendar math (that reads/writes
  // in the browser's local timezone and can silently shift a date by a day
  // near midnight); every helper below anchors on UTC noon-free integer
  // Y/M/D components instead, so a date string means the same calendar day
  // everywhere.
  function ymd(dateStr) {
    var parts = dateStr.split("-");
    return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) };
  }
  function toUTCMs(dateStr) {
    var p = ymd(dateStr);
    return Date.UTC(p.y, p.m - 1, p.d);
  }
  function dateStrFromUTCMs(ms) {
    var d = new Date(ms);
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, "0");
    var day = String(d.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }
  function addDaysStr(dateStr, days) {
    return dateStrFromUTCMs(toUTCMs(dateStr) + days * 86400000);
  }
  function dayOfWeek(dateStr) {
    // 0 = Sunday ... 6 = Saturday, same convention as Date#getDay().
    return new Date(toUTCMs(dateStr)).getUTCDay();
  }
  function isWeekendStr(dateStr) {
    var dow = dayOfWeek(dateStr);
    return dow === 0 || dow === 6;
  }
  function daysBetweenStr(a, b) {
    return Math.round((toUTCMs(b) - toUTCMs(a)) / 86400000);
  }

  /**
   * Whether `event` (anchored at `event.event_date`, repeating per
   * `event.recurrence`) has an occurrence on `dateStr`. Pure, and the SAME
   * rule is used for rendering, future-occurrence calculation and
   * persistence/reload checks - there is only one recurrence engine, not a
   * "daily + hide weekends in the UI" shortcut. `dateStr` before the anchor
   * never occurs (a series never runs backwards).
   */
  function eventOccursOn(event, dateStr) {
    if (!event || !event.event_date || dateStr < event.event_date) return false;
    switch (event.recurrence) {
      case "daily":
        return true;
      case "weekday":
        // The actual recurrence rule excludes Saturday/Sunday - conceptually
        // BYDAY=MO,TU,WE,TH,FR - applied uniformly, including the anchor
        // date itself: if an event's own start date happens to fall on a
        // weekend, that specific date is correctly not an occurrence and the
        // series' first real occurrence is the next weekday.
        return !isWeekendStr(dateStr);
      case "weekly":
        return daysBetweenStr(event.event_date, dateStr) % 7 === 0;
      case "monthly":
        return ymd(event.event_date).d === ymd(dateStr).d;
      case "yearly": {
        var a = ymd(event.event_date), b = ymd(dateStr);
        return a.m === b.m && a.d === b.d;
      }
      case "none":
      default:
        return dateStr === event.event_date;
    }
  }

  // Generous cap so a pathological/huge range can never spin the loop below
  // forever - comfortably covers any single month view (~31 days) many times
  // over.
  var MAX_OCCURRENCE_SCAN_DAYS = 400;

  /**
   * Every date (as "YYYY-MM-DD" strings, ascending) on which `event` occurs
   * within [rangeStart, rangeEnd] inclusive. Used by calendar rendering -
   * the caller decides the visible range (e.g. one month).
   */
  function generateOccurrencesInRange(event, rangeStart, rangeEnd) {
    var out = [];
    if (!event || !event.event_date || rangeEnd < rangeStart) return out;
    var cur = event.event_date > rangeStart ? event.event_date : rangeStart;
    var scanned = 0;
    while (cur <= rangeEnd && scanned < MAX_OCCURRENCE_SCAN_DAYS) {
      if (eventOccursOn(event, cur)) out.push(cur);
      cur = addDaysStr(cur, 1);
      scanned++;
    }
    return out;
  }

  // ----------------------------------------------------------
  //  Colors
  // ----------------------------------------------------------
  // The app's original hardcoded defaults (CSS vars --blue/--ochre/--green)
  // - kept as the fallback so existing households see NO visual change until
  // they deliberately pick a color in Settings.
  var DEFAULT_COLORS = { shared: "#1F6B4E", p0: "#33608D", p1: "#A6641C" };

  // A curated, readable-with-white-text palette (Settings color picker) -
  // deliberately not an open color input, so every choice stays legible and
  // visually consistent with the rest of the app.
  var COLOR_PALETTE = [
    "#33608D", // blue
    "#1F6B4E", // green
    "#A6641C", // ochre
    "#0E7490", // teal
    "#4338CA", // indigo
    "#8E4585", // plum
    "#BE185D", // rose
    "#B91C1C", // brick red
    "#C2410C", // burnt orange
    "#92400E", // amber-brown
    "#15803D", // forest
    "#525252" // slate
  ];

  var HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  /** True only for a well-formed 6-digit hex color - anything else (null, "", "orange", "#fff") is rejected rather than trusted. */
  function isValidColor(value) {
    return typeof value === "string" && HEX_COLOR_RE.test(value);
  }

  /**
   * Resolves the three colors the app actually uses (shared, person 0,
   * person 1) from persisted household/member rows, falling back to the
   * original defaults for anything missing or invalid - existing
   * households/rows (color columns not set yet, or not-yet-migrated) render
   * exactly as before.
   */
  function resolveColors(household, members) {
    var p0 = null, p1 = null;
    (members || []).forEach(function (m) {
      if (m.slot === 0) p0 = m;
      if (m.slot === 1) p1 = m;
    });
    return {
      shared: isValidColor(household && household.shared_color) ? household.shared_color : DEFAULT_COLORS.shared,
      p0: isValidColor(p0 && p0.color) ? p0.color : DEFAULT_COLORS.p0,
      p1: isValidColor(p1 && p1.color) ? p1.color : DEFAULT_COLORS.p1
    };
  }

  // ----------------------------------------------------------
  //  Bottom navigation layout
  // ----------------------------------------------------------
  // `minmax(0,1fr)` (not bare `1fr`) on all four side columns: a bare `1fr`
  // column still refuses to shrink below its own content's min-content
  // width, so one long translated label could grow its column and drag the
  // center "+" off true-center. `minmax(0, 1fr)` lets every side column
  // shrink to fit (labels truncate via CSS instead), so all four side
  // columns always end up EXACTLY equal width, keeping the "auto" center
  // column's midpoint at the true horizontal center regardless of label
  // length - the "1fr 1fr auto 1fr 1fr" grid, made robust against overflow.
  var NAV_GRID_TEMPLATE_COLUMNS = "minmax(0,1fr) minmax(0,1fr) auto minmax(0,1fr) minmax(0,1fr)";

  // Structural source of truth for the tab bar: exactly two entries before
  // "add", exactly two after - see AssortmentTable-style regression tests in
  // test.js for a check that this invariant holds.
  var NAV_TABS = ["overview", "calendar", "add", "budgets", "settings"];

  /**
   * The single place that maps a "kind" ("shared"/"p0"/"p1" - the same
   * ownership tag expenses AND events use) to its configured color. Every
   * person/shared visual indicator (Overview split bar + legend + expense
   * rows, Calendar event dots, Settings preview) calls this ONE function, so
   * a color chosen in Settings has exactly one consistent meaning everywhere
   * (section: "use colors consistently").
   */
  function colorForKind(kind, colors) {
    if (kind === "p0") return colors.p0;
    if (kind === "p1") return colors.p1;
    return colors.shared;
  }

  return {
    RECURRENCE_OPTIONS: RECURRENCE_OPTIONS,
    colorForKind: colorForKind,
    recurrenceLabel: recurrenceLabel,
    eventOccursOn: eventOccursOn,
    generateOccurrencesInRange: generateOccurrencesInRange,
    addDaysStr: addDaysStr,
    isWeekendStr: isWeekendStr,
    DEFAULT_COLORS: DEFAULT_COLORS,
    COLOR_PALETTE: COLOR_PALETTE,
    isValidColor: isValidColor,
    resolveColors: resolveColors,
    NAV_GRID_TEMPLATE_COLUMNS: NAV_GRID_TEMPLATE_COLUMNS,
    NAV_TABS: NAV_TABS
  };
});
