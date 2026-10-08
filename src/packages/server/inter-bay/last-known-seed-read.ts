/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Reads of seed-global configuration (e.g. membership tiers) from an
// attached bay. They are read fresh whenever the seed answers, so admin
// changes show up immediately.
//
// Callers that opt in with `allowStale` (e.g. resolving an account's current
// limits, admitting a new project) keep working while the seed is
// unreachable, with the last value read successfully, but only up to
// `maxStaleMs` after that read: policy changes made on the seed (a disabled
// tier, a draining bay) reach an isolated bay late, but never arbitrarily
// late. Such callers wait only briefly for the seed, and after a failure skip
// it entirely for a short backoff. Everything else (purchases, prices,
// trials) always needs a fresh answer and fails while the seed is down.

import getLogger from "@cocalc/backend/logger";

const logger = getLogger("server:inter-bay:last-known-seed-read");

// Shared by all reads: once the seed fails to answer one of them, the others
// do not each wait for it again during the backoff.
let unavailableUntil = 0;

export interface LastKnownSeedReadOptions {
  /** Wait this long for the seed when no usable last-known value exists. */
  timeoutMs?: number;
  /** Wait this long for the seed when a usable last-known value exists. */
  fallbackTimeoutMs?: number;
  /** After a failure, skip the seed this long (retry backoff only). */
  backoffMs?: number;
  /** Never use a value read longer ago than this. */
  maxStaleMs?: number;
}

export function lastKnownSeedRead<T>(
  name: string,
  {
    timeoutMs = 15_000,
    fallbackTimeoutMs = 3_000,
    backoffMs = 30_000,
    maxStaleMs = 10 * 60_000,
  }: LastKnownSeedReadOptions = {},
) {
  const lastKnown = new Map<string, { value: T; fetchedAt: number }>();

  const read = async (
    key: string,
    fetch: (timeout_ms: number) => Promise<T>,
    { allowStale = false }: { allowStale?: boolean } = {},
  ): Promise<T> => {
    const known = lastKnown.get(key);
    const usable =
      allowStale && known != null && Date.now() - known.fetchedAt <= maxStaleMs;
    if (usable && Date.now() < unavailableUntil) {
      return known!.value;
    }
    try {
      const timeout_ms = usable ? fallbackTimeoutMs : timeoutMs;
      const value = await withTimeout(fetch(timeout_ms), timeout_ms, name);
      lastKnown.set(key, { value, fetchedAt: Date.now() });
      unavailableUntil = 0;
      return value;
    } catch (err) {
      if (!usable) throw err;
      unavailableUntil = Date.now() + backoffMs;
      logger.warn("seed unavailable; using the last-known value", {
        name,
        key,
        age_ms: Date.now() - known!.fetchedAt,
        err: `${err}`,
      });
      return known!.value;
    }
  };

  read.clearForTests = () => {
    lastKnown.clear();
    unavailableUntil = 0;
  };
  return read;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeout_ms: number,
  name: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out reading ${name} from the seed`)),
          timeout_ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
