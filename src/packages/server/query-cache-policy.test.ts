/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// getPool("short" | "medium" | "long" | ...) serves query results from a
// per-process cache that can be up to that long out of date (see
// database/pool/cached.ts). A cached answer must never decide who may do
// what, or what someone may spend or use: an admin whose rights were removed,
// a removed collaborator or a revoked key would keep access, and limits and
// counters would lag. This keeps such code on the uncached getPool().

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Directories and files that make authorization, entitlement, limit or spend
// decisions.
const UNCACHED = [
  "accounts/admins.ts",
  "accounts/is-admin.ts",
  "accounts/is-in-group.ts",
  "accounts/stop-banned-projects.ts",
  "ai",
  "api",
  "auth",
  "compute",
  "conat/api/compute.ts",
  "conat/project-local-access.ts",
  "conat/project-remote-access.ts",
  "email/throttle.ts",
  "hub",
  "membership",
  "project-host",
  "projects/is-collaborator.ts",
  "purchases",
];

// Reporting and maintenance code in those directories, which only reads
// aggregates for display.
const REPORTING = new Set([
  "membership/allocation-analytics-series.ts",
  "membership/allocation-analytics.ts",
  "membership/analytics.ts",
  "membership/retention-overview.ts",
  "membership/rootfs-report.ts",
  "membership/usage-retention-maintenance.ts",
  "purchases/compute-revenue-analytics-series.ts",
  "purchases/test-data.ts",
]);

const CACHED_POOL = /getPool\(\s*["'](short|medium|long|minutes|infinite)["']/;

function sourceFiles(path: string): string[] {
  if (!statSync(path, { throwIfNoEntry: false })) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) =>
    name === "node_modules" || name === "dist"
      ? []
      : sourceFiles(join(path, name)),
  );
}

describe("query cache policy", () => {
  it("keeps authorization, entitlement and spend checks off the query cache", () => {
    const offenders = UNCACHED.flatMap((path) =>
      sourceFiles(join(__dirname, path)),
    )
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => relative(__dirname, file))
      .filter((file) => !REPORTING.has(file))
      .filter((file) =>
        CACHED_POOL.test(readFileSync(join(__dirname, file), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});
