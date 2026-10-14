/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

// Opt-in real PostgreSQL test (PGlite has a single connection): a watcher
// delete racing the scheduler issuing that watcher's wake, with the exact SQL
// of both sides on two connections.
const database = process.env.COCALC_TEST_MANAGED_POSTGRES_DB;
const describePostgres = database ? describe : describe.skip;
const schema = `sensor_race_${randomUUID().replaceAll("-", "")}`;
let pool: Pool;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => pool,
}));

import { WATCHER_DELETE_GUARD } from "./sensors";
import { ISSUE_HOLD_SQL } from "./sensor-scheduler";

const DELETE_SQL = `DELETE FROM agent_sensors WHERE sensor_id=$1 AND ${WATCHER_DELETE_GUARD}
  RETURNING sensor_id`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describePostgres("watcher delete vs wake issuance (PostgreSQL)", () => {
  beforeAll(async () => {
    const admin = new Pool({ database });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
    } finally {
      await admin.end();
    }
    pool = new Pool({
      database,
      max: 4,
      options: `-c search_path=${schema} -c statement_timeout=15000`,
    });
    // Only the columns both statements use.
    await pool.query(`CREATE TABLE agent_sensors (
      sensor_id uuid PRIMARY KEY, spec jsonb, lease_id uuid,
      lease_until timestamptz)`);
    await pool.query(`CREATE TABLE agent_sensor_runs (
      run_id uuid PRIMARY KEY,
      sensor_id uuid REFERENCES agent_sensors(sensor_id) ON DELETE CASCADE,
      wake_state text, started_at timestamptz NOT NULL DEFAULT now())`);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  // A claimed watcher whose lease ends in `leaseMs`, with its current run.
  async function claimed(leaseMs: number) {
    const sensor_id = randomUUID();
    const lease_id = randomUUID();
    await pool.query(
      `INSERT INTO agent_sensors (sensor_id, spec, lease_id, lease_until)
       VALUES ($1, '{"kind":"watch"}', $2, now() + make_interval(secs => $3))`,
      [sensor_id, lease_id, leaseMs / 1000],
    );
    await pool.query(
      "INSERT INTO agent_sensor_runs (run_id, sensor_id) VALUES ($1, $2)",
      [lease_id, sensor_id],
    );
    return { sensor_id, lease_id };
  }

  // Issuer holds its transaction open after `hold`; the lease (as committed)
  // then runs out, so a delete passes the guard on the old row and waits
  // for the issuer's row lock. The issuer then marks the wake issued and
  // commits; the result is what the waiting delete did.
  async function race(hold: (c: PoolClient, s: any) => Promise<number>) {
    const s = await claimed(400);
    const issuer = await pool.connect();
    try {
      await issuer.query("BEGIN");
      expect(await hold(issuer, s)).toBe(1);
      await sleep(800); // the originally committed lease has now expired
      let settled = false;
      const deleting = pool
        .query(DELETE_SQL, [s.sensor_id])
        .finally(() => (settled = true));
      await sleep(300);
      expect(settled).toBe(false); // waiting for the issuer's row lock
      await issuer.query(
        "UPDATE agent_sensor_runs SET wake_state='issued' WHERE run_id=$1",
        [s.lease_id],
      );
      await issuer.query("COMMIT");
      const deleted = (await deleting).rows.length;
      const { rows } = await pool.query(
        "SELECT wake_state FROM agent_sensor_runs WHERE run_id=$1",
        [s.lease_id],
      );
      return { deleted, run: rows[0] };
    } finally {
      issuer.release();
    }
  }

  test("a delete waiting behind issuance re-checks the renewed lease and refuses", async () => {
    const result = await race(
      async (c, s) =>
        (await c.query(ISSUE_HOLD_SQL, [s.sensor_id, s.lease_id])).rows.length,
    );
    expect(result).toEqual({ deleted: 0, run: { wake_state: "issued" } });
  });

  test("control: only locking the row lets the waiting delete cascade the issued run away", async () => {
    const result = await race(
      async (c, s) =>
        (
          await c.query(
            "SELECT sensor_id FROM agent_sensors WHERE sensor_id=$1 AND lease_id=$2 FOR UPDATE",
            [s.sensor_id, s.lease_id],
          )
        ).rows.length,
    );
    expect(result).toEqual({ deleted: 1, run: undefined });
  });

  test("a run whose lease ran out cannot issue", async () => {
    const s = await claimed(-1000);
    const { rows } = await pool.query(ISSUE_HOLD_SQL, [
      s.sensor_id,
      s.lease_id,
    ]);
    expect(rows).toEqual([]);
  });

  test("a live lease blocks the delete outright", async () => {
    const s = await claimed(60_000);
    expect((await pool.query(DELETE_SQL, [s.sensor_id])).rows).toEqual([]);
  });
});
