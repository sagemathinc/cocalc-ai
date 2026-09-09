/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import LRU from "lru-cache";

const POSITIVE_TTL_MS = 60 * 60_000;
const NEGATIVE_TTL_MS = 30_000;
export const PUBLIC_BLOB_MAX_CONCURRENT_PROBES = 32;

const availability = new LRU<string, boolean>({ max: 50_000 });
const inFlight = new Map<string, Promise<boolean>>();
let activeProbeCount = 0;

async function probe(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return false;
    }
    const response = await fetch(parsed.href, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    return (
      response.status === 200 &&
      response.headers.get("content-type")?.startsWith("image/") === true
    );
  } catch {
    return false;
  }
}

/** Legacy URLs must still serve PostgreSQL-only images during the backfill. */
export async function isPublicBlobAvailable(url: string): Promise<boolean> {
  const cached = availability.get(url);
  if (cached != null) return cached;
  const pending = inFlight.get(url);
  if (pending) return await pending;

  // This endpoint is public. Under random-UUID traffic, prefer the existing
  // PostgreSQL fallback over creating an unbounded number of outbound probes.
  if (activeProbeCount >= PUBLIC_BLOB_MAX_CONCURRENT_PROBES) return false;

  activeProbeCount++;
  const request = probe(url)
    .then((available) => {
      availability.set(url, available, {
        ttl: available ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS,
      });
      return available;
    })
    .finally(() => {
      activeProbeCount--;
      inFlight.delete(url);
    });
  inFlight.set(url, request);
  return await request;
}

export function resetPublicBlobAvailabilityForTests(): void {
  availability.clear();
  inFlight.clear();
  activeProbeCount = 0;
}
