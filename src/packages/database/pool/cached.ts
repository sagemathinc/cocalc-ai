/*
 *  This file is part of CoCalc: Copyright © 2021-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
getCachedReadPool(cacheTime): a per-process query-result cache for reads where
an answer up to cacheTime old is harmless (display, catalogs, analytics).
If several identical queries arrive at once, only one goes to the database.

Only plain reads are allowed: anything that writes, locks rows, or calls a
function not known to be read-only is a bug here (see cacheable-query.ts and
getCachedReadPool below). Outside production, cached rows are frozen, since
every caller shares them; each caller gets its own rows array.

IMPORTANT: a query is only cached if it returns at least one row; "nothing
found" is not cached. E.g. someone who visits https://cocalc.ai/wstein/myproject,
finds the name unset, sets it and tries again sees the page at once.

Never use it for permission, membership, entitlement or billing checks: a
cached answer can be up to the cache time out of date in either direction.
Use getPool() for those, and for anything that writes.
*/

import LRU from "lru-cache";
import { Pool, type QueryResult } from "pg";
import getLogger from "@cocalc/backend/logger";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";

import { isCacheableQuery } from "./cacheable-query";
import getPool, { shouldSkipEnsureExists } from "./pool";

const L = getLogger("db:pool:cached");

const MAX_AGE_S = {
  "": 0, // no cache at all
  short: 5, // just to avoid a very rapid fire sequence of re-requests
  medium: 15, // usually use this.
  long: 30,
  minutes: 10 * 60, // a really long time -- for now, 10 minutes.  example, the owner of a project.
  infinite: 60 * 60 * 24 * 365, // effectively forever; e.g., getting path from share id is really just a reversed sha1 hash, so can't change.
} as const;

export type CacheTime = keyof typeof MAX_AGE_S;

const caches = new Map<CacheTime, LRU<string, any>>();

for (const cacheTime in MAX_AGE_S) {
  if (!cacheTime) continue;
  caches[cacheTime] = new LRU<string, any>({
    max: 1000,
    ttl: 1000 * MAX_AGE_S[cacheTime],
  });
}

function deepFreeze<T>(value: T): T {
  if (
    value == null ||
    typeof value !== "object" ||
    Object.isFrozen(value) ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze((value as any)[key]);
  }
  return Object.freeze(value);
}

// Cached rows are shared by every caller; outside production freeze them so a
// caller that mutates one fails loudly instead of changing it for all.
const FREEZE_CACHED_RESULTS = process.env.NODE_ENV !== "production";

const cachedQuery = reuseInFlight(
  async (
    cacheTime: CacheTime,
    ensureExists: boolean,
    ...args: Parameters<Pool["query"]>
  ) => {
    const cache = caches[cacheTime];
    if (cache == null) {
      throw Error(`invalid cache "${cacheTime}"`);
    }
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      // console.log(`YES - using cache for ${key}`);
      return cache.get(key);
    }
    // console.log(`NOT using cache for ${key}`);

    const pool = getPool({ ensureExists });
    try {
      const result = (await pool.query(
        ...(args as Parameters<Pool["query"]>),
      )) as QueryResult | void;
      if (!result) {
        throw new Error("cachedQuery requires promise-based query");
      }
      if (result.rows.length > 0) {
        // We only cache query if it returned something.
        if (FREEZE_CACHED_RESULTS) {
          for (const row of result.rows) deepFreeze(row);
        }
        cache.set(key, result);
      }
      return result;
    } catch (err) {
      L.error(`cachedQuery error: ${err}`);
      throw err;
    }
  },
);

/** Reads served from a per-process query-result cache. */
export interface CachedReadPool {
  // pg's own signature, so it fits wherever a query-only Pool is expected;
  // only the promise forms are supported.
  query: Pool["query"];
}

const STRICT = process.env.NODE_ENV !== "production";
const warned = new Set<string>();

/**
 * A pool whose query() serves plain reads from a cache that may be up to
 * `cacheTime` out of date. Use it only where a stale answer is harmless
 * (display, catalogs, analytics), never for access, entitlement or spend
 * checks (server/query-cache-policy.test.ts enforces that for those paths).
 *
 * A query that is not a plain read (see cacheable-query.ts) is a bug here:
 * it throws outside production, and in production runs uncached and logs.
 */
export function getCachedReadPool(
  cacheTime: CacheTime,
  { ensureExists = !shouldSkipEnsureExists() }: { ensureExists?: boolean } = {},
): CachedReadPool {
  if (!cacheTime || caches[cacheTime] == null) {
    throw Error(`invalid cache "${cacheTime}"`);
  }
  return {
    query: async (...args: any[]) => {
      if (!isCacheableQuery(args)) {
        const text = `${typeof args[0] === "string" ? args[0] : args[0]?.text}`
          .replace(/\s+/g, " ")
          .slice(0, 200);
        if (STRICT) {
          throw Error(`getCachedReadPool: not a plain read: ${text}`);
        }
        if (!warned.has(text)) {
          warned.add(text);
          L.warn("getCachedReadPool: not a plain read; running uncached", {
            text,
          });
        }
        return await getPool({ ensureExists }).query(
          ...(args as Parameters<Pool["query"]>),
        );
      }
      const result = await cachedQuery(
        cacheTime,
        ensureExists,
        ...(args as Parameters<Pool["query"]>),
      );
      // Each caller gets its own rows array (to sort, add to or remove
      // from); the rows themselves are shared.
      return { ...result, rows: [...result.rows] };
    },
  } as unknown as CachedReadPool;
}
