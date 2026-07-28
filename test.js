// Zero-dependency regression tests for lib.js (recurrence, colors, nav).
// Run with: node test.js
// This repo has no build step / test framework - a plain Node script using
// the built-in `assert` module is the smallest thing that actually verifies
// the new pure logic without adding a new dependency.
"use strict";
const assert = require("node:assert/strict");
const lib = require("./lib.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (err) {
    failed++;
    console.error("  FAIL - " + name);
    console.error("    " + err.message);
  }
}

console.log("Calendar recurrence");
test("1: 'weekday' exists as a recurrence option with the expected label", () => {
  const opt = lib.RECURRENCE_OPTIONS.find((o) => o.id === "weekday");
  assert.ok(opt, "weekday option missing");
  assert.equal(opt.label, "Every weekday");
});

test("existing options are unchanged (none/daily/weekly/monthly/yearly)", () => {
  const ids = lib.RECURRENCE_OPTIONS.map((o) => o.id);
  assert.deepEqual(ids, ["none", "daily", "weekday", "weekly", "monthly", "yearly"]);
});

test("2/3/4/5: a Monday-anchored 'weekday' event occurs Mon-Fri, skips Sat/Sun, resumes the next Monday", () => {
  // 2024-01-01 is a Monday.
  const event = { event_date: "2024-01-01", recurrence: "weekday" };
  const occ = lib.generateOccurrencesInRange(event, "2024-01-01", "2024-01-14");
  assert.deepEqual(occ, [
    "2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", // Mon-Fri
    "2024-01-08", "2024-01-09", "2024-01-10", "2024-01-11", "2024-01-12", // next Mon-Fri
  ]);
  assert.ok(!occ.includes("2024-01-06"), "Saturday must be skipped");
  assert.ok(!occ.includes("2024-01-07"), "Sunday must be skipped");
  assert.ok(occ.includes("2024-01-08"), "must resume the following Monday");
});

test("a weekday event whose anchor date itself is a Saturday never occurs on that Saturday", () => {
  // 2024-01-06 is a Saturday.
  const event = { event_date: "2024-01-06", recurrence: "weekday" };
  assert.equal(lib.eventOccursOn(event, "2024-01-06"), false);
  assert.equal(lib.eventOccursOn(event, "2024-01-08"), true); // the following Monday
});

test("8: existing 'daily' recurrence still includes weekends (regression - not accidentally narrowed)", () => {
  const event = { event_date: "2024-01-01", recurrence: "daily" };
  const occ = lib.generateOccurrencesInRange(event, "2024-01-01", "2024-01-07");
  assert.equal(occ.length, 7);
  assert.ok(occ.includes("2024-01-06") && occ.includes("2024-01-07"));
});

test("9a: 'weekly' still recurs every 7 days regardless of weekday, including weekends", () => {
  // 2024-01-06 is a Saturday.
  const event = { event_date: "2024-01-06", recurrence: "weekly" };
  const occ = lib.generateOccurrencesInRange(event, "2024-01-06", "2024-01-27");
  assert.deepEqual(occ, ["2024-01-06", "2024-01-13", "2024-01-20", "2024-01-27"]);
});

test("9b: 'monthly' still matches the same day-of-month", () => {
  const event = { event_date: "2024-01-15", recurrence: "monthly" };
  assert.equal(lib.eventOccursOn(event, "2024-02-15"), true);
  assert.equal(lib.eventOccursOn(event, "2024-02-16"), false);
});

test("9c: 'yearly' still matches the same month+day", () => {
  const event = { event_date: "2024-03-10", recurrence: "yearly" };
  assert.equal(lib.eventOccursOn(event, "2025-03-10"), true);
  assert.equal(lib.eventOccursOn(event, "2025-03-11"), false);
});

test("'none' only ever occurs on its own anchor date", () => {
  const event = { event_date: "2024-01-01", recurrence: "none" };
  assert.equal(lib.eventOccursOn(event, "2024-01-01"), true);
  assert.equal(lib.eventOccursOn(event, "2024-01-02"), false);
});

test("6/13: occurrence generation is deterministic - the same event/range always reloads to the same result", () => {
  const event = { event_date: "2024-01-01", recurrence: "weekday" };
  const a = lib.generateOccurrencesInRange(event, "2024-01-01", "2024-01-31");
  const b = lib.generateOccurrencesInRange(event, "2024-01-01", "2024-01-31");
  assert.deepEqual(a, b);
});

test("7: editing a non-recurrence field (title/kind) never changes which dates occur", () => {
  const before = { event_date: "2024-01-01", recurrence: "weekday", title: "Gym" };
  const after = { event_date: "2024-01-01", recurrence: "weekday", title: "Gym class" };
  const range = ["2024-01-01", "2024-01-14"];
  assert.deepEqual(
    lib.generateOccurrencesInRange(before, range[0], range[1]),
    lib.generateOccurrencesInRange(after, range[0], range[1]),
  );
});

test("never returns an occurrence before the event's own start date", () => {
  const event = { event_date: "2024-01-10", recurrence: "daily" };
  const occ = lib.generateOccurrencesInRange(event, "2024-01-01", "2024-01-12");
  assert.deepEqual(occ, ["2024-01-10", "2024-01-11", "2024-01-12"]);
});

console.log("\nColors");
test("10: an existing household/member with no color set falls back to the original defaults", () => {
  const colors = lib.resolveColors({}, [{ slot: 0, display_name: "A" }, { slot: 1, display_name: "B" }]);
  assert.deepEqual(colors, lib.DEFAULT_COLORS);
});

test("11: a person's color can be changed", () => {
  const colors = lib.resolveColors({}, [{ slot: 0, color: "#4338CA" }, { slot: 1 }]);
  assert.equal(colors.p0, "#4338CA");
});

test("12: the Shared color can be changed", () => {
  const colors = lib.resolveColors({ shared_color: "#0E7490" }, []);
  assert.equal(colors.shared, "#0E7490");
});

test("13: resolving colors twice from the same persisted data yields the same result (stable after reload)", () => {
  const household = { shared_color: "#0E7490" };
  const members = [{ slot: 0, color: "#4338CA" }, { slot: 1, color: "#BE185D" }];
  assert.deepEqual(lib.resolveColors(household, members), lib.resolveColors(household, members));
});

test("14/15: colorForKind resolves the same configured color Calendar/Overview/badges all use", () => {
  const colors = lib.resolveColors({ shared_color: "#0E7490" }, [{ slot: 0, color: "#4338CA" }, { slot: 1, color: "#BE185D" }]);
  assert.equal(lib.colorForKind("shared", colors), "#0E7490");
  assert.equal(lib.colorForKind("p0", colors), "#4338CA");
  assert.equal(lib.colorForKind("p1", colors), "#BE185D");
});

test("16: changing one identity's color does not change another's", () => {
  const colors = lib.resolveColors({}, [{ slot: 0, color: "#4338CA" }, { slot: 1 }]);
  assert.equal(colors.p0, "#4338CA");
  assert.equal(colors.p1, lib.DEFAULT_COLORS.p1);
  assert.equal(colors.shared, lib.DEFAULT_COLORS.shared);
});

test("17: invalid color values are rejected and fall back to the default", () => {
  assert.equal(lib.isValidColor(""), false);
  assert.equal(lib.isValidColor("orange"), false);
  assert.equal(lib.isValidColor("#fff"), false); // 3-digit shorthand not accepted - keep the format strict/predictable
  assert.equal(lib.isValidColor(null), false);
  assert.equal(lib.isValidColor("#4338CA"), true);

  const colors = lib.resolveColors({ shared_color: "not-a-color" }, [{ slot: 0, color: "" }, { slot: 1, color: 42 }]);
  assert.deepEqual(colors, lib.DEFAULT_COLORS);
});

test("the curated palette only contains valid, distinct hex colors", () => {
  lib.COLOR_PALETTE.forEach((c) => assert.equal(lib.isValidColor(c), true, c + " is not a valid hex color"));
  assert.equal(new Set(lib.COLOR_PALETTE).size, lib.COLOR_PALETTE.length, "palette has a duplicate color");
});

console.log("\nNavigation");
test("18/19: exactly two nav destinations sit on each side of the center 'add' action", () => {
  const centerIndex = lib.NAV_TABS.indexOf("add");
  assert.equal(centerIndex, 2, "add' is not structurally centered in a 5-item list");
  assert.equal(centerIndex, lib.NAV_TABS.length - 1 - centerIndex, "left/right side counts are not equal");
});

test("20: the center action is still exactly 'add' (its behavior is untouched by this change)", () => {
  assert.equal(lib.NAV_TABS[2], "add");
});

test("21: the tab list has exactly 5 entries with 'add' structurally in the middle", () => {
  assert.equal(lib.NAV_TABS.length, 5);
  assert.equal(lib.NAV_TABS[Math.floor(lib.NAV_TABS.length / 2)], "add");
});

test("23: the grid template gives all four side columns the identical track size, so long labels can't drag the center off true-center", () => {
  const tracks = lib.NAV_GRID_TEMPLATE_COLUMNS.trim().split(/\s+/);
  assert.equal(tracks.length, 5);
  assert.equal(tracks[2], "auto");
  const sideTracks = [tracks[0], tracks[1], tracks[3], tracks[4]];
  assert.ok(sideTracks.every((t) => t === sideTracks[0]), "side columns are not all the same track size: " + sideTracks.join(", "));
  assert.match(sideTracks[0], /^minmax\(0,\s*1fr\)$/, "side columns should shrink (minmax(0,1fr)), not use a bare 1fr that can't shrink below label content width");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
