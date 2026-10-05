/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Reads of seed-global configuration (e.g. membership tiers) from an
// attached bay. They are read fresh whenever the seed answers, so admin
// changes show up immediately. While the seed is unreachable, the bay keeps
// working with the last value it read successfully instead of failing every
// request that needs it: it waits only briefly for the seed, and after a
// failure skips the seed entirely for a short backoff. Without a last-known
// value the read fails, as before.

import getLogger from "@cocalc/backend/logger";

const logger = getLogger("server:inter-bay:last-known-seed-read");

// Shared by all reads: once the seed fails to answer one of them, the others
// do not each wait for it again during the backoff.
let unavailableUntil = 0;

export interface LastKnownSeedReadOptions {
  /** Wait this long for the seed when there is no last-known value. */
  timeoutMs?: number;
  /** Wait this long for the seed when a last-known value exists. */
  fallbackTimeoutMs?: number;
  /** After a failure, serve the last-known value this long without asking. */
  backoffMs?: number;
}

export function lastKnownSeedRead<T>(
  name: string,
  {
    timeoutMs = 15_000,
    fallbackTimeoutMs = 3_000,
    backoffMs = 30_000,
  }: LastKnownSeedReadOptions = {},
) {
  const lastKnown = new Map<string, T>();

  const read = async (
    key: string,
    fetch: (timeout_ms: number) => Promise<T>,
  ): Promise<T> => {
    const known = lastKnown.has(key);
    if (known && Date.now() < unavailableUntil) {
      return lastKnown.get(key) as T;
    }
    try {
      const timeout_ms = known ? fallbackTimeoutMs : timeoutMs;
      const value = await withTimeout(fetch(timeout_ms), timeout_ms, name);
      lastKnown.set(key, value);
      unavailableUntil = 0;
      return value;
    } catch (err) {
      if (!known) throw err;
      unavailableUntil = Date.now() + backoffMs;
      logger.warn("seed unavailable; using the last-known value", {
        name,
        key,
        err: `${err}`,
      });
      return lastKnown.get(key) as T;
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
