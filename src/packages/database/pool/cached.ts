/*
 *  This file is part of CoCalc: Copyright © 2021-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Caches queries for a certain amount of time.
Also, if there are multiple queries coming in
at the same time for the same thing, only
one actually goes to the database.

IMPORTANT: This *only* caches a query if the query actually
returns at least one row.  If the query returns nothing,
that fact is not cached.  This is usually what we want, e.g.,
if somebody access https://cocalc.ai/wstein/myproject, and
notices that myproject isn't the set name, then they may
set it and immediately try  https://cocalc.ai/wstein/myproject again.
In that case, we don't want to the cache to mean that they don't
see the page for a while. On the other hand, if querying for the
project that myproject resolves to is cached for a minute that is
fine, since this would only be a problem when they change the name
of multiple projects.

Only plain reads are cached: anything that writes, locks rows, or calls a
function with side effects goes straight to the database, uncached and never
merged with a concurrent identical call (see cacheable-query.ts). Outside
production, cached rows are frozen, since every caller shares them; each
caller gets its own rows array.

Do not use a cached pool for permission, membership, or billing checks: a
cached answer can be up to the cache time out of date in either direction.
*/

import LRU from "lru-cache";
import { Pool, type QueryResult } from "pg";
import getLogger from "@cocalc/backend/logger";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";

import { isCacheableQuery } from "./cacheable-query";
import getPool, { shouldSkipEnsureExists, type PoolOptionInput } from "./pool";

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

type PoolOptions = {
  cacheTime?: CacheTime;
  ensureExists?: boolean;
};

function normalizePoolOptions(opts?: PoolOptionInput): PoolOptions {
  if (typeof opts === "string") {
    return { cacheTime: opts };
  }
  return opts ?? {};
}

export default function getCachedPool(options?: PoolOptionInput) {
  const { cacheTime, ensureExists = !shouldSkipEnsureExists() } =
    normalizePoolOptions(options);
  if (!cacheTime) {
    return getPool({ ensureExists });
  }
  return {
    query: async (...args: Parameters<Pool["query"]>) => {
      if (!isCacheableQuery(args)) {
        return await getPool({ ensureExists }).query(
          ...(args as Parameters<Pool["query"]>),
        );
      }
      const result = await cachedQuery(cacheTime, ensureExists, ...args);
      // Each caller gets its own rows array (to sort, add to or remove
      // from); the rows themselves are shared.
      return { ...result, rows: [...result.rows] };
    },
  } as any as Pool; // obviously not really a Pool, but is enough for what we're doing.
}
