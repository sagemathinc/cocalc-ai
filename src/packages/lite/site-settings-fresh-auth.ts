/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_OUTSTANDING_GRANTS = 32;
const MAX_BROWSER_ID_LENGTH = 256;

interface Grant {
  account_id: string;
  browser_id: string;
  expires_at: number;
}

let accessTokenHash: Buffer | undefined;
const grants = new Map<string, Grant>();

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function grantKey(token: string): string {
  return hash(token).toString("hex");
}

function normalizeRequired(value: unknown, name: string, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw Error(`${name} is required`);
  }
  return normalized;
}

function pruneExpired(now = Date.now()): void {
  for (const [key, grant] of grants) {
    if (grant.expires_at <= now) grants.delete(key);
  }
}

export function configureLiteSiteSettingsFreshAuth(
  authToken: string | undefined,
): void {
  accessTokenHash = authToken ? hash(authToken) : undefined;
  grants.clear();
}

export function authorizeLiteSiteSettings({
  access_token,
  account_id,
  browser_id,
  now = Date.now(),
}: {
  access_token: unknown;
  account_id: string;
  browser_id: unknown;
  now?: number;
}): { fresh_auth_token: string; expires_at: string } {
  const browserId = normalizeRequired(
    browser_id,
    "browser_id",
    MAX_BROWSER_ID_LENGTH,
  );
  const candidate =
    typeof access_token === "string" ? hash(access_token) : null;
  if (
    accessTokenHash == null ||
    candidate == null ||
    !timingSafeEqual(accessTokenHash, candidate)
  ) {
    throw Error("Lite access token is invalid or unavailable");
  }

  pruneExpired(now);
  if (grants.size >= MAX_OUTSTANDING_GRANTS) {
    throw Error("too many outstanding Lite authorization grants");
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + GRANT_TTL_MS;
  grants.set(grantKey(token), {
    account_id,
    browser_id: browserId,
    expires_at: expiresAt,
  });
  return {
    fresh_auth_token: token,
    expires_at: new Date(expiresAt).toISOString(),
  };
}

export function consumeLiteSiteSettingsFreshAuth({
  fresh_auth_token,
  account_id,
  browser_id,
  now = Date.now(),
}: {
  fresh_auth_token: unknown;
  account_id: string;
  browser_id: unknown;
  now?: number;
}): void {
  const browserId = normalizeRequired(
    browser_id,
    "browser_id",
    MAX_BROWSER_ID_LENGTH,
  );
  const token = normalizeRequired(fresh_auth_token, "fresh_auth_token", 512);
  const key = grantKey(token);
  const grant = grants.get(key);
  grants.delete(key);
  if (
    grant == null ||
    grant.expires_at <= now ||
    grant.account_id !== account_id ||
    grant.browser_id !== browserId
  ) {
    throw Error("fresh Lite authorization is required");
  }
}
