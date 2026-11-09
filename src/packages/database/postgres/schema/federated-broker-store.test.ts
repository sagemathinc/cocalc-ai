/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A broker-local store in its own in-memory Postgres, with the real roles.

import { PGlite } from "@electric-sql/pglite";
import {
  BROKER_STORE_RECORD_MINT_SQL,
  getBrokerStoreStatus,
  migrateBrokerStore,
  purgeBrokerMintLog,
  type BrokerStoreDb,
} from "./federated-broker-store";

let pg: PGlite;
const db: BrokerStoreDb = {
  query: async (sql, params) =>
    (await pg.query(sql, params as any[])) as { rows: any[] },
};
const as = async (role: string | null) =>
  await pg.exec(role == null ? "RESET ROLE" : `SET ROLE ${role}`);

const U = (n: number) => `00000000-0000-4000-8000-${`${n}`.padStart(12, "0")}`;
const MINT = [
  "denied",
  "revision",
  U(1),
  U(2),
  U(3),
  U(4),
  U(5),
  U(6),
  U(7),
  U(8),
  1,
  U(9),
  U(10),
  null,
  "reader-sa@example-project-1.iam.gserviceaccount.com",
  null,
  null,
];

async function record(): Promise<string> {
  await db.query(BROKER_STORE_RECORD_MINT_SQL, MINT);
  const { rows } = await db.query(
    "SELECT mint_id FROM broker.federated_connector_mint_log ORDER BY time DESC LIMIT 1",
  );
  return rows[0].mint_id;
}

// Test-only: backdate a row, as the superuser with the guard disabled.
async function backdate(mint_id: string, interval: string) {
  await as(null);
  const t = "broker.federated_connector_mint_log";
  await pg.exec(
    `ALTER TABLE ${t} DISABLE TRIGGER federated_connector_mint_log_append_only`,
  );
  await pg.query(
    `UPDATE ${t} SET time = NOW() - INTERVAL '${interval}' WHERE mint_id=$1`,
    [mint_id],
  );
  await pg.exec(
    `ALTER TABLE ${t} ENABLE ALWAYS TRIGGER federated_connector_mint_log_append_only`,
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE ROLE broker_migrate;
    CREATE ROLE broker_app;
    CREATE SCHEMA broker AUTHORIZATION broker_migrate;
  `);
  await as("broker_migrate");
  await migrateBrokerStore(db);
  await as(null);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

afterEach(async () => {
  await as(null);
});

describe("the broker store", () => {
  it("refuses to migrate as any role but broker_migrate", async () => {
    await expect(migrateBrokerStore(db)).rejects.toThrow(
      "must run as broker_migrate",
    );
    await as("broker_app");
    await expect(migrateBrokerStore(db)).rejects.toThrow(
      "must run as broker_migrate",
    );
  });

  it("refuses a schema not owned by broker_migrate", async () => {
    await pg.exec("ALTER SCHEMA broker OWNER TO broker_app");
    try {
      await as("broker_migrate");
      await expect(migrateBrokerStore(db)).rejects.toThrow(
        "must exist, owned by broker_migrate",
      );
    } finally {
      await as(null);
      await pg.exec("ALTER SCHEMA broker OWNER TO broker_migrate");
    }
  });

  it("refuses an app role that is a member of the owner", async () => {
    await pg.exec("GRANT broker_migrate TO broker_app");
    try {
      await as("broker_migrate");
      await expect(migrateBrokerStore(db)).rejects.toThrow(
        "must not be a member",
      );
    } finally {
      await as(null);
      await pg.exec("REVOKE broker_migrate FROM broker_app");
    }
  });

  it("migrates again idempotently, and reports ok", async () => {
    await as("broker_migrate");
    await migrateBrokerStore(db);
    await as(null);
    expect(await getBrokerStoreStatus(db)).toEqual({ state: "ok" });
  });

  it("lets broker_app insert (with the database's time) and select", async () => {
    await as("broker_app");
    const id = await record();
    const { rows } = await db.query(
      "SELECT outcome, time > NOW() - INTERVAL '1 minute' AS fresh FROM broker.federated_connector_mint_log WHERE mint_id=$1",
      [id],
    );
    expect(rows[0]).toEqual({ outcome: "denied", fresh: true });
  });

  it("refuses broker_app every change: UPDATE, DELETE, TRUNCATE, DISABLE TRIGGER, ALTER, DROP", async () => {
    await as("broker_app");
    const id = await record();
    for (const sql of [
      `UPDATE broker.federated_connector_mint_log SET reason='x' WHERE mint_id='${id}'`,
      `DELETE FROM broker.federated_connector_mint_log WHERE mint_id='${id}'`,
      "TRUNCATE broker.federated_connector_mint_log",
      "ALTER TABLE broker.federated_connector_mint_log DISABLE TRIGGER ALL",
      "ALTER TABLE broker.federated_connector_mint_log DISABLE TRIGGER federated_connector_mint_log_append_only",
      "ALTER TABLE broker.federated_connector_mint_log DROP COLUMN reason",
      "DROP TABLE broker.federated_connector_mint_log",
      "INSERT INTO broker.broker_purge_log (time, deleted) VALUES (NOW(), 0)",
      "UPDATE broker.broker_purge_log SET deleted = 0",
      "DELETE FROM broker.broker_purge_log",
      "TRUNCATE broker.broker_purge_log",
      "ALTER TABLE broker.broker_purge_log DISABLE TRIGGER ALL",
      "CREATE OR REPLACE FUNCTION broker.broker_purge_mint_log() RETURNS INTEGER AS 'SELECT 0' LANGUAGE sql",
    ]) {
      await expect(pg.exec(sql)).rejects.toThrow();
    }
  });

  it("refuses even the owner an UPDATE, TRUNCATE, or DELETE of a recent row", async () => {
    await as("broker_app");
    const id = await record();
    await as("broker_migrate");
    for (const sql of [
      `UPDATE broker.federated_connector_mint_log SET reason='x' WHERE mint_id='${id}'`,
      `DELETE FROM broker.federated_connector_mint_log WHERE mint_id='${id}'`,
      "TRUNCATE broker.federated_connector_mint_log",
      "TRUNCATE broker.broker_purge_log",
    ]) {
      await expect(pg.exec(sql)).rejects.toThrow("append-only");
    }
  });

  it("purges, as broker_app, only rows past the retention period, and logs the count", async () => {
    await as("broker_app");
    const old = await record();
    const recent = await record();
    const borderline = await record();
    await backdate(old, "14 months");
    await backdate(borderline, "12 months");
    await as("broker_app");
    expect(await purgeBrokerMintLog(db)).toBe(1);
    const { rows } = await db.query(
      "SELECT mint_id FROM broker.federated_connector_mint_log WHERE mint_id = ANY($1::uuid[])",
      [[old, recent, borderline]],
    );
    expect(rows.map((r) => r.mint_id).sort()).toEqual(
      [recent, borderline].sort(),
    );
    const log = await db.query(
      "SELECT deleted FROM broker.broker_purge_log ORDER BY purge_id DESC LIMIT 1",
    );
    expect(log.rows[0].deleted).toBe(1);
  });

  it("reports a disabled guard", async () => {
    await as("broker_migrate");
    await pg.exec(
      "ALTER TABLE broker.broker_purge_log DISABLE TRIGGER broker_purge_log_no_truncate",
    );
    try {
      expect(await getBrokerStoreStatus(db)).toEqual({ state: "disabled" });
    } finally {
      await pg.exec(
        "ALTER TABLE broker.broker_purge_log ENABLE ALWAYS TRIGGER broker_purge_log_no_truncate",
      );
    }
    expect(await getBrokerStoreStatus(db)).toEqual({ state: "ok" });
  });

  it("reports privileges on any drift of grants, membership, ownership, SECURITY DEFINER or search_path", async () => {
    expect(await getBrokerStoreStatus(db)).toEqual({ state: "ok" });
    for (const [grant, revoke] of [
      [
        "GRANT DELETE ON broker.federated_connector_mint_log TO broker_app",
        "REVOKE DELETE ON broker.federated_connector_mint_log FROM broker_app",
      ],
      [
        "GRANT UPDATE ON broker.broker_purge_log TO broker_app",
        "REVOKE UPDATE ON broker.broker_purge_log FROM broker_app",
      ],
      [
        "GRANT TRUNCATE ON broker.federated_connector_mint_log TO broker_app",
        "REVOKE TRUNCATE ON broker.federated_connector_mint_log FROM broker_app",
      ],
      [
        "GRANT broker_migrate TO broker_app",
        "REVOKE broker_migrate FROM broker_app",
      ],
      ["ALTER ROLE broker_app BYPASSRLS", "ALTER ROLE broker_app NOBYPASSRLS"],
      [
        "ALTER TABLE broker.broker_purge_log OWNER TO broker_app",
        // Ownership moves the table's grants: restore broker_app's SELECT.
        "ALTER TABLE broker.broker_purge_log OWNER TO broker_migrate; GRANT SELECT ON broker.broker_purge_log TO broker_app",
      ],
      [
        "ALTER SCHEMA broker OWNER TO broker_app",
        // Ownership moves the schema's grants: restore broker_app's usage.
        "ALTER SCHEMA broker OWNER TO broker_migrate; GRANT USAGE ON SCHEMA broker TO broker_app",
      ],
      [
        "ALTER FUNCTION broker.broker_purge_mint_log() RESET search_path",
        "ALTER FUNCTION broker.broker_purge_mint_log() SET search_path = pg_catalog",
      ],
      [
        "ALTER FUNCTION broker.broker_purge_mint_log() SECURITY INVOKER",
        "ALTER FUNCTION broker.broker_purge_mint_log() SECURITY DEFINER",
      ],
      [
        "ALTER FUNCTION broker.broker_append_only_guard() SET search_path = public",
        "ALTER FUNCTION broker.broker_append_only_guard() SET search_path = pg_catalog",
      ],
      [
        "ALTER FUNCTION broker.broker_append_only_guard() OWNER TO broker_app",
        "ALTER FUNCTION broker.broker_append_only_guard() OWNER TO broker_migrate",
      ],
      [
        "GRANT INSERT ON broker.broker_purge_log TO broker_app",
        "REVOKE INSERT ON broker.broker_purge_log FROM broker_app",
      ],
      [
        "REVOKE EXECUTE ON FUNCTION broker.broker_purge_mint_log() FROM broker_app",
        "GRANT EXECUTE ON FUNCTION broker.broker_purge_mint_log() TO broker_app",
      ],
      [
        "REVOKE INSERT ON broker.federated_connector_mint_log FROM broker_app",
        "GRANT INSERT ON broker.federated_connector_mint_log TO broker_app",
      ],
      // @review R6: the exact boundary.
      [
        "GRANT CREATE ON SCHEMA broker TO broker_app",
        "REVOKE CREATE ON SCHEMA broker FROM broker_app",
      ],
      [
        "GRANT TRIGGER ON broker.federated_connector_mint_log TO broker_app",
        "REVOKE TRIGGER ON broker.federated_connector_mint_log FROM broker_app",
      ],
      [
        "GRANT TRIGGER ON broker.broker_purge_log TO broker_app",
        "REVOKE TRIGGER ON broker.broker_purge_log FROM broker_app",
      ],
      [
        "ALTER ROLE broker_app CREATEROLE",
        "ALTER ROLE broker_app NOCREATEROLE",
      ],
      ["ALTER ROLE broker_app CREATEDB", "ALTER ROLE broker_app NOCREATEDB"],
      [
        "ALTER ROLE broker_app REPLICATION",
        "ALTER ROLE broker_app NOREPLICATION",
      ],
      // @vanta: a column-level grant isn't in the table ACL.
      [
        "GRANT UPDATE (reason) ON broker.federated_connector_mint_log TO broker_app",
        "REVOKE UPDATE (reason) ON broker.federated_connector_mint_log FROM broker_app",
      ],
      [
        "GRANT SELECT (deleted) ON broker.broker_purge_log TO PUBLIC",
        "REVOKE SELECT (deleted) ON broker.broker_purge_log FROM PUBLIC",
      ],
      [
        "GRANT INSERT ON broker.federated_connector_mint_log TO PUBLIC",
        "REVOKE INSERT ON broker.federated_connector_mint_log FROM PUBLIC",
      ],
      [
        "GRANT SELECT ON broker.broker_purge_log TO PUBLIC",
        "REVOKE SELECT ON broker.broker_purge_log FROM PUBLIC",
      ],
      [
        "GRANT EXECUTE ON FUNCTION broker.broker_purge_mint_log() TO PUBLIC",
        "REVOKE EXECUTE ON FUNCTION broker.broker_purge_mint_log() FROM PUBLIC",
      ],
      [
        "GRANT EXECUTE ON FUNCTION broker.broker_append_only_guard() TO broker_app",
        "REVOKE EXECUTE ON FUNCTION broker.broker_append_only_guard() FROM broker_app",
      ],
      [
        "GRANT USAGE ON SCHEMA broker TO PUBLIC",
        "REVOKE USAGE ON SCHEMA broker FROM PUBLIC",
      ],
      [
        "CREATE ROLE other_role; GRANT SELECT ON broker.federated_connector_mint_log TO other_role",
        "REVOKE SELECT ON broker.federated_connector_mint_log FROM other_role; DROP ROLE other_role",
      ],
    ]) {
      await as(null);
      await pg.exec(grant);
      try {
        // As the broker reads it.
        await as("broker_app");
        expect(await getBrokerStoreStatus(db)).toEqual({ state: "privileges" });
      } finally {
        await as(null);
        await pg.exec(revoke);
      }
    }
    await as("broker_app");
    expect(await getBrokerStoreStatus(db)).toEqual({ state: "ok" });
  });

  it("matches guards by exact name and table: an extra trigger doesn't stand in for a missing one", async () => {
    await as(null);
    await pg.exec(`
      ALTER TABLE broker.broker_purge_log DISABLE TRIGGER broker_purge_log_insert_time;
      ALTER TABLE broker.broker_purge_log RENAME TO broker_purge_log_tmp;
    `);
    try {
      expect(await getBrokerStoreStatus(db)).toEqual({ state: "missing" });
    } finally {
      await pg.exec(`
        ALTER TABLE broker.broker_purge_log_tmp RENAME TO broker_purge_log;
        ALTER TABLE broker.broker_purge_log ENABLE ALWAYS TRIGGER broker_purge_log_insert_time;
      `);
    }
    await pg.exec(`
      CREATE FUNCTION broker.extra_guard() RETURNS TRIGGER AS 'BEGIN RETURN NEW; END' LANGUAGE plpgsql;
      CREATE TRIGGER extra_one BEFORE INSERT ON broker.federated_connector_mint_log
        FOR EACH ROW EXECUTE FUNCTION broker.extra_guard();
      DROP TRIGGER broker_purge_log_no_truncate ON broker.broker_purge_log;
    `);
    try {
      expect(await getBrokerStoreStatus(db)).toEqual({ state: "missing" });
    } finally {
      await pg.exec(`
        DROP TRIGGER extra_one ON broker.federated_connector_mint_log;
        DROP FUNCTION broker.extra_guard();
        SET ROLE broker_migrate;
      `);
      await migrateBrokerStore(db);
      await as(null);
    }
    expect(await getBrokerStoreStatus(db)).toEqual({ state: "ok" });
  });

  it("@review's combined exploit: a broker_app trigger rewriting rows is refused, even after the grants are revoked", async () => {
    await as(null);
    await pg.exec(`
      GRANT CREATE ON SCHEMA broker TO broker_app;
      GRANT TRIGGER ON broker.federated_connector_mint_log TO broker_app;
    `);
    await as("broker_app");
    await pg.exec(`
      CREATE FUNCTION broker.rewrite() RETURNS TRIGGER AS
        'BEGIN NEW.reason := ''forged''; RETURN NEW; END' LANGUAGE plpgsql;
      CREATE TRIGGER a_rewrite BEFORE INSERT ON broker.federated_connector_mint_log
        FOR EACH ROW EXECUTE FUNCTION broker.rewrite();
    `);
    const id = await record();
    const { rows } = await db.query(
      "SELECT reason FROM broker.federated_connector_mint_log WHERE mint_id=$1",
      [id],
    );
    expect(rows[0].reason).toBe("forged"); // the exploit works ...
    expect((await getBrokerStoreStatus(db)).state).not.toBe("ok"); // ... and is seen
    await as(null);
    await pg.exec(`
      REVOKE CREATE ON SCHEMA broker FROM broker_app;
      REVOKE TRIGGER ON broker.federated_connector_mint_log FROM broker_app;
    `);
    // The grants are gone but the trigger stays: still not ok.
    expect(await getBrokerStoreStatus(db)).toEqual({
      state: "unexpected_trigger",
    });
    await pg.exec(`
      DROP TRIGGER a_rewrite ON broker.federated_connector_mint_log;
      DROP FUNCTION broker.rewrite();
    `);
    expect(await getBrokerStoreStatus(db)).toEqual({ state: "ok" });
  });
});
