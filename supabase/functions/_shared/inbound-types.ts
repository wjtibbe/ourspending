// The neutral contract between "some email arrived" and "import a transaction".
//
// Nothing here mentions Resend, Gmail or Wise. An inbound provider implements
// InboundAdapter; a bank implements TransactionEmailParser. Swapping either
// one leaves the other, and the import core, untouched.

import type { NormalizedTransaction } from "./import-core.ts";

/** Webhook metadata: what the provider tells us before we fetch anything. */
export type InboundEnvelope = {
  /** The inbound provider's own stable id for this message. Dedupe key #1. */
  providerMessageId: string;
  /** Every recipient on the message; the alias is found among these. */
  recipients: string[];
  /** Raw From header value, e.g. `Wise <noreply@wise.com>`. */
  from: string;
  subject: string | null;
  receivedAt: string;
};

/** The full message, once content has been retrieved. */
export type InboundMessage = InboundEnvelope & {
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  /** RFC 5322 Message-ID, when present. Dedupe key #2. */
  rfcMessageId: string | null;
};

export class InboundVerificationError extends Error {}

/**
 * One inbound email provider. `verify` must operate on the RAW request body:
 * re-serialising parsed JSON changes bytes and invalidates every signature
 * scheme in use.
 */
export interface InboundAdapter {
  readonly name: string;
  verify(headers: Headers, rawBody: string): Promise<void>;
  parseEnvelope(rawBody: string): InboundEnvelope | null;
  fetchContent(envelope: InboundEnvelope): Promise<InboundMessage>;
}

export type ParseOutcome =
  | { ok: true; transaction: NormalizedTransaction }
  /** The parser recognised the sender but this mail is not a transaction. */
  | { ok: false; reason: "not_a_transaction"; detail: string }
  /** The parser could not read a transaction it should have been able to. */
  | { ok: false; reason: "unparsed"; detail: string };

/**
 * One bank's notification-email format. Deterministic: no network, no AI.
 * `recognises` is deliberately separate so an unrelated email (marketing,
 * a security alert, a password reset) is cheaply rejected as
 * "not_a_transaction" rather than being reported as a parser failure.
 */
export interface TransactionEmailParser {
  readonly provider: string;
  recognises(msg: InboundMessage): boolean;
  parse(msg: InboundMessage): ParseOutcome;
}

/** Extracts the local part of any recipient matching the configured domain. */
export function aliasFromRecipients(
  recipients: string[],
  inboundDomain: string,
  prefix: string,
): string | null {
  const domain = inboundDomain.toLowerCase().replace(/^@/, "");
  for (const raw of recipients) {
    // Accept both `a@b.com` and `Name <a@b.com>`.
    const m = String(raw).match(/<([^>]+)>/);
    const addr = (m ? m[1] : String(raw)).trim().toLowerCase();
    const at = addr.lastIndexOf("@");
    if (at < 0) continue;
    if (addr.slice(at + 1) !== domain) continue;

    const local = addr.slice(0, at);
    // Support both `wise-<token>` and plain `<token>`; a plus-tag is stripped
    // because some forwarders append one.
    const withoutTag = local.split("+")[0];
    if (prefix && withoutTag.startsWith(prefix)) {
      const token = withoutTag.slice(prefix.length).replace(/^[-._]/, "");
      if (token) return token;
      continue;
    }
    if (!prefix) return withoutTag || null;
  }
  return null;
}

/** Pulls the bare address out of a From header value, lowercased. */
export function addressOf(from: string): string | null {
  const m = String(from ?? "").match(/<([^>]+)>/);
  const addr = (m ? m[1] : String(from ?? "")).trim().toLowerCase();
  return addr.includes("@") ? addr : null;
}
