/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "crypto";
import {
  getProjectHostAuthTokenPrivateKey,
  getProjectHostAuthTokenPublicKey,
} from "@cocalc/backend/data";

const TOKEN_TYPE = "JWT";
const TOKEN_ALG = "EdDSA";
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
  email: string;
  home_bay_id: string;
  purpose: "sign-in" | "sign-up";
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

function getPrivateKey() {
  return createPrivateKey(getProjectHostAuthTokenPrivateKey());
}

function getPublicKey() {
  return createPublicKey(getProjectHostAuthTokenPublicKey());
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
  home_bay_id,
  purpose,
  ttl_seconds,
  now_ms = Date.now(),
}: {
  email: string;
  home_bay_id: string;
  purpose: "sign-in" | "sign-up";
  ttl_seconds?: number;
  now_ms?: number;
}): {
  token: string;
  expires_at: number;
  claims: HomeBayRetryClaims;
} {
  const normalizedEmail = `${email ?? ""}`.trim().toLowerCase();
  const normalizedBay = `${home_bay_id ?? ""}`.trim();
  if (!normalizedEmail) {
    throw new Error("email is required");
  }
  if (!normalizedBay) {
    throw new Error("home_bay_id is required");
  }
  const iat = Math.floor(now_ms / 1000);
  const exp = iat + normalizeTtlSeconds(ttl_seconds);
  const claims: HomeBayRetryClaims = {
    iss: ISSUER,
    sub: normalizedEmail,
    aud: AUDIENCE,
    iat,
    exp,
    jti: randomUUID(),
    v: TOKEN_VERSION,
    email: normalizedEmail,
    home_bay_id: normalizedBay,
    purpose,
  };
  const header = { typ: TOKEN_TYPE, alg: TOKEN_ALG };
  const encHeader = base64UrlEncode(JSON.stringify(header));
  const encClaims = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encHeader}.${encClaims}`;
  const encSig = base64UrlEncode(
    cryptoSign(null, Buffer.from(signingInput), getPrivateKey()),
  );
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
  purpose,
  now_ms = Date.now(),
}: {
  token: string;
  home_bay_id: string;
  email?: string;
  purpose?: "sign-in" | "sign-up";
  now_ms?: number;
}): HomeBayRetryClaims {
  const { header, claims, signingInput, signature } = parseClaims(token);
  if (header?.typ !== TOKEN_TYPE || header?.alg !== TOKEN_ALG) {
    throw new Error("invalid token header");
  }
  if (
    !cryptoVerify(null, Buffer.from(signingInput), getPublicKey(), signature)
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
  return claims;
}
