// AES-256-GCM for provider access tokens.
//
// Extracted verbatim from provider-connect so the connect flow and the sync
// job share one implementation rather than two that can drift apart. The
// key lives only in Edge Function secrets (PROVIDER_ENCRYPTION_KEY) and is
// never sent to a browser.
//
// There is deliberately NO plaintext fallback: a missing key must fail loudly
// rather than quietly storing a bare token.

const ENCRYPTION_KEY_B64 = Deno.env.get("PROVIDER_ENCRYPTION_KEY");
export const KEY_VERSION = 1;

export const hasEncryptionKey = () => !!ENCRYPTION_KEY_B64;

const b64encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(): Promise<CryptoKey> {
  if (!ENCRYPTION_KEY_B64) throw new Error("missing_encryption_key");
  const raw = b64decode(ENCRYPTION_KEY_B64);
  if (raw.length !== 32) throw new Error("bad_encryption_key_length");
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptToken(token: string) {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  return { ciphertext: b64encode(new Uint8Array(ct)), iv: b64encode(iv) };
}

export async function decryptToken(ciphertext: string, iv: string) {
  const key = await aesKey();
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(iv) },
    key,
    b64decode(ciphertext),
  );
  return new TextDecoder().decode(pt);
}

/**
 * Constant-time string comparison for shared secrets, so a caller cannot
 * discover the cron secret one character at a time by timing the response.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
