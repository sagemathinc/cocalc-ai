/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { getFederatedMintLogGuardStatus } from "@cocalc/database/postgres/schema/federated-connector-mint-log";
import { uuid } from "@cocalc/util/misc";
// The package path, so this is the same module instance (and nonce) as the pool's.
import {
  assertDisposablePglite,
  assertDisposablePostgres,
  harnessNonce,
  NotDisposableError,
  readTestMarkers,
  TEST_DATABASE,
  TEST_MARKER_TABLE,
} from "@cocalc/database/pool/disposable-test-db";

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30_000);

afterAll(async () => {
  await testCleanup();
});

async function insertMint(): Promise<string> {
  const mint_id = uuid();
  await getPool().query(
    `INSERT INTO federated_connector_mint_log
       (mint_id, time, outcome, reason, grant_id, grant_revision, lease_id, jti)
     VALUES ($1, NOW(), 'denied', 'revision', $2, 1, $3, $4)`,
    [mint_id, uuid(), uuid(), uuid()],
  );
  return mint_id;
}

async function insertSetting(): Promise<string> {
  const name = `disposable-test-${uuid()}`;
  await getPool().query(
    "INSERT INTO server_settings (name, value) VALUES ($1, 'x')",
    [name],
  );
  return name;
}

async function rowCounts(): Promise<Record<string, number>> {
  const { rows } = await getPool().query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  );
  const counts: Record<string, number> = {};
  for (const { tablename } of rows) {
    const result = await getPool().query(
      `SELECT COUNT(*)::INT AS n FROM "${tablename}"`,
    );
    counts[tablename] = result.rows[0].n;
  }
  return counts;
}

function fakeDb(markers: string[] | null) {
  return {
    query: async (text: string) => {
      if (text.startsWith("SELECT to_regclass")) {
        return { rows: [{ present: markers != null }] };
      }
      return { rows: (markers ?? []).map((nonce) => ({ nonce })) };
    },
  };
}

describe("disposable test database reset", () => {
  it("reset leaves a truly empty database, guarded tables included, with the guards intact", async () => {
    // What a fresh database contains (schema sync may seed rows); the
    // database may hold rows from an earlier run, so reset once first.
    await initEphemeralDatabase({ reset: true });
    const fresh = await rowCounts();
    await insertMint();
    await insertSetting();
    expect((await rowCounts()).federated_connector_mint_log).toBe(
      fresh.federated_connector_mint_log + 1,
    );
    await initEphemeralDatabase({ reset: true });
    const after = await rowCounts();
    expect(after).toEqual(fresh);
    expect(after.federated_connector_mint_log).toBe(0);
    expect(await getFederatedMintLogGuardStatus(getPool())).toEqual({
      state: "ok",
    });
    expect(await readTestMarkers(getPool())).toEqual([harnessNonce()]);
  }, 60_000);

  for (const tamper of ["forged", "removed"] as const) {
    it(`refuses to reset when the harness marker is ${tamper}, even with test flags spoofed, and keeps the data`, async () => {
      const saved = {
        NODE_ENV: process.env.NODE_ENV,
        JEST_WORKER_ID: process.env.JEST_WORKER_ID,
        COCALC_TEST_MODE: process.env.COCALC_TEST_MODE,
      };
      process.env.NODE_ENV = "test";
      process.env.JEST_WORKER_ID = "1";
      process.env.COCALC_TEST_MODE = "true";
      const mint = await insertMint();
      await getPool().query(
        tamper === "forged"
          ? `UPDATE ${TEST_MARKER_TABLE} SET nonce='forged'`
          : `DELETE FROM ${TEST_MARKER_TABLE}`,
      );
      try {
        await expect(initEphemeralDatabase({ reset: true })).rejects.toThrow(
          NotDisposableError,
        );
        const { rows } = await getPool().query(
          "SELECT COUNT(*)::INT AS n FROM federated_connector_mint_log WHERE mint_id=$1",
          [mint],
        );
        expect(rows[0].n).toBe(1);
      } finally {
        await getPool().query(`DELETE FROM ${TEST_MARKER_TABLE}`);
        await getPool().query(
          `INSERT INTO ${TEST_MARKER_TABLE} (nonce) VALUES ($1)`,
          [harnessNonce()],
        );
        for (const [name, value] of Object.entries(saved)) {
          if (value == null) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }, 60_000);
  }

  it("the PGlite gate refuses a non-test database name, an on-disk data dir, or a foreign marker", async () => {
    const ok = fakeDb([harnessNonce()]);
    await expect(
      assertDisposablePglite({
        db: ok,
        pgdatabase: TEST_DATABASE,
        dataDir: "memory://",
      }),
    ).resolves.toBeUndefined();
    for (const args of [
      { db: ok, pgdatabase: "smc", dataDir: "memory://" },
      { db: ok, pgdatabase: undefined, dataDir: "memory://" },
      { db: ok, pgdatabase: TEST_DATABASE, dataDir: "/var/lib/pglite" },
      { db: fakeDb(null), pgdatabase: TEST_DATABASE, dataDir: "memory://" },
      { db: fakeDb([]), pgdatabase: TEST_DATABASE, dataDir: "memory://" },
      {
        db: fakeDb(["0".repeat(32)]),
        pgdatabase: TEST_DATABASE,
        dataDir: "memory://",
      },
      {
        db: fakeDb([harnessNonce(), harnessNonce()]),
        pgdatabase: TEST_DATABASE,
        dataDir: "memory://",
      },
    ]) {
      await expect(assertDisposablePglite(args)).rejects.toThrow(
        NotDisposableError,
      );
    }
  });

  it("the PostgreSQL gate refuses another database or one the harness did not create", async () => {
    const marker = "a".repeat(32);
    await expect(
      assertDisposablePostgres({
        db: fakeDb([marker]),
        pgdatabase: TEST_DATABASE,
        connectedDatabase: TEST_DATABASE,
      }),
    ).resolves.toBeUndefined();
    for (const args of [
      {
        db: fakeDb([marker]),
        pgdatabase: "smc",
        connectedDatabase: TEST_DATABASE,
      },
      {
        db: fakeDb([marker]),
        pgdatabase: TEST_DATABASE,
        connectedDatabase: "smc",
      },
      {
        db: fakeDb(null),
        pgdatabase: TEST_DATABASE,
        connectedDatabase: TEST_DATABASE,
      },
      {
        db: fakeDb(["forged"]),
        pgdatabase: TEST_DATABASE,
        connectedDatabase: TEST_DATABASE,
      },
    ]) {
      await expect(assertDisposablePostgres(args)).rejects.toThrow(
        NotDisposableError,
      );
    }
  });
});
