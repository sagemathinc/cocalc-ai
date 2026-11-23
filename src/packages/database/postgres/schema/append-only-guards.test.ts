/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import { APPEND_ONLY_GUARDED_TABLES } from "./append-only-guards";
import { FEDERATED_MINT_LOG_TABLE } from "./federated-connector-mint-log";

const FLAG_NAMES = [
  "NODE_ENV",
  "JEST_WORKER_ID",
  "COCALC_TEST_MODE",
  "COCALC_TEST_RESET",
] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const name of FLAG_NAMES) saved[name] = process.env[name];
  await initEphemeralDatabase({});
}, 30_000);

afterAll(async () => {
  for (const name of FLAG_NAMES) {
    if (saved[name] == null) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await testCleanup();
});

// One fresh row per guarded table, so every refused statement has a target.
const INSERT: Record<string, () => Promise<void>> = {
  [FEDERATED_MINT_LOG_TABLE]: async () => {
    await getPool().query(
      `INSERT INTO federated_connector_mint_log
         (mint_id, time, outcome, reason, grant_id, grant_revision, lease_id, jti)
       VALUES ($1, NOW(), 'denied', 'revision', $2, 1, $3, $4)`,
      [uuid(), uuid(), uuid(), uuid()],
    );
  },
};

async function firstColumn(table: string): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position LIMIT 1`,
    [table],
  );
  return rows[0].column_name;
}

describe("append-only guarded tables", () => {
  it("the exported list is exactly the set of tables carrying a guard trigger", async () => {
    // A guard trigger: fires on TRUNCATE (tgtype bit 32), or its function
    // raises an append-only error.
    const { rows } = await getPool().query(
      `SELECT DISTINCT c.relname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND ((t.tgtype & 32) <> 0
               OR pg_get_functiondef(t.tgfoid) ILIKE '%append-only%')`,
    );
    expect(rows.map(({ relname }) => relname).sort()).toEqual(
      [...APPEND_ONLY_GUARDED_TABLES].sort(),
    );
    // pg_get_functiondef over every trigger, on a freshly synced database.
  }, 30_000);

  it("every listed table has a row inserter in this test", () => {
    for (const table of APPEND_ONLY_GUARDED_TABLES) {
      expect(INSERT[table]).toBeDefined();
    }
  });

  for (const mode of ["absent", "spoofed"] as const) {
    it(`the application role refuses TRUNCATE, UPDATE and DELETE with test flags ${mode}`, async () => {
      for (const name of FLAG_NAMES) delete process.env[name];
      if (mode === "spoofed") {
        process.env.NODE_ENV = "test";
        process.env.JEST_WORKER_ID = "1";
        process.env.COCALC_TEST_MODE = "true";
        process.env.COCALC_TEST_RESET = "1";
      }
      for (const table of APPEND_ONLY_GUARDED_TABLES) {
        await INSERT[table]();
        const { rows: before } = await getPool().query(
          `SELECT COUNT(*)::INT AS n FROM ${table}`,
        );
        const column = await firstColumn(table);
        for (const sql of [
          `TRUNCATE ${table}`,
          `UPDATE ${table} SET ${column}=${column}`,
          `DELETE FROM ${table}`,
        ]) {
          await expect(getPool().query(sql)).rejects.toThrow("append-only");
        }
        const { rows: after } = await getPool().query(
          `SELECT COUNT(*)::INT AS n FROM ${table}`,
        );
        expect(after[0].n).toBe(before[0].n);
      }
    });
  }
});
