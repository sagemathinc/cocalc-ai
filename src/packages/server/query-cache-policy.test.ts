/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// getCachedReadPool(cacheTime) serves query results from a per-process cache
// that can be up to that long out of date (see database/pool/cached.ts). A
// cached answer must never decide who may do what, or what someone may spend
// or use: a removed admin or collaborator, a revoked session or key would
// keep access, and limits and counters would lag. This keeps such code on
// the uncached getPool().
//
// In the paths below, any getCachedReadPool(...) call fails unless the call
// (or the line above it) says why caching is safe there with a
// "query-cache-ok: <reason>" comment. (getPool no longer takes a cache time;
// a non-object argument to it is flagged too, in case one comes back.)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PACKAGES = join(__dirname, "..");

// Code that makes authorization, entitlement, limit or spend decisions,
// relative to src/packages.
const PROTECTED = [
  "server/accounts",
  "server/ai",
  "server/api",
  "server/auth",
  "server/compute",
  "server/conat/api/compute.ts",
  "server/conat/project-local-access.ts",
  "server/conat/project-remote-access.ts",
  "server/email/throttle.ts",
  "server/hub",
  "server/membership",
  "server/project-host",
  "server/projects/is-collaborator.ts",
  "server/purchases",
  "server/rootfs/catalog.ts",
  "http-api/lib/share/get-collaborators.ts",
];

// Reporting and maintenance code in those directories, which only reads
// aggregates for display.
const REPORTING = new Set([
  "server/membership/allocation-analytics-series.ts",
  "server/membership/allocation-analytics.ts",
  "server/membership/analytics.ts",
  "server/membership/retention-overview.ts",
  "server/membership/rootfs-report.ts",
  "server/membership/usage-retention-maintenance.ts",
  "server/purchases/compute-revenue-analytics-series.ts",
  "server/purchases/test-data.ts",
]);

// A cached read pool, or getPool with a non-object argument (a cache time,
// a variable or an expression). \s also matches newlines, so a multi-line
// call is caught.
const CACHED_POOL = /\bgetCachedReadPool\(|\bgetPool\(\s*[^)\s{]/g;
const ALLOWED = "query-cache-ok:";

function sourceFiles(path: string): string[] {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat == null) return [];
  if (!stat.isDirectory()) return [path];
  return readdirSync(path).flatMap((name) =>
    name === "node_modules" || name === "dist"
      ? []
      : sourceFiles(join(path, name)),
  );
}

export function unannotatedCachedPools(source: string): number[] {
  const lines = source.split("\n");
  const offenders: number[] = [];
  // Scan the whole source: the argument may start on a later line.
  for (const match of source.matchAll(CACHED_POOL)) {
    const line = source.slice(0, match.index).split("\n").length;
    if (
      !lines[line - 1].includes(ALLOWED) &&
      !(lines[line - 2] ?? "").includes(ALLOWED)
    ) {
      offenders.push(line);
    }
  }
  return offenders;
}

describe("query cache policy", () => {
  it("keeps authorization, entitlement and spend checks off the query cache", () => {
    const offenders = PROTECTED.flatMap((path) =>
      sourceFiles(join(PACKAGES, path)),
    )
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => relative(PACKAGES, file))
      .filter((file) => !REPORTING.has(file))
      .flatMap((file) =>
        unannotatedCachedPools(readFileSync(join(PACKAGES, file), "utf8")).map(
          (line) => `${file}:${line}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("catches literal, conditional and variable cache times", () => {
    expect(unannotatedCachedPools('const pool = getPool("medium");')).toEqual([
      1,
    ]);
    expect(
      unannotatedCachedPools('const pool = getPool(noCache ? "" : "medium");'),
    ).toEqual([1]);
    expect(unannotatedCachedPools("const pool = getPool(cache);")).toEqual([1]);
    expect(unannotatedCachedPools("const pool = getPool();")).toEqual([]);
    expect(
      unannotatedCachedPools('const pool = getCachedReadPool("medium");'),
    ).toEqual([1]);
    expect(
      unannotatedCachedPools("getPool({ ensureExists: false }).end();"),
    ).toEqual([]);
    // Arguments on the next line, as prettier may format a longer call.
    expect(
      unannotatedCachedPools('x();\nconst pool = getPool(\n  "medium"\n);'),
    ).toEqual([2]);
    expect(
      unannotatedCachedPools("const pool = getPool(\n  cache,\n);"),
    ).toEqual([1]);
    expect(unannotatedCachedPools("const pool = getPool(\n);")).toEqual([]);
    expect(
      unannotatedCachedPools(
        '// query-cache-ok: display only\nconst pool = getPool("long");',
      ),
    ).toEqual([]);
  });
});
