/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { PglitePool } from "./pglite";

describe("PglitePool transaction isolation", () => {
  it("does not interleave unrelated pool queries into a client transaction", async () => {
    const pool = new PglitePool();
    const table = `pglite_tx_${Date.now()}`;
    try {
      await pool.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
      const client = await pool.connect();
      await client.query("BEGIN");
      await client.query(`INSERT INTO ${table} (id) VALUES (1)`);

      let poolQuerySettled = false;
      const poolQuery = pool
        .query(`INSERT INTO ${table} (id) VALUES (2)`)
        .finally(() => {
          poolQuerySettled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(poolQuerySettled).toBe(false);

      await client.query("COMMIT");
      client.release();
      await poolQuery;

      const { rows } = await pool.query(`SELECT id FROM ${table} ORDER BY id`);
      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      await pool.end();
    }
  });

  it("allows transaction-scoped helper pool queries while a client transaction is open", async () => {
    const pool = new PglitePool();
    const table = `pglite_tx_read_${Date.now()}`;
    try {
      await pool.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
      await pool.query(`INSERT INTO ${table} (id) VALUES (1)`);
      const client = await pool.connect();
      await client.query("BEGIN");
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${table}_id_idx ON ${table} (id)`,
      );
      await client.query(`INSERT INTO ${table} (id) VALUES (2)`);

      const { rows } = await pool.query(`SELECT id FROM ${table} ORDER BY id`);

      await client.query("COMMIT");
      client.release();
      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      await pool.end();
    }
  });
});
