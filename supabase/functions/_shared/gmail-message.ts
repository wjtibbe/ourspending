// Gmail API message -> the neutral InboundMessage the parser already speaks.
//
// This is the only file that knows Gmail's payload shape. Everything
// downstream (parse-wise-email.ts, email-import-core.ts) sees exactly the
// same InboundMessage the Resend adapter produces, so a Wise email imports
// identically whichever pipe carried it.
//
// Three things here are easy to get subtly wrong, and all three would corrupt
// an amount rather than fail loudly:
//
//   * base64url is NOT base64. Gmail uses the URL alphabet (- and _) and
//     omits padding; decoding it as plain base64 throws or yields garbage.
//   * atob() returns one CHARACTER per BYTE (latin1). Feeding that straight
//     back as text mangles every multi-byte UTF-8 sequence -- "Éxito" becomes
//     "Ãxito". The bytes must go through TextDecoder.
//   * bodies live at different depths. A Wise mail may be text/plain at the
//     top, or multipart/alternative, or multipart/mixed wrapping a
//     multipart/alternative. Only a recursive walk finds all three.

import type { InboundMessage } from "./inbound-types.ts";

export type GmailBody = { size?: number; data?: string; attachmentId?: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: GmailBody;
  parts?: GmailPart[];
};
export type GmailMessage = {
  id?: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
};

/**
 * Decodes Gmail's base64url body data to a real UTF-8 string.
 *
 * Returns "" rather than throwing on malformed input: one unreadable part
 * must not abort a message that still has a readable one.
 */
export function base64UrlDecode(data: string): string {
  if (typeof data !== "string" || !data) return "";
  try {
    const normalised = data.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
    const binary = atob(padded);
    // Byte-for-byte, then decode as UTF-8. Skipping this step is what turns
    // "Éxito Express" into "Ãxito Express".
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

/** Case-insensitive header lookup; Gmail preserves the sender's casing. */
export function headerValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string | null {
  if (!Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const h of headers) {
    if (String(h?.name ?? "").toLowerCase() === wanted) {
      const v = h?.value;
      return typeof v === "string" ? v : null;
    }
  }
  return null;
}

/**
 * Decodes RFC 2047 encoded-words, e.g.
 *   =?UTF-8?B?NzEsMzYyIENPUCBzcGVudA==?=
 *   =?UTF-8?Q?71=2C362_COP?=
 *
 * Wise subjects carry accented merchant names, so a subject left encoded
 * would be useless for diagnosis. Anything unrecognised is passed through
 * unchanged rather than mangled.
 */
export function decodeEncodedWords(input: string): string {
  if (typeof input !== "string" || !input.includes("=?")) return input ?? "";
  return input.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, _charset: string, encoding: string, payload: string) => {
      try {
        if (encoding.toUpperCase() === "B") {
          const decoded = base64UrlDecode(payload.replace(/\+/g, "-").replace(/\//g, "_"));
          return decoded || whole;
        }
        // Q encoding: "_" is a space, "=XX" is a raw byte.
        const bytes: number[] = [];
        for (let i = 0; i < payload.length; i++) {
          const ch = payload[i];
          if (ch === "_") { bytes.push(0x20); continue; }
          if (ch === "=" && i + 2 < payload.length) {
            const hex = payload.slice(i + 1, i + 3);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              bytes.push(parseInt(hex, 16));
              i += 2;
              continue;
            }
          }
          bytes.push(ch.charCodeAt(0));
        }
        return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
      } catch {
        return whole;
      }
    },
  );
}

/** True for a part that is an attachment rather than body text. */
function isAttachment(part: GmailPart): boolean {
  if (part.filename && part.filename.length > 0) return true;
  const disposition = headerValue(part.headers, "Content-Disposition") ?? "";
  return disposition.toLowerCase().startsWith("attachment");
}

/**
 * Walks the MIME tree and returns the first readable text/plain and text/html
 * bodies. Depth-first, so the innermost multipart/alternative of a
 * multipart/mixed is reached; attachments are skipped entirely.
 */
export function extractBodies(payload: GmailPart | undefined): {
  text: string | null;
  html: string | null;
} {
  let text: string | null = null;
  let html: string | null = null;
  // Bounded so a pathological or hostile nesting cannot spin.
  const walk = (part: GmailPart | undefined, depth: number): void => {
    if (!part || depth > 12) return;
    if (isAttachment(part)) return;

    const mime = String(part.mimeType ?? "").toLowerCase();
    const data = part.body?.data;

    if (data) {
      if (mime.startsWith("text/plain") && text === null) {
        const decoded = base64UrlDecode(data);
        if (decoded) text = decoded;
      } else if (mime.startsWith("text/html") && html === null) {
        const decoded = base64UrlDecode(data);
        if (decoded) html = decoded;
      }
    }

    if (Array.isArray(part.parts)) {
      for (const child of part.parts) {
        if (text !== null && html !== null) return;
        walk(child, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return { text, html };
}

/** Gmail's internalDate is epoch milliseconds as a STRING. */
function receivedAtOf(msg: GmailMessage): string {
  const raw = msg.internalDate;
  if (raw) {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  const dateHeader = headerValue(msg.payload?.headers, "Date");
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * The adapter boundary: a Gmail API message becomes the same InboundMessage
 * the Resend webhook produces. Returns null only when there is no usable id,
 * because without one the message cannot be deduped and must not be imported.
 */
export function gmailToInboundMessage(msg: GmailMessage): InboundMessage | null {
  const id = msg?.id ? String(msg.id) : "";
  if (!id) return null;

  const headers = msg.payload?.headers ?? [];
  const { text, html } = extractBodies(msg.payload);

  // Only the headers the pipeline actually uses, decoded. Deliberately not
  // the whole set: the rest is neither read nor worth retaining.
  const flat: Record<string, string> = {};
  for (const name of ["From", "To", "Subject", "Date", "Message-ID"]) {
    const v = headerValue(headers, name);
    if (v) flat[name] = decodeEncodedWords(v);
  }

  const to = headerValue(headers, "To");
  const rfcMessageId = headerValue(headers, "Message-ID");

  return {
    providerMessageId: id,
    recipients: to ? [to] : [],
    from: decodeEncodedWords(headerValue(headers, "From") ?? ""),
    subject: decodeEncodedWords(headerValue(headers, "Subject") ?? "") || null,
    receivedAt: receivedAtOf(msg),
    text,
    html,
    headers: flat,
    rfcMessageId: rfcMessageId ? rfcMessageId.trim() : null,
  };
}
