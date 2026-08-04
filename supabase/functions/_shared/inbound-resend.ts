// Resend inbound adapter. The ONLY file that knows Resend exists.
//
// Verified against Resend's current documentation (resend/resend-skills
// references, Aug 2026) rather than assumed:
//
//   * Routing is CATCH-ALL, not per-alias registration. An MX record on a
//     (sub)domain receives mail for any address there, and you route on the
//     `to` field yourself. There is no Postmark-style MailboxHash.
//   * The `email.received` webhook carries METADATA ONLY --
//     { type, created_at, data: { email_id, from, to[], subject } }.
//     The body and headers are NOT in the webhook.
//   * The content must be fetched separately from the Receiving API using
//     `email_id`, which returns `html`, `text` and `headers`.
//   * Signatures are Svix: `svix-id`, `svix-timestamp`, `svix-signature`.
//
// Two secrets are therefore required, and they are different things:
//   RESEND_WEBHOOK_SECRET  whsec_... , verifies the webhook is really Resend
//   RESEND_API_KEY         re_...    , authorises fetching the body
//
// Svix verification is implemented here directly rather than via the SDK, to
// keep the zero-dependency style the rest of this project uses.

import { safeEqual } from "./crypto.ts";
import {
  InboundVerificationError,
  type InboundAdapter,
  type InboundEnvelope,
  type InboundMessage,
} from "./inbound-types.ts";

const RESEND_API_BASE = Deno.env.get("RESEND_API_BASE") ?? "https://api.resend.com";

/** Standard Webhooks / Svix tolerance: reject anything older than 5 minutes. */
const TIMESTAMP_TOLERANCE_SECONDS = 300;

const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64encode = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/**
 * Svix signature check.
 *
 * signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
 * key            = base64-decoded part of the secret AFTER the `whsec_` prefix
 * signature      = base64( HMAC-SHA256(key, signedContent) )
 *
 * The header may carry several space-separated `v1,<sig>` entries during key
 * rotation; any one matching is a pass.
 */
export async function verifySvixSignature(
  headers: Headers,
  rawBody: string,
  secret: string,
  now: Date = new Date(),
): Promise<void> {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const signature = headers.get("svix-signature") ?? headers.get("webhook-signature");

  if (!id || !timestamp || !signature) {
    throw new InboundVerificationError("missing_signature_headers");
  }

  // Replay protection. Without this a captured request stays valid forever.
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) throw new InboundVerificationError("bad_timestamp");
  const driftSeconds = Math.abs(Math.floor(now.getTime() / 1000) - sent);
  if (driftSeconds > TIMESTAMP_TOLERANCE_SECONDS) {
    throw new InboundVerificationError("timestamp_out_of_tolerance");
  }

  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = b64decode(rawSecret);
  } catch {
    throw new InboundVerificationError("bad_secret_encoding");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
  );
  const expected = b64encode(new Uint8Array(mac));

  for (const part of signature.split(" ")) {
    const value = part.includes(",") ? part.slice(part.indexOf(",") + 1) : part;
    if (safeEqual(value, expected)) return;
  }
  throw new InboundVerificationError("signature_mismatch");
}

/** Case-insensitive header lookup over whatever shape Resend returns. */
function headerMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const h of raw) {
      const name = (h as Record<string, unknown>)?.name;
      const value = (h as Record<string, unknown>)?.value;
      if (typeof name === "string") out[name.toLowerCase()] = String(value ?? "");
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k.toLowerCase()] = String(v ?? "");
    }
  }
  return out;
}

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];

export function createResendAdapter(
  webhookSecret: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): InboundAdapter {
  return {
    name: "resend",

    verify(headers, rawBody) {
      return verifySvixSignature(headers, rawBody, webhookSecret);
    },

    parseEnvelope(rawBody) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return null;
      }
      // Only inbound mail. Delivery/bounce/open events share this endpoint
      // shape and must be ignored rather than treated as a failed parse.
      if (payload.type !== "email.received") return null;

      const data = (payload.data ?? {}) as Record<string, unknown>;
      const providerMessageId = data.email_id ? String(data.email_id) : "";
      if (!providerMessageId) return null;

      return {
        providerMessageId,
        recipients: asArray(data.to),
        from: String(data.from ?? ""),
        subject: data.subject == null ? null : String(data.subject),
        receivedAt: payload.created_at ? String(payload.created_at) : new Date().toISOString(),
      };
    },

    async fetchContent(envelope: InboundEnvelope): Promise<InboundMessage> {
      // The webhook deliberately omits the body; this is the documented second
      // step. It is the only place RESEND_API_KEY is used.
      const res = await fetchImpl(
        `${RESEND_API_BASE}/emails/receiving/${encodeURIComponent(envelope.providerMessageId)}`,
        { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(`resend_receiving_${res.status}`);

      const body = (await res.json()) as Record<string, unknown>;
      const headers = headerMap(body.headers);

      return {
        ...envelope,
        // Prefer the fetched values where present: the webhook's copies are a
        // summary, and `to` in particular can be abbreviated.
        recipients: asArray(body.to).length ? asArray(body.to) : envelope.recipients,
        from: body.from ? String(body.from) : envelope.from,
        subject: body.subject == null ? envelope.subject : String(body.subject),
        text: body.text == null ? null : String(body.text),
        html: body.html == null ? null : String(body.html),
        headers,
        rfcMessageId: headers["message-id"] ?? null,
      };
    },
  };
}
