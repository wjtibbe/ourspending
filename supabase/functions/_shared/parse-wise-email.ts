// Wise notification-email parser.
//
// ============================================================================
// STATUS: one template implemented -- the completed card-payment email.
// ============================================================================
// Only the exact wording below is recognised. Anything else (declined,
// reversed, refunds, converted-currency notices, marketing, security alerts)
// still falls through to `unparsed` / `parser_awaiting_samples` rather than
// being guessed at -- inventing a template would produce a parser that looks
// finished, passes tests written against the same invention, and silently
// imports wrong amounts against real mail.
//
// Completed card payment (the only template implemented so far):
//
//   "You spent 71,362 COP at Éxito Express."
//   "This used 19.76 EUR from your account."
//
// The first sentence carries the merchant and the merchant's own currency --
// stored as metadata only. The second sentence carries what actually left the
// account, which is what becomes the expense amount. Neither line implies a
// date or a reference, so `occurredAt` and `externalRef` stay null rather
// than being backfilled from the time the mail was received.
//
// Also implemented here, and independent of any template:
//
//   * sender recognition (Wise's own sending domains -- a fact, not a guess)
//   * locale-aware money parsing, including the Colombian `45.000` form
//   * HTML -> text reduction
//   * deterministic fingerprinting for the last-resort dedupe key

import type {
  InboundMessage,
  ParseOutcome,
  TransactionEmailParser,
} from "./inbound-types.ts";
import type { Money, NormalizedTransaction } from "./import-core.ts";

// Wise sends from these domains. Verifying the sender is what stops a stranger
// who guessed an alias from injecting expenses.
export const WISE_SENDER_DOMAINS = ["wise.com", "transferwise.com"];

export function isWiseSender(address: string | null): boolean {
  if (!address) return false;
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  const domain = address.slice(at + 1).toLowerCase();
  return WISE_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

// ---------------------------------------------------------------------------
// Money parsing
// ---------------------------------------------------------------------------

/**
 * Parses a human-formatted amount without knowing the locale in advance.
 *
 * The hard case is Colombian formatting: `45.000` means forty-five thousand,
 * not forty-five. Guessing wrong here is a 1000x error on a real expense, so
 * the rules are explicit:
 *
 *   both separators present  -> the LAST one is the decimal separator
 *                               ("1.234,56" -> 1234.56, "1,234.56" -> 1234.56)
 *   one separator, exactly 3 digits after it, and no decimals implied
 *                            -> thousands separator ("45.000" -> 45000)
 *   one separator, any other digit count
 *                            -> decimal separator ("12.34" -> 12.34)
 *
 * Returns null rather than a wrong number when the input is not a clean
 * amount.
 */
export function parseMoneyValue(raw: string): number | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\s  ]/g, "");
  const m = cleaned.match(/-?\d[\d.,]*/);
  if (!m) return null;

  let s = m[0];
  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  let normalised: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    const intPart = s.slice(0, decimalAt).replace(/[.,]/g, "");
    const fracPart = s.slice(decimalAt + 1).replace(/[.,]/g, "");
    normalised = `${intPart}.${fracPart}`;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sepAt = Math.max(lastDot, lastComma);
    const sep = s[sepAt];
    const after = s.slice(sepAt + 1);
    const before = s.slice(0, sepAt);
    const occurrences = s.split(sep).length - 1;

    if (after.length === 3 && (occurrences > 1 || before.length <= 3)) {
      // Grouped thousands: 45.000 / 1.234.567 / 1,234
      normalised = s.replace(/[.,]/g, "");
    } else if (after.length === 3 && before.length > 3) {
      // Ambiguous (e.g. 12345.000). Treat as thousands: a 3-digit tail after a
      // long integer part is far more often grouping than milli-units.
      normalised = s.replace(/[.,]/g, "");
    } else {
      normalised = `${before.replace(/[.,]/g, "")}.${after}`;
    }
  } else {
    normalised = s;
  }

  const value = Number(normalised);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "US$": "USD",
  "COP$": "COP",
};

/**
 * Extracts an ISO currency code from a fragment. Prefers an explicit 3-letter
 * code over a symbol, because `$` is ambiguous (USD vs COP) and guessing it
 * would silently mis-currency a Colombian expense.
 */
export function parseCurrency(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.toUpperCase().match(/\b(EUR|USD|COP|GBP|CHF|AUD|CAD|BRL|MXN|PEN|ARS)\b/);
  if (code) return code[1];
  for (const [symbol, iso] of Object.entries(CURRENCY_SYMBOLS)) {
    if (raw.includes(symbol)) return iso;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML reduction
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&quot;": '"', "&#39;": "'", "&apos;": "'", "&euro;": "€", "&pound;": "£",
};

/** Reduces an HTML body to readable text, so one extractor can serve both parts. */
export function htmlToText(html: string): string {
  if (typeof html !== "string") return "";
  let out = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  for (const [ent, ch] of Object.entries(ENTITIES)) out = out.split(ent).join(ch);
  out = out.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  return out.replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** The best available plain-text view of a message. */
export function messageText(msg: InboundMessage): string {
  const text = (msg.text ?? "").trim();
  if (text) return text;
  return htmlToText(msg.html ?? "");
}

// ---------------------------------------------------------------------------
// Fingerprinting — the last-resort dedupe key
// ---------------------------------------------------------------------------

/**
 * A deterministic hash over the facts that identify a purchase, used only when
 * the message carries no id and no reference.
 *
 * The timestamp is bucketed to the minute on purpose: the same notification
 * re-delivered seconds later must collide (that is the point), while two
 * genuinely separate purchases are very unlikely to share merchant, amount,
 * currency AND minute.
 */
export async function fingerprint(parts: {
  userScope: string;
  merchant: string | null;
  amount: number | null;
  currency: string | null;
  occurredAt: string | null;
}): Promise<string> {
  const minute = parts.occurredAt
    ? new Date(parts.occurredAt).toISOString().slice(0, 16)
    : "";
  const canonical = [
    parts.userScope,
    (parts.merchant ?? "").toLowerCase().replace(/\s+/g, " ").trim(),
    parts.amount == null ? "" : parts.amount.toFixed(2),
    (parts.currency ?? "").toUpperCase(),
    minute,
  ].join("|");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Completed card payment template
// ---------------------------------------------------------------------------
//
//   "You spent 71,362 COP at Éxito Express."
//   "This used 19.76 EUR from your account."
//
// Matched on stable wording, not on markup: both regexes run against
// `messageText()`, which already reduces HTML to text, so the HTML and
// plain-text parts of the same email are handled identically.

const SPENT_LINE = /You spent\s+([^\n]+?)\s+at\s+(.+?)\.(?=\s|\n|$)/i;

// The account phrasing varies between Wise's own template variants, seen in
// real mail on the same account within days of each other:
//
//   "This used 57.04 EUR from your account."        (older)
//   "This used 6.45 EUR from your Wise account."    (current)
//
// Requiring the literal "from your account" rejected every message using the
// newer wording -- the parser found the "You spent ..." sentence perfectly and
// then threw the whole message away on the second one. The qualifier is
// therefore optional and not tied to the word "Wise": up to two words may sit
// between "your" and "account", which covers "Wise" and a future
// "Wise Business" without matching unrelated prose.
//
// Nothing here keys off the subject. Wise sends both
// "Card payment: 13,552 COP spent at Uber" and "203,575 COP spent at Tiendas D1"
// for the same kind of transaction, so the subject is metadata only and the
// two body sentences are the sole source of truth.
const USED_LINE = /This used\s+([^\n]+?)\s+from your(?:\s+[A-Za-z]+){0,2}\s+account\.?/i;

function extractMoney(fragment: string): Money | null {
  const value = parseMoneyValue(fragment);
  const currency = parseCurrency(fragment);
  if (value == null || !currency) return null;
  return { value, currency };
}

/**
 * The completed-payment template only. Anything that does not match both
 * sentences exactly -- a declined payment, a refund, a converted-currency
 * notice, marketing, a security alert -- falls through to `null` so the
 * caller reports `unparsed` rather than a guess.
 */
function extractCompletedPayment(msg: InboundMessage): NormalizedTransaction | null {
  const text = messageText(msg);

  const spent = text.match(SPENT_LINE);
  const used = text.match(USED_LINE);
  if (!spent || !used) return null;

  const merchantAmount = extractMoney(spent[1]);
  const accountAmount = extractMoney(used[1]);
  const merchant = spent[2].trim();
  if (!merchantAmount || !accountAmount || !merchant) return null;

  return {
    // Neither sentence carries a reference or a transaction date -- both stay
    // null rather than being inferred from the time the mail arrived.
    externalRef: null,
    occurredAt: null,
    direction: "out",
    status: "completed",
    // What actually left the account -- the expense amount.
    amount: accountAmount,
    // The merchant's own currency, kept as metadata only.
    merchantAmount,
    merchant,
    categoryInput: { description: merchant },
    sourceMetadata: {
      template: "wise_completed_card_payment",
      subject: msg.subject,
      sender: msg.from,
    },
  };
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export const wiseEmailParser: TransactionEmailParser = {
  provider: "wise_email",

  recognises(msg: InboundMessage): boolean {
    const from = msg.from ?? "";
    const m = from.match(/<([^>]+)>/);
    return isWiseSender((m ? m[1] : from).trim().toLowerCase());
  },

  parse(msg: InboundMessage): ParseOutcome {
    const transaction = extractCompletedPayment(msg);
    if (transaction) return { ok: true, transaction };

    // Anything else -- declined/reversed/refund templates are explicitly not
    // implemented yet. Returning `unparsed` (rather than throwing, or worse,
    // guessing) means the webhook still records the message, still returns
    // 200, and nothing is lost -- these rows can be replayed once more
    // templates are implemented against real samples.
    return {
      ok: false,
      reason: "unparsed",
      detail: "parser_awaiting_samples",
    };
  },
};
