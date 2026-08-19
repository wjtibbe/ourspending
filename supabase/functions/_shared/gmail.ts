// Google OAuth + Gmail API, zero dependencies.
//
// Only ONE scope is ever requested: gmail.readonly. Nothing here sends,
// modifies, labels or deletes mail, and asking for a broader scope would be
// both unnecessary and a much bigger consent prompt for the user to accept.
//
// The error taxonomy matters more than it looks. Google answers a dead
// refresh token with a plain HTTP 400, the same status it uses for a
// malformed request. Collapsing those into one "sync failed" would leave a
// user staring at a connection that silently never works again -- so
// invalid_grant is mapped to its own code and surfaced as "reconnect
// required", which is the only thing that actually fixes it.

// Discovery reuses the sender trust boundary the importer already enforces,
// so the query and the validation gate can never drift apart.
import { WISE_SENDER_DOMAINS } from "./parse-wise-email.ts";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Codes the UI and the ledger can act on, rather than one opaque failure. */
export type GmailErrorCode =
  /** The refresh token is dead (revoked, expired, or consent withdrawn). */
  | "reconnect_required"
  /** Credentials rejected for some other reason. */
  | "token_refused"
  /** Authorised, but not for the scope this call needs. */
  | "insufficient_scope"
  /** Google is rate-limiting us; the next run should just try again. */
  | "rate_limited"
  /** Network failure or a 5xx. Transient by assumption. */
  | "unreachable"
  /** Anything else, kept distinct so it cannot masquerade as the above. */
  | "gmail_error";

export class GmailError extends Error {
  code: GmailErrorCode;
  constructor(code: GmailErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "GmailError";
  }
}

/** True when the user must re-authorise; nothing else will fix it. */
export const needsReconnect = (e: unknown): boolean =>
  e instanceof GmailError && (e.code === "reconnect_required" || e.code === "insufficient_scope");

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** CSPRNG random, URL-safe. Used for both the state and the PKCE verifier. */
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** S256 challenge for a verifier. Google supports S256; plain is not used. */
export async function codeChallengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return b64url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// The consent URL
// ---------------------------------------------------------------------------

/**
 * `access_type=offline` is what makes Google issue a refresh token at all.
 *
 * `prompt=consent` is set only on a FIRST connect. Google returns a refresh
 * token on the first authorisation, and thereafter only when consent is
 * re-granted -- so forcing it every time would make the user re-approve on
 * every reconnect for no benefit, while never forcing it would leave a
 * first-time user with an access token that expires in an hour and no way to
 * renew it.
 */
export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  forceConsent: boolean;
  loginHint?: string | null;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.forceConsent) url.searchParams.set("prompt", "consent");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export type TokenResponse = {
  accessToken: string;
  /** Present on first consent; absent on most refreshes. */
  refreshToken: string | null;
  expiresAt: string;
  scope: string | null;
};

async function tokenRequest(
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new GmailError("unreachable", "token endpoint unreachable");
  }

  const text = await res.text().catch(() => "");
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* handled below */ }

  if (!res.ok) {
    const err = String(parsed.error ?? "");
    // The one that actually matters: the refresh token is gone. In Google's
    // Testing mode this is routine, not exceptional -- see GMAIL_SETUP.md.
    if (err === "invalid_grant") {
      throw new GmailError("reconnect_required", "refresh token no longer valid");
    }
    if (res.status === 429) throw new GmailError("rate_limited", "token rate limited");
    if (res.status >= 500) throw new GmailError("unreachable", `token ${res.status}`);
    throw new GmailError("token_refused", `token ${res.status} ${err}`);
  }

  const accessToken = String(parsed.access_token ?? "");
  if (!accessToken) throw new GmailError("token_refused", "no access_token returned");

  const expiresIn = Number(parsed.expires_in ?? 0);
  const scope = parsed.scope ? String(parsed.scope) : null;

  // A downgraded scope is a hard stop, not a warning: Gmail reads would fail
  // later with a confusing 403 rather than at the point consent was given.
  if (scope && !scope.split(/\s+/).includes(GMAIL_SCOPE)) {
    throw new GmailError("insufficient_scope", "gmail.readonly was not granted");
  }

  return {
    accessToken,
    refreshToken: parsed.refresh_token ? String(parsed.refresh_token) : null,
    expiresAt: new Date(
      Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    ).toISOString(),
    scope,
  };
}

export function exchangeCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}, fetchImpl: FetchLike = fetch): Promise<TokenResponse> {
  return tokenRequest({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    grant_type: "authorization_code",
  }, fetchImpl);
}

export function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}, fetchImpl: FetchLike = fetch): Promise<TokenResponse> {
  return tokenRequest({
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
  }, fetchImpl);
}

/** Best-effort revoke on disconnect. Never throws: the row goes either way. */
export async function revokeToken(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gmail API
// ---------------------------------------------------------------------------

/**
 * The search that keeps this out of the rest of the mailbox.
 *
 * Restrictive on purpose: a sender filter AND a short time window, so the app
 * never asks Gmail for -- and therefore never sees -- anything but recent Wise
 * mail. The optional label narrows it further for users who want a
 * filter-based allowlist.
 *
 * SENDER SCOPE -- why this is domains, not one address.
 *
 * This used to be the single literal address `noreply@wise.com`, while the
 * sender-authenticity gate that runs afterwards (isWiseSender in
 * parse-wise-email.ts) has always accepted ANY address at wise.com or
 * transferwise.com, including subdomains. Discovery was therefore strictly
 * narrower than the trust boundary the rest of the pipeline already enforces:
 * a card-payment notice sent from any other Wise address -- a different local
 * part, a sending subdomain like e.wise.com, a regional domain -- would pass
 * every check in the importer but was never fetched, so it could not be
 * imported and left no trace anywhere. Nothing reported it, because a message
 * that is never listed is not a failure, a skip or an unparsed row; it is
 * simply absent.
 *
 * The sender list is now derived from WISE_SENDER_DOMAINS, the same constant
 * isWiseSender validates against, so discovery and validation cannot drift
 * apart again. This is not a widening of who is trusted: every message found
 * still has to clear that same sender gate, then the Wise card-payment
 * template, before anything is imported.
 *
 * Gmail's `from:` matches the From HEADER (display name and address), not the
 * SMTP envelope sender / Return-Path, so a domain term here matches any
 * From address at that domain. Spam and Trash stay excluded: the Gmail API
 * omits them unless `in:anywhere` is asked for, and a From header is trivially
 * spoofable, so Gmail's own spam classification is load-bearing here. A
 * genuine notice that landed in Spam is deliberately not imported.
 */
export function buildWiseQuery(opts: {
  lookbackDays?: number;
  label?: string | null;
  /** Override the sender terms. Accepts addresses or bare domains. */
  senders?: string[] | string | null;
} = {}): string {
  // 8, not 2: the job runs once daily and an occasional missed run (a dead
  // token, a transient failure) must still be caught by the next one. Safe
  // to widen because duplicate protection does not rely on a tight window --
  // see the comment on GMAIL_LOOKBACK_DAYS in functions/gmail-sync/index.ts.
  const days = Number.isFinite(opts.lookbackDays) && (opts.lookbackDays as number) > 0
    ? Math.floor(opts.lookbackDays as number)
    : 8;

  const raw = typeof opts.senders === "string"
    ? opts.senders.split(",")
    : Array.isArray(opts.senders)
    ? opts.senders
    : null;
  const senders = (raw ?? WISE_SENDER_DOMAINS)
    .map((s) => String(s).trim())
    .filter(Boolean);
  const list = senders.length ? senders : [...WISE_SENDER_DOMAINS];

  // `from:(a OR b)` rather than one term per sender: separate `from:` terms
  // would AND together and match nothing.
  const fromTerm = list.length === 1
    ? `from:${list[0]}`
    : `from:(${list.join(" OR ")})`;

  const parts = [fromTerm, `newer_than:${days}d`];
  if (opts.label && opts.label.trim()) {
    // Quoted so a label containing a space ("Wise Import") stays one term.
    parts.push(`label:"${opts.label.trim()}"`);
  }
  return parts.join(" ");
}

async function gmailGet(
  path: string,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${GMAIL_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new GmailError("unreachable", "gmail unreachable");
  }
  if (res.status === 401) throw new GmailError("token_refused", "gmail rejected the access token");
  if (res.status === 403) throw new GmailError("insufficient_scope", "gmail refused the scope");
  if (res.status === 429) throw new GmailError("rate_limited", "gmail rate limited");
  if (res.status >= 500) throw new GmailError("unreachable", `gmail ${res.status}`);
  if (!res.ok) throw new GmailError("gmail_error", `gmail ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new GmailError("gmail_error", "gmail returned unreadable JSON");
  }
}

/**
 * Lists matching message IDs only -- deliberately the cheap call. Bodies are
 * fetched one at a time afterwards, so a wide match costs ids, not mail.
 */
export async function listMessageIds(params: {
  accessToken: string;
  query: string;
  pageToken?: string | null;
  maxResults?: number;
}, fetchImpl: FetchLike = fetch): Promise<{
  ids: string[];
  nextPageToken: string | null;
  /** Gmail's rough total for the query, independent of paging. Diagnostic only. */
  resultSizeEstimate: number | null;
}> {
  const search = new URLSearchParams({
    q: params.query,
    maxResults: String(params.maxResults ?? 50),
  });
  if (params.pageToken) search.set("pageToken", params.pageToken);

  const body = await gmailGet(
    `/users/me/messages?${search.toString()}`,
    params.accessToken,
    fetchImpl,
  );
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const ids = raw
    .map((m) => (m && typeof m === "object" ? String((m as Record<string, unknown>).id ?? "") : ""))
    .filter((id) => id.length > 0);
  // Gmail's own rough count of everything matching the query, independent of
  // paging. Previously discarded, which meant "Gmail has more than we
  // fetched" and "Gmail has exactly this many" were indistinguishable -- the
  // difference between a paging bug and a query that genuinely does not match
  // a message. It is an ESTIMATE and can be off for large result sets; it is a
  // diagnostic, never a control-flow input.
  const estimate = Number(body.resultSizeEstimate);
  return {
    ids,
    nextPageToken: body.nextPageToken ? String(body.nextPageToken) : null,
    resultSizeEstimate: Number.isFinite(estimate) ? estimate : null,
  };
}

/** Fetches one full message (headers + body parts, no attachment payloads). */
export function getMessage(
  params: { accessToken: string; id: string },
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  return gmailGet(
    `/users/me/messages/${encodeURIComponent(params.id)}?format=full`,
    params.accessToken,
    fetchImpl,
  );
}

/** The connected mailbox's own address, for display in Settings. */
export async function getProfileEmail(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const body = await gmailGet("/users/me/profile", accessToken, fetchImpl);
  return body.emailAddress ? String(body.emailAddress) : null;
}
