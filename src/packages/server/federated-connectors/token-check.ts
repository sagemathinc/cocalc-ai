/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The home bay's check of every issued token before it reaches a host (G3b
design v3 §6). The broker is not trusted for the token's identity: the
token is introspected at Google and its claims are compared with the hub's
own, freshly read grant row.

The cache holds claims, never a verdict: it is keyed by the token's sha256
and expires by a monotonic deadline that never outlives the token. Every
answer, cache hit or not, compares the claims again with the fresh grant.
*/

import { createHash } from "node:crypto";
import { ACCESS_TOKEN_LIFETIME_S } from "@cocalc/util/ai/federated-connectors";
import {
  CLOUD_PLATFORM_SCOPE,
  isGoogleUniqueId,
  type TokenClaims,
} from "./google-identity";

/** The grant as the hub has it right now (never the broker's labels). */
export interface GrantIdentity {
  service_account: string;
  service_account_unique_id: string;
  connection_id: string;
  target_project: string;
}

/** What the broker says it issued. */
export interface IssuedClaimsToCheck {
  token: string;
  /** The broker's expiry, ms since the epoch. */
  expires_at: number;
  connection_id: string;
  project: string;
}

const EXPIRY_SLACK_S = 60;

export class TokenCheckError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TokenCheckError";
  }
}

const tokenKey = (token: string) =>
  createHash("sha256").update(token).digest("hex");

interface CachedClaims {
  claims: TokenClaims;
  /** Wall-clock ms when introspected (for the token's remaining life). */
  introspectedAt: number;
  /** Monotonic ms after which the entry is gone. */
  deadline: number;
}

export class TokenClaimsCache {
  private entries = new Map<string, CachedClaims>();
  constructor(
    private monotonicNow: () => number = () => performance.now(),
    private maxEntries = 10_000,
  ) {}

  get(token: string): CachedClaims | undefined {
    const key = tokenKey(token);
    const entry = this.entries.get(key);
    if (entry == null) return;
    if (this.monotonicNow() >= entry.deadline) {
      this.entries.delete(key);
      return;
    }
    return entry;
  }

  set(token: string, claims: TokenClaims, introspectedAt: number): void {
    if (this.entries.size >= this.maxEntries) {
      // Drop the oldest entry (insertion order).
      const first = this.entries.keys().next().value;
      if (first != null) this.entries.delete(first);
    }
    this.entries.set(tokenKey(token), {
      claims,
      introspectedAt,
      // Never longer than the token itself lives.
      deadline: this.monotonicNow() + claims.expiresInS * 1000,
    });
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Compares claims with the fresh grant and the broker's statement. */
export function compareClaims({
  claims,
  introspectedAt,
  now,
  grant,
  issued,
}: {
  claims: TokenClaims;
  introspectedAt: number;
  now: number;
  grant: GrantIdentity;
  issued: IssuedClaimsToCheck;
}): void {
  const fail = (code: string): never => {
    throw new TokenCheckError(code);
  };
  if (!isGoogleUniqueId(grant.service_account_unique_id)) {
    fail("grant_identity_missing");
  }
  if (claims.azp !== grant.service_account_unique_id) fail("token_identity");
  if (
    claims.aud !== undefined &&
    claims.aud !== grant.service_account_unique_id
  ) {
    fail("token_identity");
  }
  if (claims.email !== undefined && claims.email !== grant.service_account) {
    fail("token_identity");
  }
  if (claims.scope !== CLOUD_PLATFORM_SCOPE) fail("token_scope");
  // When the token really expires, by Google's account.
  const tokenExpiresAt = introspectedAt + claims.expiresInS * 1000;
  const remaining = tokenExpiresAt - now;
  if (
    remaining <= 0 ||
    remaining > (ACCESS_TOKEN_LIFETIME_S + EXPIRY_SLACK_S) * 1000
  ) {
    fail("token_expiry");
  }
  if (Math.abs(issued.expires_at - tokenExpiresAt) > EXPIRY_SLACK_S * 1000) {
    fail("token_expiry");
  }
  if (issued.connection_id !== grant.connection_id) fail("token_connection");
  if (issued.project !== grant.target_project) fail("token_project");
}

/**
 * Checks one issued token. Introspects at Google only on a cache miss; the
 * comparison with the fresh grant runs every time.
 */
export async function checkIssuedToken({
  issued,
  grant,
  cache,
  introspect,
  now = Date.now,
}: {
  issued: IssuedClaimsToCheck;
  grant: GrantIdentity;
  cache: TokenClaimsCache;
  introspect: (token: string) => Promise<TokenClaims>;
  now?: () => number;
}): Promise<void> {
  let cached = cache.get(issued.token);
  if (cached == null) {
    let claims: TokenClaims;
    try {
      claims = await introspect(issued.token);
    } catch {
      throw new TokenCheckError("tokeninfo_unavailable");
    }
    const introspectedAt = now();
    cache.set(issued.token, claims, introspectedAt);
    cached = { claims, introspectedAt, deadline: 0 };
  }
  compareClaims({
    claims: cached.claims,
    introspectedAt: cached.introspectedAt,
    now: now(),
    grant,
    issued,
  });
}
