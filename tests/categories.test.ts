// Category mapping tests.
//
//   node --experimental-strip-types tests/categories.test.ts
//
// Runs the same module the Edge Functions import — no build step, no mocks.

import {
  APP_CATEGORIES, FALLBACK_CATEGORY, normalize, resolveCategory,
} from "../supabase/functions/_shared/categories.ts";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

function mapsTo(label: string, expected: string, input = {} as Record<string, unknown>) {
  const r = resolveCategory({ providerCategory: label, ...input });
  check(
    `"${label}" -> ${expected}`,
    r.category === expected,
    `got ${r.category} via ${r.source}`,
  );
}

console.log("\n-- normalization --");
check("strips accents", normalize("Transporte Público") === "transporte publico");
check("lowercases", normalize("GROCERIES") === "groceries");
check("strips punctuation", normalize("Restaurants & Bars!") === "restaurants bars");
check("collapses whitespace", normalize("  uit   eten  ") === "uit eten");
check("handles null", normalize(null) === "");

// Validation case 6: one canonical transport category across languages.
console.log("\n-- case 6: transport across languages and spellings --");
for (const label of [
  "Transport", "Transportation", "Taxi", "Ride sharing", "ride-sharing",
  "Vervoer", "Openbaar vervoer", "Transporte", "Transporte público",
  "TAXIS", "Uber", "DiDi", "inDrive", "Parking", "Gasolina", "Brandstof",
]) {
  mapsTo(label, "transport");
}

console.log("\n-- groceries / dining / subscriptions across languages --");
for (const label of ["Groceries", "Supermarket", "Boodschappen", "Supermercado", "Mercado"]) {
  mapsTo(label, "groceries");
}
for (const label of ["Restaurant", "Restaurants and Bars", "Dining", "Uit eten", "Restaurantes", "Comida rapida"]) {
  mapsTo(label, "dining");
}
for (const label of ["Subscriptions", "Streaming", "Abonnementen", "Suscripciones", "Membership"]) {
  mapsTo(label, "subscriptions");
}
for (const label of ["Travel", "Flights", "Vakantie", "Alojamiento", "Hotel"]) {
  mapsTo(label, "travel");
}
for (const label of ["Health", "Pharmacy", "Apotheek", "Farmacia", "Dentist"]) {
  mapsTo(label, "health");
}

// Real Wise merchant names reported as still falling back incorrectly.
// These are matched via `description` (the merchant name), the same field
// a Wise Gmail import actually populates -- not `providerCategory`.
console.log("\n-- real merchants: deterministic mapping fix --");
for (const [merchant, expected] of [
  ["Éxito Express", "groceries"],
  ["D1", "groceries"],
  ["Supermercado boom", "groceries"],
  ["Butcher eficarnes", "groceries"],
  ["Crepes y gelato", "dining"],
  ["Feria de flores", "entertainment"],
  ["Spotify", "subscriptions"],
] as const) {
  const r = resolveCategory({ description: merchant });
  check(`"${merchant}" -> ${expected}`, r.category === expected, `got ${r.category} via ${r.source}`);
}

// Uber/Didi must keep working exactly as before -- this fix must not touch
// transport at all.
console.log("\n-- transport is unchanged --");
for (const merchant of ["Uber", "Didi", "UBER *TRIP BOGOTA", "DIDI COLOMBIA"]) {
  const r = resolveCategory({ description: merchant });
  check(`"${merchant}" -> transport (unchanged)`, r.category === "transport", `got ${r.category} via ${r.source}`);
}

// "D1" must be an exact normalized-merchant match, never a substring
// keyword: a 2-character token embedded in an unrelated longer merchant
// name must not be pulled into groceries.
console.log("\n-- D1 is an exact match, not a substring keyword --");
{
  const r = resolveCategory({ description: "Studio D1 Fitness" });
  check(
    '"Studio D1 Fitness" does NOT match D1 as a substring',
    r.category !== "groceries",
    `got ${r.category} via ${r.source}`,
  );
}

// Validation case 7: nothing unknown ever creates a category.
console.log("\n-- case 7: unknown values fall back, never invent --");
for (const label of ["Quantum Widgets", "ZZZ-9", "", "   ", "!!!"]) {
  const r = resolveCategory({ providerCategory: label });
  check(
    `unknown "${label}" -> ${FALLBACK_CATEGORY}`,
    r.category === FALLBACK_CATEGORY && r.source === "fallback",
    `got ${r.category} via ${r.source}`,
  );
}
check(
  "every result is an existing app category",
  ["Quantum Widgets", "Transport", "Boodschappen", "???"].every((l) =>
    (APP_CATEGORIES as readonly string[]).includes(resolveCategory({ providerCategory: l }).category)
  ),
);

console.log("\n-- resolution priority --");
{
  const r = resolveCategory({ providerCategory: "Transporte", merchantCategory: "Groceries" });
  check("provider category wins over merchant category", r.category === "transport" && r.source === "provider_category");
}
{
  const r = resolveCategory({ providerCategory: "Nonsense", merchantCategory: "Supermercado" });
  check("merchant category is used when provider category is unknown", r.category === "groceries" && r.source === "merchant_category");
}
{
  const r = resolveCategory({ providerCategory: null, mcc: 4121 });
  check("MCC 4121 (taxis) -> transport", r.category === "transport" && r.source === "mcc");
}
{
  const r = resolveCategory({ mcc: "5411" });
  check("MCC as a string still resolves", r.category === "groceries" && r.source === "mcc");
}
{
  const r = resolveCategory({ mcc: 3012 });
  check("MCC inside the airline range -> travel", r.category === "travel");
}
{
  const r = resolveCategory({ description: "Card transaction of 45000 COP issued by UBER BOGOTA" });
  check("description is a last resort", r.category === "transport" && r.source === "description");
}

console.log("\n-- household deactivated categories are respected --");
{
  const allowed = new Set(APP_CATEGORIES as readonly string[]);
  allowed.delete("transport");
  const r = resolveCategory({ providerCategory: "Transporte" }, allowed);
  check(
    "a disabled category is not resurrected",
    r.category === FALLBACK_CATEGORY,
    `got ${r.category}`,
  );
}
{
  const allowed = new Set(["transport", "other"]);
  const r = resolveCategory({ providerCategory: "Transporte" }, allowed);
  check("an enabled category still maps", r.category === "transport");
}

console.log("\n-- never throws --");
for (const weird of [
  { providerCategory: { nested: true } },
  { mcc: Number.NaN },
  { description: 12345 },
  {},
]) {
  const r = resolveCategory(weird as Record<string, unknown>);
  check(
    "survives " + JSON.stringify(weird),
    (APP_CATEGORIES as readonly string[]).includes(r.category),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
