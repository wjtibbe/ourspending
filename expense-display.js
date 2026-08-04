// OurSpending — expense amount display.
//
// Pure and dependency-free (no React, no DOM) so it can be loaded as a
// classic script by the browser and required directly by tests, the same
// way i18n.js exposes window.I18N and theme.js exposes window.THEME.
//
// A Wise email import that converted currency carries TWO exact amounts:
// what was actually deducted (amount_orig/currency) and what the merchant
// charged (merchant_amount/merchant_currency). When the selected display
// currency matches either one exactly, that stored figure is shown as-is --
// never recomputed from a rate. Only a third currency is derived, using the
// app's normal EUR-based conversion (the same `disp` used everywhere else).
//
// A plain expense (manual entry, or a direct-currency Wise payment with no
// conversion) has had_currency_conversion=false and behaves exactly as
// before this module existed: one stored amount, converted for any other
// display currency.
(function () {
  function expenseDisplayAmounts(e, displayCur, fmt, disp) {
    const hasMerchant = !!(e.had_currency_conversion && e.merchant_currency && e.merchant_amount != null);

    if (e.currency === displayCur) {
      return {
        primary: fmt(Number(e.amount_orig), displayCur),
        secondary: hasMerchant && e.merchant_currency !== displayCur
          ? fmt(Number(e.merchant_amount), e.merchant_currency)
          : null,
      };
    }

    if (hasMerchant && e.merchant_currency === displayCur) {
      return {
        primary: fmt(Number(e.merchant_amount), displayCur),
        secondary: fmt(Number(e.amount_orig), e.currency),
      };
    }

    // Neither stored currency matches: the only case where a fresh
    // conversion happens, via the app's existing EUR-based `disp`.
    return {
      primary: disp(Number(e.amount_eur)),
      secondary: fmt(Number(e.amount_orig), e.currency),
    };
  }

  const api = { expenseDisplayAmounts };
  if (typeof window !== "undefined") window.ExpenseDisplay = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
