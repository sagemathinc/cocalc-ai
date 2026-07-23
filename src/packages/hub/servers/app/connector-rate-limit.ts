// Fixed-window request counting for the self-host connector rate limiter.
// Extracted from self-host-connector.ts so it can be unit-tested without
// importing the server graph.
import type LRU from "lru-cache";

// Count a request against key and report whether it is within limit.
//
// The cache's ttl is the rate window. Passing noUpdateTTL is essential:
// lru-cache's set() refreshes the entry TTL by default, so a client polling
// faster than the window (the connector polls every ~10s against a 60s
// window) would keep its own window alive forever and the counter would
// grow monotonically until the client is permanently locked out
// (https://github.com/sagemathinc/cocalc-ai/issues/199). With noUpdateTTL
// the window expires relative to the first request in it, giving a true
// fixed window: at worst one window of 429s, then recovery.
export function checkAndRecordCount(
  cache: LRU<string, number>,
  key: string,
  limit: number,
): boolean {
  const next = (cache.get(key) ?? 0) + 1;
  cache.set(key, next, { noUpdateTTL: true });
  return next <= limit;
}
