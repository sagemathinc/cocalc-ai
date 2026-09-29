/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHmac, randomBytes } from "node:crypto";
import TTL from "@isaacs/ttlcache";

const TOKEN_FAILURE_WINDOW_MS = 10 * 60_000;
const TOKEN_FAILURE_LIMIT = 12;
const TOKEN_FAILURE_SOURCE_LIMIT = 10_000;

interface TokenFailure {
  at: number;
  fingerprint: string;
  token_hash: string;
}

interface Options {
  limit?: number;
  now?: () => number;
  source_limit?: number;
  window_ms?: number;
  fingerprint_key?: Buffer;
}

export class ExamTokenFailureLimit {
  private readonly failures: TTL<string, TokenFailure[]>;
  private readonly fingerprintKey: Buffer;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor({
    limit = TOKEN_FAILURE_LIMIT,
    now = Date.now,
    source_limit = TOKEN_FAILURE_SOURCE_LIMIT,
    window_ms = TOKEN_FAILURE_WINDOW_MS,
    fingerprint_key = randomBytes(32),
  }: Options = {}) {
    this.limit = limit;
    this.now = now;
    this.windowMs = window_ms;
    this.fingerprintKey = fingerprint_key;
    this.failures = new TTL<string, TokenFailure[]>({
      max: source_limit,
      ttl: window_ms,
    });
  }

  /**
   * Returns true when this exact candidate is already known to be invalid.
   * Identical stale tokens from students behind one classroom NAT therefore
   * consume one failure, while distinct guesses still consume the full limit.
   */
  knownInvalidOrThrow({
    source,
    token,
    token_hash,
  }: {
    source: string;
    token: string;
    token_hash: string;
  }): boolean {
    const fingerprint = this.fingerprint(token);
    const recent = this.recent(source, token_hash);
    if (recent.some((failure) => failure.fingerprint === fingerprint)) {
      return true;
    }
    if (recent.length >= this.limit) {
      throw new Error("too many unsuccessful exam join attempts; try later");
    }
    return false;
  }

  noteInvalid({
    source,
    token,
    token_hash,
  }: {
    source: string;
    token: string;
    token_hash: string;
  }): void {
    const fingerprint = this.fingerprint(token);
    const recent = this.recent(source, token_hash);
    if (!recent.some((failure) => failure.fingerprint === fingerprint)) {
      recent.push({ at: this.now(), fingerprint, token_hash });
      this.failures.set(source, recent);
    }
  }

  clear(source: string): void {
    this.failures.delete(source);
  }

  private fingerprint(token: string): string {
    return createHmac("sha256", this.fingerprintKey)
      .update(token)
      .digest("base64url");
  }

  private recent(source: string, token_hash: string): TokenFailure[] {
    const now = this.now();
    const recent = (this.failures.get(source) ?? []).filter(
      (failure) =>
        failure.token_hash === token_hash && now - failure.at < this.windowMs,
    );
    if (recent.length === 0) {
      this.failures.delete(source);
    } else {
      this.failures.set(source, recent);
    }
    return recent;
  }
}
