/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The test harness resets the ephemeral test database by throwing it away and
creating a new one (a fresh in-memory PGlite instance, or DROP/CREATE DATABASE
on PostgreSQL), never by deleting rows through the application's SQL path.
Guarded tables such as the append-only federated mint log keep their triggers
unchanged and are emptied because the whole database is new.

A reset is refused unless the target is provably the harness's own disposable
database:
- PGDATABASE is exactly the test database name, and
- the database carries the marker row the harness wrote when it created it
  (schema cocalc_test_harness, outside the application's public schema), and
- PGlite: the data directory is in memory, and the marker nonce equals the one
  this process generated (an in-memory instance cannot outlive its process).
  PostgreSQL: the marker must exist; it is written only right after the
  harness itself ran CREATE DATABASE, so a database the harness did not create
  is never dropped.
Environment strings such as NODE_ENV or JEST_WORKER_ID are not part of the
gate.
*/

import { randomBytes } from "node:crypto";

export const TEST_DATABASE = "smc_ephemeral_testing_database";
export const TEST_MARKER_SCHEMA = "cocalc_test_harness";
export const TEST_MARKER_TABLE = `${TEST_MARKER_SCHEMA}.disposable_marker`;

type Queryable = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
};

// Generated once per process; only this process's in-memory PGlite instance
// can carry it.
const processNonce = randomBytes(16).toString("hex");

export function harnessNonce(): string {
  return processNonce;
}

export async function writeTestMarker(db: Queryable): Promise<void> {
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_MARKER_SCHEMA}`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${TEST_MARKER_TABLE} (nonce TEXT NOT NULL)`,
  );
  await db.query(`INSERT INTO ${TEST_MARKER_TABLE} (nonce) VALUES ($1)`, [
    processNonce,
  ]);
}

export async function readTestMarkers(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [TEST_MARKER_TABLE],
  );
  if (!rows[0]?.present) {
    return [];
  }
  const result = await db.query(`SELECT nonce FROM ${TEST_MARKER_TABLE}`);
  return result.rows.map(({ nonce }) => nonce);
}

export class NotDisposableError extends Error {
  constructor(reason: string) {
    super(`refusing to reset a database that is not disposable: ${reason}`);
    this.name = "NotDisposableError";
  }
}

export async function assertDisposablePglite({
  db,
  pgdatabase,
  dataDir,
}: {
  db: Queryable;
  pgdatabase: string | undefined;
  dataDir: string;
}): Promise<void> {
  if (pgdatabase !== TEST_DATABASE) {
    throw new NotDisposableError(`PGDATABASE is not ${TEST_DATABASE}`);
  }
  if (!dataDir.startsWith("memory://")) {
    throw new NotDisposableError("PGlite data directory is not in memory");
  }
  const markers = await readTestMarkers(db);
  if (markers.length !== 1 || markers[0] !== processNonce) {
    throw new NotDisposableError(
      "harness marker missing or not this process's",
    );
  }
}

export async function assertDisposablePostgres({
  db,
  pgdatabase,
  connectedDatabase,
}: {
  db: Queryable;
  pgdatabase: string | undefined;
  connectedDatabase: string | undefined;
}): Promise<void> {
  if (pgdatabase !== TEST_DATABASE || connectedDatabase !== TEST_DATABASE) {
    throw new NotDisposableError(`database is not ${TEST_DATABASE}`);
  }
  const markers = await readTestMarkers(db);
  if (markers.length !== 1 || !/^[0-9a-f]{32}$/.test(markers[0])) {
    throw new NotDisposableError(
      `no harness marker; the harness did not create this database (drop ${TEST_DATABASE} once by hand)`,
    );
  }
}
