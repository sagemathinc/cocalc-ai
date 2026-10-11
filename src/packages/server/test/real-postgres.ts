/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A throwaway real PostgreSQL for tests that need concurrent transactions
// (PGlite has a single connection). Uses the server binaries the CI image
// ships under /usr/lib/postgresql/*/bin; a test skips itself without them.
//
// Call startRealPostgres() in beforeAll BEFORE anything imports
// @cocalc/database/pool, then load modules with require/await import.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function postgresBinDir(): string | undefined {
  const root = "/usr/lib/postgresql";
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root)
    .filter((v) => existsSync(join(root, v, "bin", "initdb")))
    .sort((a, b) => Number(a) - Number(b));
  const latest = versions[versions.length - 1];
  return latest == null ? undefined : join(root, latest, "bin");
}

export interface RealPostgres {
  stop(): void;
}

export function startRealPostgres(
  database = "computers_concurrency_test",
): RealPostgres {
  const bin = postgresBinDir();
  if (bin == null) throw new Error("no PostgreSQL server binaries");
  const dir = mkdtempSync(join(tmpdir(), "cocalc-realpg-"));
  const data = join(dir, "data");
  const socket = join(dir, "socket");
  execFileSync("mkdir", ["-p", socket]);
  execFileSync(
    join(bin, "initdb"),
    ["-D", data, "-U", "cocalc", "--auth=trust", "-E", "UTF8"],
    {
      stdio: "ignore",
    },
  );
  execFileSync(
    join(bin, "pg_ctl"),
    [
      "-D",
      data,
      "-o",
      `-k ${socket} -c listen_addresses='' -c fsync=off -c max_connections=50`,
      "-w",
      "-l",
      join(dir, "log"),
      "start",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    join(bin, "createdb"),
    ["-h", socket, "-U", "cocalc", database],
    {
      stdio: "ignore",
    },
  );
  process.env.PGHOST = socket;
  process.env.PGUSER = "cocalc";
  process.env.PGDATABASE = database;
  process.env.COCALC_DB_SKIP_ENSURE_EXISTS = "1";
  delete process.env.COCALC_DB;
  delete process.env.COCALC_TEST_USE_PGLITE;
  return {
    stop() {
      spawnSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], {
        stdio: "ignore",
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Wait until n backends are blocked waiting for a lock. */
export async function waitForLockWaiters(
  query: (sql: string) => Promise<{ rows: any[] }>,
  n: number,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const { rows } = await query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock'",
    );
    if (rows[0].n >= n) return;
    if (Date.now() - start > timeoutMs) {
      const activity = await query(
        "SELECT state, wait_event_type, wait_event, left(query, 100) AS query FROM pg_stat_activity WHERE datname IS NOT NULL",
      );
      throw new Error(
        `only ${rows[0].n} of ${n} lock waiters: ${JSON.stringify(activity.rows)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
