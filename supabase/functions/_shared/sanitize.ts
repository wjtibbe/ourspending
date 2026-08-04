// Sanitising inbound email for short-lived diagnostic retention.
//
// The ONLY reason a body is kept at all is to diagnose a parser that failed.
// So the rules are: keep exactly what a parser author needs to read, drop
// everything that is a privacy or security liability, and never keep it long.
//
// Deliberately KEPT, because removing it would defeat the purpose:
//   * merchant names, amounts, currencies, dates, reference codes -- these are
//     the parse targets. Redacting them would leave a body that cannot explain
//     why parsing failed.
//
// Deliberately REMOVED:
//   * <script>, <style>, <iframe>, <object>, <embed>, <link>, <meta>
//   * ALL <img> -- tracking pixels and remote images alike
//   * every remote URL (href/src/srcset/background/url()) -- opening a
//     retained body must not be able to phone home
//   * inline event handlers (on*) and javascript: URLs
//   * HTML comments, which often carry template/build metadata
//
// Deliberately REDACTED:
//   * email addresses
//   * runs of 12+ digits (card and account numbers) -- short digit groups are
//     left alone so "45.000" and "12,34" survive intact

/** Hard ceiling so one pathological message cannot bloat the table. */
export const MAX_RETAINED_CHARS = 20_000;

const BLOCK_ELEMENTS = ["script", "style", "iframe", "object", "embed", "noscript", "svg"];

/** Redacts personal identifiers while leaving parseable financial detail. */
export function redactIdentifiers(input: string): string {
  if (typeof input !== "string") return "";
  return input
    // Email addresses.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    // Long digit runs: card numbers, account numbers, IBAN tails. Separators
    // are allowed inside so a spaced card number is caught too. The {12,}
    // floor keeps ordinary amounts (45.000, 1.234,56) untouched.
    .replace(/\b(?:\d[ -]?){12,}\b/g, "[number]")
    // IBAN-shaped tokens.
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "[iban]");
}

/** Strips markup that is unsafe, remote-loading, or simply noise. */
export function sanitizeHtml(html: string): string {
  if (typeof html !== "string" || !html) return "";
  let out = html;

  for (const tag of BLOCK_ELEMENTS) {
    out = out.replace(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }

  out = out
    // Comments.
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Void elements that fetch remote content or carry no readable text.
    .replace(/<(img|link|meta|base|source|track)\b[^>]*>/gi, " ")
    // Inline event handlers.
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, " ")
    // Any attribute that can reference a remote resource.
    .replace(/\s(href|src|srcset|background|poster|action|formaction|cite)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, " ")
    // url(...) inside surviving style attributes.
    .replace(/url\s*\(([^)]*)\)/gi, "url()")
    // javascript:/data: URLs left anywhere in text.
    .replace(/\b(javascript|data|vbscript):/gi, "removed:");

  return out;
}

export type RetainedContent = {
  text: string | null;
  html: string | null;
};

/**
 * Produces the sanitised, redacted, size-capped body to retain.
 *
 * Returns nulls when there is nothing worth keeping, so a message with no
 * usable body does not occupy retention storage for a week for no reason.
 */
export function sanitizeForRetention(
  text: string | null | undefined,
  html: string | null | undefined,
): RetainedContent {
  const cleanText = text
    ? redactIdentifiers(String(text)).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()
      .slice(0, MAX_RETAINED_CHARS)
    : "";

  const cleanHtml = html
    ? redactIdentifiers(sanitizeHtml(String(html))).replace(/\s+/g, " ").trim()
      .slice(0, MAX_RETAINED_CHARS)
    : "";

  return {
    text: cleanText || null,
    html: cleanHtml || null,
  };
}

/** Seven days after receipt, per the rollout retention policy. */
export const RETENTION_DAYS = 7;

export function retentionExpiry(from: Date = new Date()): string {
  return new Date(from.getTime() + RETENTION_DAYS * 86400_000).toISOString();
}
