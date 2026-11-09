/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The federated connector broker: the only place that signs assertions and
// exchanges them for short-lived cloud access tokens. Every request, cached
// or not, passes all of these checks first:
//   1. the grant: it exists for this account, it and its connection are
//      enabled, the connection passed its setup audience test, and its
//      revision is the one the lease was created with;
//   2. the turn: the calling host is running this agent's live turn;
//   3. the site allowlist: provider, service account, permission profile
//      and target project are allowed on this site;
// then rate limits and a fresh clock check before any signing. A cached
// token is returned only after all checks pass, so revoking a grant stops
// renewal at once; a new exchange happens only past the token's half-life.
// Tokens and assertions are never logged, recorded or put in an error.

import {
  ACCESS_TOKEN_LIFETIME_S,
  isGcpProjectId,
  isGcpServiceAccount,
  isSaLabel,
  isUuid,
  wifExchangeAudience,
  type WifProvider,
} from "@cocalc/util/ai/federated-connectors";
import {
  exchangeAssertion,
  generateAccessToken,
  GoogleCallError,
  type FetchLike,
} from "./google";
import { assertClockWithinSkew, signAssertion } from "./issuer";
import type { FederationSigner } from "./signer";

export interface MintRequest {
  site_id: string;
  account_id: string;
  agent_id: string;
  project_id: string;
  host_id: string;
  run_id: string;
  grant_id: string;
  lease_id: string;
  /** The grant revision the lease was created with. */
  grant_revision: number;
}

export interface GrantRecord {
  grant_id: string;
  account_id: string;
  connection_id: string;
  revision: number;
  state: string;
  service_account: string;
  sa_label: string;
  target_project: string;
  permission_profile: string;
}

export interface ConnectionRecord {
  connection_id: string;
  account_id: string;
  provider: string;
  state: string;
  /** True only once the setup audience test has passed and was recorded. */
  audience_test_passed: boolean;
  provider_ref: WifProvider;
}

export interface MintLogRow {
  outcome: "issued" | "denied" | "error";
  reason: string | null;
  site_id: string;
  account_id: string;
  agent_id: string;
  project_id: string;
  host_id: string;
  run_id: string;
  connection_id: string | null;
  grant_id: string;
  grant_revision: number;
  lease_id: string;
  jti: string | null;
  key_version: string | null;
  service_account: string | null;
  issued_at: number | null;
  expires_at: number | null;
}

export interface BrokerDeps {
  issuer: string;
  signer: FederationSigner;
  fetchImpl: FetchLike;
  /** Check 1 (home bay): the grant and its connection, or null. */
  loadGrant(opts: {
    account_id: string;
    grant_id: string;
  }): Promise<{ grant: GrantRecord; connection: ConnectionRecord } | null>;
  /** Check 2 (owning bay/host): throws unless the turn is live. */
  verifyLiveTurn(request: MintRequest): Promise<void>;
  /** Check 3: the site's allowlist. */
  isAllowlisted(entry: {
    provider: string;
    service_account: string;
    permission_profile: string;
    target_project: string;
  }): Promise<boolean>;
  /** A trusted reference time (e.g. a Google response's Date header). */
  referenceNow(): Promise<number>;
  now(): number;
  /**
   * A monotonic clock in milliseconds (never jumps with the wall clock);
   * defaults to performance.now().
   */
  monotonicNow?: () => number;
  /** Runs fn holding a lock for this lease (one exchange in flight). */
  withLeaseLock<T>(lease_id: string, fn: () => Promise<T>): Promise<T>;
  /** Appends a mint log row (the database sets its time). */
  recordMint(row: MintLogRow): Promise<void>;
  /**
   * Appends rows in one transaction (an issued token withheld after the
   * final home-bay check: its issued row and its home_bay_moved row).
   * Without it, the rows are appended one by one.
   */
  recordMints?(rows: MintLogRow[]): Promise<void>;
  limiter: RateLimiter;
  /** Half-life jitter in [0, 1): defaults to Math.random. */
  random?: () => number;
}

export type MintResult =
  | {
      status: "issued";
      token: string;
      expires_at: number;
      grant_revision: number;
      connection_id: string;
      project: string;
      sa_label: string;
    }
  | { status: "denied"; reason: string }
  | { status: "error"; reason: string; retry_after_ms?: number };

// ---------------------------------------------------------------------------
// Rate limits: token buckets per site, provider, account and grant.

export interface RateLimiter {
  /** Takes one token from every key's bucket, or none if any is empty. */
  take(keys: string[], now: number): boolean;
}

export class TokenBucketLimiter implements RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private limits: Record<string, { capacity: number; perMinute: number }>,
  ) {}

  private limitFor(key: string) {
    const kind = key.slice(0, key.indexOf(":"));
    const limit = this.limits[kind];
    if (!limit) throw Error(`no rate limit for ${kind}`);
    return limit;
  }

  take(keys: string[], now: number): boolean {
    const states = keys.map((key) => {
      const limit = this.limitFor(key);
      const prev = this.buckets.get(key) ?? {
        tokens: limit.capacity,
        at: now,
      };
      const refill = ((now - prev.at) / 60_000) * limit.perMinute;
      return {
        key,
        tokens: Math.min(limit.capacity, prev.tokens + Math.max(0, refill)),
      };
    });
    if (states.some((s) => s.tokens < 1)) return false;
    for (const s of states) {
      this.buckets.set(s.key, { tokens: s.tokens - 1, at: now });
    }
    return true;
  }
}

export const DEFAULT_RATE_LIMITS = {
  site: { capacity: 600, perMinute: 600 },
  provider: { capacity: 600, perMinute: 600 },
  account: { capacity: 60, perMinute: 60 },
  grant: { capacity: 20, perMinute: 20 },
};

// ---------------------------------------------------------------------------

/** A reference time is fresh for this long; then it is fetched again. */
export const CLOCK_REFERENCE_MAX_AGE_MS = 5 * 60_000;

/**
 * The caller's binding (design v3.3.2): scope is the fabric-authenticated
 * caller bay, so answers are never shared across callers; confirmHome is the
 * final authoritative home-bay check, run after minting and before a token
 * is cached or returned (and before a cached token is returned).
 */
export interface MintGuard {
  scope: string;
  confirmHome(): Promise<boolean>;
}

interface CachedToken {
  lease_id: string;
  token: string;
  expires_at: number;
  renew_at: number;
  grant_revision: number;
}

function validRequest(r: MintRequest): boolean {
  return (
    r != null &&
    typeof r === "object" &&
    isUuid(r.site_id) &&
    isUuid(r.account_id) &&
    isUuid(r.agent_id) &&
    isUuid(r.project_id) &&
    isUuid(r.host_id) &&
    isUuid(r.run_id) &&
    isUuid(r.grant_id) &&
    isUuid(r.lease_id) &&
    Number.isSafeInteger(r.grant_revision) &&
    r.grant_revision >= 1
  );
}

/**
 * The identity of one request. The cache and the in-flight dedupe are keyed
 * by all of it, so a request never receives a token (or an answer) obtained
 * for another account, agent, project, host, run, grant or revision, even
 * with the same lease id.
 */
function requestKey(r: MintRequest, scope?: string): string {
  return JSON.stringify([
    scope ?? null,
    r.site_id,
    r.account_id,
    r.agent_id,
    r.project_id,
    r.host_id,
    r.run_id,
    r.grant_id,
    r.lease_id,
    r.grant_revision,
  ]);
}

export class FederatedTokenBroker {
  private cache = new Map<string, CachedToken>();
  private inflight = new Map<string, Promise<MintResult>>();
  // A trusted reference time and the monotonic time it was taken at.
  private clock?: { reference: number; monotonic: number };
  private invalidRequests = 0;
  private homeBayMoved = 0;

  /** Counters for health reporting (no ids, nothing secret). */
  stats(): {
    invalid_requests: number;
    cached_tokens: number;
    home_bay_moved: number;
  } {
    return {
      invalid_requests: this.invalidRequests,
      cached_tokens: this.cache.size,
      home_bay_moved: this.homeBayMoved,
    };
  }

  constructor(private deps: BrokerDeps) {}

  /** Drops every cached token of a lease (revoke, end of turn). */
  forget(lease_id: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.lease_id === lease_id) this.cache.delete(key);
    }
  }

  /**
   * One token request. Concurrent identical requests (same lease, account,
   * grant, turn and revision) share one answer; any other request runs its
   * own checks.
   */
  async getToken(request: MintRequest, guard?: MintGuard): Promise<MintResult> {
    if (!validRequest(request)) {
      // Can't be logged as a row (its ids aren't valid); counted instead.
      this.invalidRequests += 1;
      return { status: "denied", reason: "invalid_request" };
    }
    const key = requestKey(request, guard?.scope);
    const running = this.inflight.get(key);
    if (running) return await running;
    const p = this.deps
      .withLeaseLock(request.lease_id, () => this.serve(request, key, guard))
      .catch(async (): Promise<MintResult> => {
        await this.recordBestEffort({
          ...this.base(request),
          outcome: "error",
          reason: "broker_failure",
        });
        return { status: "error", reason: "broker_failure" };
      });
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  // A refusal is recorded best effort: a failed log write never turns a
  // refusal into anything else.
  private async recordBestEffort(row: MintLogRow): Promise<void> {
    try {
      await this.deps.recordMint(row);
    } catch {
      // nothing more to do; the request is refused either way
    }
  }

  private base(request: MintRequest): Omit<MintLogRow, "outcome" | "reason"> {
    return {
      site_id: request.site_id,
      account_id: request.account_id,
      agent_id: request.agent_id,
      project_id: request.project_id,
      host_id: request.host_id,
      run_id: request.run_id,
      connection_id: null,
      grant_id: request.grant_id,
      grant_revision: request.grant_revision,
      lease_id: request.lease_id,
      jti: null,
      key_version: null,
      service_account: null,
      issued_at: null,
      expires_at: null,
    };
  }

  private async refuse(
    request: MintRequest,
    outcome: "denied" | "error",
    reason: string,
    extra: Partial<MintLogRow> = {},
    retry_after_ms?: number,
  ): Promise<MintResult> {
    if (outcome === "denied") this.cache.delete(requestKey(request));
    await this.recordBestEffort({
      ...this.base(request),
      ...extra,
      outcome,
      reason,
    });
    return outcome === "denied"
      ? { status: "denied", reason }
      : { status: "error", reason, retry_after_ms };
  }

  // The final home-bay check: false on any doubt.
  private async stillHome(guard?: MintGuard): Promise<boolean> {
    if (guard == null) return true;
    try {
      return (await guard.confirmHome()) === true;
    } catch {
      return false;
    }
  }

  private async recordRows(rows: MintLogRow[]): Promise<void> {
    if (this.deps.recordMints) {
      await this.deps.recordMints(rows);
      return;
    }
    for (const row of rows) await this.deps.recordMint(row);
  }

  // Withholds a token (or a cached one) the final check refused.
  private withhold(request: MintRequest): MintResult {
    this.homeBayMoved += 1;
    this.forget(request.lease_id);
    return { status: "denied", reason: "not_home_bay" };
  }

  private async serve(
    request: MintRequest,
    key: string,
    guard?: MintGuard,
  ): Promise<MintResult> {
    const deps = this.deps;
    // 1. The grant at the lease's exact revision.
    let loaded: Awaited<ReturnType<BrokerDeps["loadGrant"]>>;
    try {
      loaded = await deps.loadGrant({
        account_id: request.account_id,
        grant_id: request.grant_id,
      });
    } catch {
      return await this.refuse(request, "error", "grant_lookup_failed");
    }
    if (loaded == null) {
      return await this.refuse(request, "denied", "grant_missing");
    }
    const { grant, connection } = loaded;
    const ids = { connection_id: grant.connection_id };
    if (
      grant.account_id !== request.account_id ||
      connection.account_id !== request.account_id ||
      connection.connection_id !== grant.connection_id
    ) {
      return await this.refuse(request, "denied", "grant_mismatch", ids);
    }
    if (grant.state !== "enabled") {
      return await this.refuse(request, "denied", "grant_not_enabled", ids);
    }
    if (connection.state !== "enabled" || connection.provider !== "gcp") {
      return await this.refuse(
        request,
        "denied",
        "connection_not_enabled",
        ids,
      );
    }
    if (!connection.audience_test_passed) {
      return await this.refuse(request, "denied", "audience_unverified", ids);
    }
    if (grant.revision !== request.grant_revision) {
      return await this.refuse(request, "denied", "revision", ids);
    }
    if (
      !isGcpServiceAccount(grant.service_account) ||
      !isGcpProjectId(grant.target_project) ||
      !isSaLabel(grant.sa_label)
    ) {
      return await this.refuse(request, "denied", "grant_malformed", ids);
    }
    // 2. The live turn on the calling host.
    try {
      await deps.verifyLiveTurn(request);
    } catch {
      return await this.refuse(request, "denied", "turn_not_live", ids);
    }
    // 3. The site allowlist.
    let allowed = false;
    try {
      allowed = await deps.isAllowlisted({
        provider: connection.provider,
        service_account: grant.service_account,
        permission_profile: grant.permission_profile,
        target_project: grant.target_project,
      });
    } catch {
      return await this.refuse(
        request,
        "error",
        "allowlist_lookup_failed",
        ids,
      );
    }
    if (!allowed) {
      return await this.refuse(request, "denied", "not_allowlisted", ids);
    }

    const issued = (token: string, expires_at: number): MintResult => ({
      status: "issued",
      token,
      expires_at,
      grant_revision: grant.revision,
      connection_id: grant.connection_id,
      project: grant.target_project,
      sa_label: grant.sa_label,
    });

    // A cached token past every check, before its renewal time.
    const now = deps.now();
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.grant_revision === grant.revision &&
      now < cached.renew_at &&
      now < cached.expires_at
    ) {
      if (!(await this.stillHome(guard))) {
        await this.recordBestEffort({
          ...this.base(request),
          ...ids,
          outcome: "denied",
          reason: "home_bay_moved",
        });
        return this.withhold(request);
      }
      return issued(cached.token, cached.expires_at);
    }

    // Rate limits, then a fresh clock check, before any signing.
    if (
      !deps.limiter.take(
        [
          `site:${request.site_id}`,
          `provider:${connection.provider}`,
          `account:${request.account_id}`,
          `grant:${request.grant_id}`,
        ],
        now,
      )
    ) {
      return await this.refuse(request, "error", "rate_limited", ids, 60_000);
    }
    // Before EVERY sign: the wall clock must agree with the trusted
    // reference advanced by the monotonic clock, so a wall-clock step in
    // either direction is caught at once. The reference is refreshed when it
    // is older than CLOCK_REFERENCE_MAX_AGE_MS of monotonic time.
    try {
      const mono = deps.monotonicNow ?? (() => performance.now());
      const age = this.clock ? mono() - this.clock.monotonic : Infinity;
      if (!this.clock || !(age >= 0) || age > CLOCK_REFERENCE_MAX_AGE_MS) {
        const reference = await deps.referenceNow();
        if (!Number.isFinite(reference)) throw Error("no reference");
        this.clock = { reference, monotonic: mono() };
      }
      assertClockWithinSkew({
        localNow: deps.now(),
        referenceNow: this.clock.reference + (mono() - this.clock.monotonic),
      });
    } catch {
      this.clock = undefined;
      return await this.refuse(request, "error", "clock_unverified", ids);
    }

    const sa = { ...ids, service_account: grant.service_account };
    let signed;
    try {
      signed = await signAssertion(deps.signer, {
        issuer: deps.issuer,
        provider: connection.provider_ref,
        attributes: {
          site_id: request.site_id,
          account_id: request.account_id,
          agent_id: request.agent_id,
          project_id: request.project_id,
          connection_id: grant.connection_id,
          grant_id: request.grant_id,
          grant_revision: `${grant.revision}`,
          lease_id: request.lease_id,
        },
        now,
      });
    } catch {
      return await this.refuse(request, "error", "sign_failed", sa);
    }
    const signedIds = {
      ...sa,
      jti: signed.jti,
      key_version: signed.keyVersion,
    };
    try {
      const { federatedToken } = await exchangeAssertion({
        fetchImpl: deps.fetchImpl,
        assertion: signed.assertion,
        exchangeAudience: wifExchangeAudience(connection.provider_ref),
      });
      const { accessToken, expiresAt } = await generateAccessToken({
        fetchImpl: deps.fetchImpl,
        federatedToken,
        serviceAccount: grant.service_account,
        now,
      });
      // The final home-bay check, before the token is cached or returned
      // (v3.3.2). Google did issue it, so its row is written either way;
      // a withheld token gets a home_bay_moved row in the same transaction.
      const home = await this.stillHome(guard);
      const rows: MintLogRow[] = [
        {
          ...this.base(request),
          ...signedIds,
          outcome: "issued",
          reason: null,
          issued_at: now,
          expires_at: expiresAt,
        },
      ];
      if (!home) {
        rows.push({
          ...this.base(request),
          ...signedIds,
          outcome: "denied",
          reason: "home_bay_moved",
        });
      }
      // Record the mint first: a token without its mint log row is never
      // cached or returned.
      try {
        await this.recordRows(rows);
      } catch {
        if (!home) this.withhold(request);
        return { status: "error", reason: "audit_write_failed" };
      }
      if (!home) return this.withhold(request);
      const lifetime = Math.max(0, expiresAt - now);
      const jitter = (deps.random ?? Math.random)() * 0.2 - 0.1;
      this.cache.set(key, {
        lease_id: request.lease_id,
        token: accessToken,
        expires_at: expiresAt,
        renew_at: now + lifetime * (0.5 + jitter),
        grant_revision: grant.revision,
      });
      return issued(accessToken, expiresAt);
    } catch (err) {
      if (err instanceof GoogleCallError) {
        if (err.kind === "deny") {
          return await this.refuse(request, "denied", err.code, signedIds);
        }
        return await this.refuse(
          request,
          "error",
          err.code,
          signedIds,
          err.retryAfterMs,
        );
      }
      return await this.refuse(request, "error", "exchange_failed", signedIds);
    }
  }
}

/** Requested access-token lifetime, for documentation and tests. */
export const BROKER_ACCESS_TOKEN_LIFETIME_S = ACCESS_TOKEN_LIFETIME_S;
