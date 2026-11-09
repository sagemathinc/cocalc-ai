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
