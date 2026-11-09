/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Google identities for the federated connector (G3b design v3 §1, §6).

- Service account unique ids are canonical decimal strings, compared byte
  for byte. They exceed JavaScript's safe integers, so they are never parsed
  as numbers.
- tokeninfo is called by POST, with the token in the form body (never a
  URL), and its answer is parsed strictly into claims.
- The broker's own identity comes only from the metadata server, through a
  hard-coded endpoint. Credential-bearing overrides in the environment refuse
  start-up, and the identity is checked against the stored setup record (the
  email from the metadata server, the unique id from tokeninfo) before the
  first sign and on every refresh.

Errors carry fixed codes only, never a token or a response body.
*/

import { isGcpServiceAccount } from "@cocalc/util/ai/federated-connectors";

export const GOOGLE_UNIQUE_ID_RE = /^[1-9][0-9]{5,31}$/;

export function isGoogleUniqueId(value: unknown): value is string {
  return typeof value === "string" && GOOGLE_UNIQUE_ID_RE.test(value);
}

export const CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";
export const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const METADATA_SA =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/";
const METADATA_TIMEOUT_MS = 1_000;
const TOKENINFO_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 8192;

/** Environment variables that would give the broker another credential. */
export const CREDENTIAL_OVERRIDE_VARS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
  "CLOUDSDK_CONFIG",
  "GCE_METADATA_HOST",
  "GCE_METADATA_IP",
] as const;

export class GoogleIdentityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GoogleIdentityError";
  }
}

export type TextFetch = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect: "error";
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Names of credential overrides present (names only, never values). */
export function credentialOverridesPresent(
  env: Record<string, string | undefined>,
): string[] {
  return CREDENTIAL_OVERRIDE_VARS.filter((name) => env[name] != null);
}

async function boundedText(
  fetchImpl: TextFetch,
  url: string,
  init: Omit<Parameters<TextFetch>[1], "signal" | "redirect">,
  timeoutMs: number,
  code: string,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new GoogleIdentityError(code);
    return { status: res.status, text };
  } catch (err) {
    if (err instanceof GoogleIdentityError) throw err;
    throw new GoogleIdentityError(code);
  } finally {
    clearTimeout(timer);
  }
}

export interface TokenClaims {
  azp: string;
  aud?: string;
  email?: string;
  scope: string;
  /** Seconds left when introspected. */
  expiresInS: number;
}

const TOKENINFO_KEYS = new Set([
  "azp",
  "aud",
  "email",
  "email_verified",
  "scope",
  "exp",
  "expires_in",
  "access_type",
  "sub",
]);

/** tokeninfo's answer, strictly; undefined if anything is off. */
export function parseTokenInfo(value: unknown): TokenClaims | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !TOKENINFO_KEYS.has(k))) return;
  if (!isGoogleUniqueId(v.azp)) return;
  if (v.aud !== undefined && !isGoogleUniqueId(v.aud)) return;
  if (v.sub !== undefined && !isGoogleUniqueId(v.sub)) return;
  if (v.email !== undefined && !isGcpServiceAccount(v.email)) {
    return;
  }
  if (typeof v.scope !== "string" || v.scope.length > 1024) return;
  // tokeninfo returns expires_in as a decimal string.
  const raw = v.expires_in;
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]{0,5})$/.test(raw)) return;
  return {
    azp: v.azp,
    ...(v.aud !== undefined ? { aud: v.aud as string } : {}),
    ...(v.email !== undefined ? { email: v.email as string } : {}),
    scope: v.scope,
    expiresInS: Number(raw),
  };
}

/** Introspects an access token by POST (form body); claims or a fixed error. */
export async function introspectAccessToken(
  fetchImpl: TextFetch,
  token: string,
): Promise<TokenClaims> {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    !/^[\x21-\x7e]+$/.test(token)
  ) {
    throw new GoogleIdentityError("tokeninfo_invalid");
  }
  const { status, text } = await boundedText(
    fetchImpl,
    TOKENINFO_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: token }).toString(),
    },
    TOKENINFO_TIMEOUT_MS,
    "tokeninfo_unavailable",
  );
  if (status !== 200) throw new GoogleIdentityError("tokeninfo_unavailable");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GoogleIdentityError("tokeninfo_invalid");
  }
  const claims = parseTokenInfo(json);
  if (claims == null) throw new GoogleIdentityError("tokeninfo_invalid");
  return claims;
}

/** The signer as recorded by setup: never free config. */
export interface SignerRecord {
  email: string;
  uniqueId: string;
}

export function parseSignerRecord(value: unknown): SignerRecord | undefined {
  const v = value as Record<string, unknown> | null;
  if (v == null || typeof v !== "object") return;
  if (!isGcpServiceAccount(v.email)) return;
  if (!isGoogleUniqueId(v.uniqueId)) return;
  return { email: v.email, uniqueId: v.uniqueId };
}

/**
 * The broker's signing credential, from the metadata server only, after
 * checking that it is exactly the recorded signer: the metadata email equals
 * the record's, and tokeninfo's azp (and aud and email, when present) equal
 * the record's. Any difference is identity_mismatch.
 */
export async function signerAccessToken({
  fetchImpl,
  record,
  env,
}: {
  fetchImpl: TextFetch;
  record: SignerRecord;
  env: Record<string, string | undefined>;
}): Promise<{ accessToken: string; expiresInS: number }> {
  if (credentialOverridesPresent(env).length > 0) {
    throw new GoogleIdentityError("credential_override_present");
  }
  const headers = { "Metadata-Flavor": "Google" };
  const email = await boundedText(
    fetchImpl,
    `${METADATA_SA}email`,
    { method: "GET", headers },
    METADATA_TIMEOUT_MS,
    "metadata_unavailable",
  );
  if (email.status !== 200)
    throw new GoogleIdentityError("metadata_unavailable");
  if (email.text.trim() !== record.email) {
    throw new GoogleIdentityError("identity_mismatch");
  }
  const tokenRes = await boundedText(
    fetchImpl,
    `${METADATA_SA}token`,
    { method: "GET", headers },
    METADATA_TIMEOUT_MS,
    "metadata_unavailable",
  );
  if (tokenRes.status !== 200) {
    throw new GoogleIdentityError("metadata_unavailable");
  }
  let token: any;
  try {
    token = JSON.parse(tokenRes.text);
  } catch {
    throw new GoogleIdentityError("metadata_unavailable");
  }
  if (
    typeof token?.access_token !== "string" ||
    !Number.isSafeInteger(token?.expires_in) ||
    token.expires_in <= 0
  ) {
    throw new GoogleIdentityError("metadata_unavailable");
  }
  const claims = await introspectAccessToken(fetchImpl, token.access_token);
  if (
    claims.azp !== record.uniqueId ||
    (claims.aud !== undefined && claims.aud !== record.uniqueId) ||
    (claims.email !== undefined && claims.email !== record.email)
  ) {
    throw new GoogleIdentityError("identity_mismatch");
  }
  return { accessToken: token.access_token, expiresInS: token.expires_in };
}

/**
 * The broker's fabric credential: a Google ID token from the metadata
 * server only (audience = the cluster id, format=full), never stored. The
 * fabric verifies it (broker-auth.ts); this only checks its shape.
 */
export async function metadataIdToken({
  fetchImpl,
  audience,
  env,
}: {
  fetchImpl: TextFetch;
  audience: string;
  env: Record<string, string | undefined>;
}): Promise<string> {
  if (credentialOverridesPresent(env).length > 0) {
    throw new GoogleIdentityError("credential_override_present");
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(audience)) {
    throw new GoogleIdentityError("broker_not_configured");
  }
  const res = await boundedText(
    fetchImpl,
    `${METADATA_SA}identity?audience=${audience}&format=full`,
    { method: "GET", headers: { "Metadata-Flavor": "Google" } },
    METADATA_TIMEOUT_MS,
    "metadata_unavailable",
  );
  const token = res.text.trim();
  if (
    res.status !== 200 ||
    token.length > MAX_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new GoogleIdentityError("metadata_unavailable");
  }
  return token;
}

// ---------------------------------------------------------------------------
// Google ID tokens: how the broker proves itself to the fabric (§3), with no
// stored secret. The broker gets one from its metadata server (audience = the
// cluster id); the fabric verifies it against Google's published keys.

export const GOOGLE_ID_TOKEN_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
];
export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ID_TOKEN_SKEW_S = 60;
const MAX_ID_TOKEN_LENGTH = 4096;

/** Google's public signing keys, by key id (JWK). */
export type GoogleCerts = Map<string, import("node:crypto").JsonWebKey>;

function b64urlJson(part: string): any {
  if (!/^[A-Za-z0-9_-]+$/.test(part))
    throw new GoogleIdentityError("id_token_invalid");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new GoogleIdentityError("id_token_invalid");
  }
}

/**
 * Verifies a Google-signed ID token for exactly the expected signer: RS256
 * with a current Google key, a Google issuer, the expected audience, not
 * expired (60 s skew), `sub` equal to the signer's unique id (string
 * compare) and, when present, `email` equal to the signer's email.
 */
export async function verifyGoogleIdToken({
  token,
  audience,
  signer,
  certs,
  nowS = Math.floor(Date.now() / 1000),
}: {
  token: string;
  audience: string;
  signer: SignerRecord;
  certs: () => Promise<GoogleCerts>;
  nowS?: number;
}): Promise<{ sub: string; exp: number }> {
  if (typeof token !== "string" || token.length > MAX_ID_TOKEN_LENGTH) {
    throw new GoogleIdentityError("id_token_invalid");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new GoogleIdentityError("id_token_invalid");
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (header?.alg !== "RS256" || typeof header?.kid !== "string") {
    throw new GoogleIdentityError("id_token_invalid");
  }
  const jwk = (await certs()).get(header.kid);
  if (jwk == null) throw new GoogleIdentityError("id_token_unknown_key");
  const { createPublicKey, verify } = await import("node:crypto");
  let ok = false;
  try {
    ok = verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new GoogleIdentityError("id_token_signature");
  if (!GOOGLE_ID_TOKEN_ISSUERS.includes(payload?.iss)) {
    throw new GoogleIdentityError("id_token_issuer");
  }
  if (payload?.aud !== audience)
    throw new GoogleIdentityError("id_token_audience");
  if (
    !Number.isSafeInteger(payload?.exp) ||
    payload.exp + ID_TOKEN_SKEW_S <= nowS
  ) {
    throw new GoogleIdentityError("id_token_expired");
  }
  if (
    Number.isSafeInteger(payload?.iat) &&
    payload.iat - ID_TOKEN_SKEW_S > nowS
  ) {
    throw new GoogleIdentityError("id_token_invalid");
  }
  if (!isGoogleUniqueId(payload?.sub) || payload.sub !== signer.uniqueId) {
    throw new GoogleIdentityError("identity_mismatch");
  }
  if (payload.email !== undefined && payload.email !== signer.email) {
    throw new GoogleIdentityError("identity_mismatch");
  }
  return { sub: payload.sub, exp: payload.exp };
}

/** Google's certificates, cached for at most 1 h (keyed by kid). */
export function googleCertsSource(
  fetchImpl: TextFetch,
  now: () => number = Date.now,
): () => Promise<GoogleCerts> {
  let cached: { certs: GoogleCerts; until: number } | undefined;
  return async () => {
    if (cached != null && now() < cached.until) return cached.certs;
    const { status, text } = await boundedText(
      fetchImpl,
      GOOGLE_CERTS_URL,
      { method: "GET", headers: {} },
      TOKENINFO_TIMEOUT_MS,
      "certs_unavailable",
    );
    if (status !== 200) throw new GoogleIdentityError("certs_unavailable");
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new GoogleIdentityError("certs_unavailable");
    }
    const certs: GoogleCerts = new Map();
    for (const key of Array.isArray(json?.keys) ? json.keys : []) {
      if (
        key?.kty === "RSA" &&
        typeof key.kid === "string" &&
        typeof key.n === "string" &&
        typeof key.e === "string"
      ) {
        certs.set(key.kid, { kty: "RSA", n: key.n, e: key.e });
      }
    }
    if (certs.size === 0) throw new GoogleIdentityError("certs_unavailable");
    cached = { certs, until: now() + 60 * 60 * 1000 };
    return certs;
  };
}
