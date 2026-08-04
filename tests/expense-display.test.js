// Expense display amount tests.
//
//   node tests/expense-display.test.js
//
// Drives expense-display.js -- the pure function app.js uses to decide what
// the large/small amounts on an expense row show. No React, no DOM, so it is
// required directly, the same module the browser loads via <script>.
//
// The rule under test: when the selected display currency matches EITHER the
// deducted amount's currency OR the merchant amount's currency, that EXACT
// stored figure is shown -- never recomputed. Only a genuine third currency
// goes through the app's normal EUR-based conversion.

const { expenseDisplayAmounts } = require("../expense-display.js");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
};

// Stand-ins for app.js's real fmt/disp, same shape and rounding rules, so
// assertions can check exact display strings.
const SYMBOL = { EUR: "€", USD: "$", COP: "COP" };
const fmt = (n, cur) => {
  const v = n || 0;
  if (cur === "COP") return "COP " + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return SYMBOL[cur] + " " + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const RATES = { usdPerEur: 1.08, copPerEur: 4500 };
const perEur = (cur) => cur === "EUR" ? 1 : cur === "USD" ? RATES.usdPerEur : RATES.copPerEur;
const fromEUR = (a, cur) => a * perEur(cur);
const ceilCur = (v, cur) => cur === "COP" ? Math.ceil(v) : Math.ceil(v * 100) / 100;
let dispCalls = 0;
const makeDisp = (displayCur) => (eur) => { dispCalls++; return fmt(ceilCur(fromEUR(eur, displayCur), displayCur), displayCur); };

// The Éxito Express example throughout: deducted 19.76 EUR, merchant charged
// 71,362 COP.
const exito = {
  currency: "EUR", amount_orig: 19.76, amount_eur: 19.76,
  merchant_currency: "COP", merchant_amount: 71362, had_currency_conversion: true,
};

console.log("\n-- Wise converted transaction: display currency matches the deducted currency (EUR) --");
{
  dispCalls = 0;
  const out = expenseDisplayAmounts(exito, "EUR", fmt, makeDisp("EUR"));
  check("primary is the exact deducted amount", out.primary === "€ 19.76", out.primary);
  check("secondary is the exact merchant amount, not a conversion", out.secondary === "COP 71,362", out.secondary);
  check("no conversion was performed", dispCalls === 0);
}

console.log("\n-- Wise converted transaction: display currency matches the merchant currency (COP) --");
{
  dispCalls = 0;
  const out = expenseDisplayAmounts(exito, "COP", fmt, makeDisp("COP"));
  check("primary is the exact merchant amount", out.primary === "COP 71,362", out.primary);
  check("secondary is the exact deducted amount, not a conversion", out.secondary === "€ 19.76", out.secondary);
  check("no conversion was performed", dispCalls === 0);
}

console.log("\n-- Wise converted transaction: display currency is a genuine third currency (USD) --");
{
  dispCalls = 0;
  const out = expenseDisplayAmounts(exito, "USD", fmt, makeDisp("USD"));
  const expectedPrimary = fmt(ceilCur(fromEUR(19.76, "USD"), "USD"), "USD");
  check("primary is derived via the app's normal EUR conversion", out.primary === expectedPrimary, out.primary);
  check("conversion was actually invoked (only case where it should be)", dispCalls === 1);
  check("secondary still shows the exact deducted amount", out.secondary === "€ 19.76", out.secondary);
}

console.log("\n-- later exchange-rate changes never alter a stored Wise import's exact-currency displays --");
{
  // Changing what `disp` (i.e. the household's rates) WOULD produce has zero
  // effect on the EUR and COP branches, because they never call disp() at all.
  const staleRateDisp = () => { throw new Error("must not be called for an exact-currency match"); };
  const eur = expenseDisplayAmounts(exito, "EUR", fmt, staleRateDisp);
  const cop = expenseDisplayAmounts(exito, "COP", fmt, staleRateDisp);
  check("EUR display is untouched by rate changes", eur.primary === "€ 19.76" && eur.secondary === "COP 71,362");
  check("COP display is untouched by rate changes", cop.primary === "COP 71,362" && cop.secondary === "€ 19.76");
}

console.log("\n-- direct EUR Wise transaction with no conversion (had_currency_conversion=false) --");
{
  const direct = {
    currency: "EUR", amount_orig: 9.99, amount_eur: 9.99,
    merchant_currency: null, merchant_amount: null, had_currency_conversion: false,
  };
  const same = expenseDisplayAmounts(direct, "EUR", fmt, makeDisp("EUR"));
  check("primary is the stored amount", same.primary === "€ 9.99");
  check("no secondary line when display matches and there is no merchant amount", same.secondary === null);

  dispCalls = 0;
  const other = expenseDisplayAmounts(direct, "USD", fmt, makeDisp("USD"));
  check("a different display currency still converts normally", other.primary === fmt(ceilCur(fromEUR(9.99, "USD"), "USD"), "USD"));
  check("secondary shows the original stored currency", other.secondary === "€ 9.99");
}

console.log("\n-- existing Spotify/manual-expense behaviour is unchanged --");
{
  // A manual expense never sets the new columns at all (they default to
  // null/false), which must behave identically to the pre-existing app.
  const spotify = { currency: "EUR", amount_orig: 9.99, amount_eur: 9.99 };
  const sameCur = expenseDisplayAmounts(spotify, "EUR", fmt, makeDisp("EUR"));
  check("same currency as display -> exact amount, no secondary",
    sameCur.primary === "€ 9.99" && sameCur.secondary === null);

  dispCalls = 0;
  const diffCur = expenseDisplayAmounts(spotify, "COP", fmt, makeDisp("COP"));
  check("different currency -> converted primary via disp()",
    diffCur.primary === fmt(ceilCur(fromEUR(9.99, "COP"), "COP"), "COP") && dispCalls === 1);
  check("secondary shows the original stored currency/amount",
    diffCur.secondary === "€ 9.99");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
