/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { conatPassword } from "@cocalc/backend/data";
import { getClusterConfig } from "@cocalc/server/cluster-config";

const TOKEN_TYPE = "JWT";
const TOKEN_ALG = "HS256";
const TOKEN_VERSION = "home-bay-retry-v1";
const DEFAULT_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 15 * 60;
const MIN_TTL_SECONDS = 30;
const CLOCK_TOLERANCE_SECONDS = 30;
const AUDIENCE = "cocalc-home-bay-auth";
const ISSUER = "cocalc-cluster";

export interface HomeBayRetryClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  v: string;
  email?: string;
  account_id?: string;
  home_bay_id: string;
  purpose: "sign-in" | "sign-up" | "impersonate";
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = normalized.length % 4;
  const padded =
    padLen === 0 ? normalized : normalized + "=".repeat(4 - padLen);
  return Buffer.from(padded, "base64");
}

function normalizeTtlSeconds(ttl_seconds?: number): number {
  const ttl = Number(ttl_seconds ?? DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(ttl)) return DEFAULT_TTL_SECONDS;
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.floor(ttl)));
}

function getSharedSecret(): Buffer {
  const explicit =
    `${process.env.COCALC_HOME_BAY_RETRY_TOKEN_SECRET ?? ""}`.trim();
  if (explicit) {
    return Buffer.from(explicit, "utf8");
  }
  const cluster = getClusterConfig();
  const shared = `${cluster.seed_conat_password ?? conatPassword ?? ""}`.trim();
  if (!shared) {
    throw new Error("missing home-bay retry token signing secret");
  }
  return Buffer.from(shared, "utf8");
}

function signPayload(signingInput: string): Buffer {
  return createHmac("sha256", getSharedSecret()).update(signingInput).digest();
}

function parseClaims(token: string): {
  header: Record<string, any>;
  claims: HomeBayRetryClaims;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid token format");
  }
  const [encHeader, encClaims, encSig] = parts;
  const signingInput = `${encHeader}.${encClaims}`;
  const header = JSON.parse(base64UrlDecode(encHeader).toString("utf8"));
  const claims = JSON.parse(
    base64UrlDecode(encClaims).toString("utf8"),
  ) as HomeBayRetryClaims;
  const signature = base64UrlDecode(encSig);
  return { header, claims, signingInput, signature };
}

export function issueHomeBayRetryToken({
  email,
  account_id,
  home_bay_id,
  purpose,
  ttl_seconds,
  now_ms = Date.now(),
}: {
  email?: string;
  account_id?: string;
  home_bay_id: string;
  purpose: "sign-in" | "sign-up" | "impersonate";
  ttl_seconds?: number;
  now_ms?: number;
}): {
  token: string;
  expires_at: number;
  claims: HomeBayRetryClaims;
} {
  const normalizedEmail = `${email ?? ""}`.trim().toLowerCase();
  const normalizedAccountId = `${account_id ?? ""}`.trim();
  const normalizedBay = `${home_bay_id ?? ""}`.trim();
  if (!normalizedBay) {
    throw new Error("home_bay_id is required");
  }
  if (purpose === "impersonate") {
    if (!normalizedAccountId) {
      throw new Error("account_id is required");
    }
  } else if (!normalizedEmail) {
    throw new Error("email is required");
  }
  const iat = Math.floor(now_ms / 1000);
  const exp = iat + normalizeTtlSeconds(ttl_seconds);
  const claims: HomeBayRetryClaims = {
    iss: ISSUER,
    sub: normalizedEmail || normalizedAccountId,
    aud: AUDIENCE,
    iat,
    exp,
    jti: randomUUID(),
    v: TOKEN_VERSION,
    ...(normalizedEmail ? { email: normalizedEmail } : {}),
    ...(normalizedAccountId ? { account_id: normalizedAccountId } : {}),
    home_bay_id: normalizedBay,
    purpose,
  };
  const header = { typ: TOKEN_TYPE, alg: TOKEN_ALG };
  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encClaims = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encHeader}.${encClaims}`;
  const encSig = base64UrlEncode(signPayload(signingInput));
  return {
    token: `${signingInput}.${encSig}`,
    expires_at: exp * 1000,
    claims,
  };
}

export function verifyHomeBayRetryToken({
  token,
  home_bay_id,
  email,
  account_id,
  purpose,
  now_ms = Date.now(),
}: {
  token: string;
  home_bay_id: string;
  email?: string;
  account_id?: string;
  purpose?: "sign-in" | "sign-up" | "impersonate";
  now_ms?: number;
}): HomeBayRetryClaims {
  const { header, claims, signingInput, signature } = parseClaims(token);
  if (header?.typ !== TOKEN_TYPE || header?.alg !== TOKEN_ALG) {
    throw new Error("invalid token header");
  }
  const expected = signPayload(signingInput);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  ) {
    throw new Error("invalid token signature");
  }
  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) {
    throw new Error("invalid token issuer or audience");
  }
  if (claims.v !== TOKEN_VERSION) {
    throw new Error("invalid token version");
  }
  const now = Math.floor(now_ms / 1000);
  if (claims.exp + CLOCK_TOLERANCE_SECONDS < now) {
    throw new Error("retry token expired");
  }
  if (claims.iat - CLOCK_TOLERANCE_SECONDS > now) {
    throw new Error("retry token issued in the future");
  }
  if (`${claims.home_bay_id ?? ""}`.trim() !== `${home_bay_id ?? ""}`.trim()) {
    throw new Error("retry token home bay mismatch");
  }
  if (purpose && claims.purpose !== purpose) {
    throw new Error("retry token purpose mismatch");
  }
  if (
    email &&
    `${claims.email ?? ""}`.trim().toLowerCase() !==
      `${email ?? ""}`.trim().toLowerCase()
  ) {
    throw new Error("retry token email mismatch");
  }
  if (
    account_id &&
    `${claims.account_id ?? ""}`.trim() !== `${account_id ?? ""}`.trim()
  ) {
    throw new Error("retry token account_id mismatch");
  }
  return claims;
}
