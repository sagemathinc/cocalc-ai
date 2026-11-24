/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Client } from "pg";
import getPool, {
  initEphemeralDatabase,
  isPgliteEnabled,
} from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { getFederatedMintLogGuardStatus } from "@cocalc/database/postgres/schema/federated-connector-mint-log";
import { uuid } from "@cocalc/util/misc";
// The package path, so this is the same module instance (and nonce) as the pool's.
import {
  assertDisposablePglite,
  assertDisposablePostgres,
  assertMaintenanceSession,
  harnessNonce,
  MAINTENANCE_DATABASE,
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

function fakeDb(
  markers: string[] | null,
  // null = the server returned no name (undefined would select the default)
  currentDatabase: string | null = TEST_DATABASE,
) {
  // Every query the gate sends, in order.
  const log: string[] = [];
  return {
    log,
    query: async (text: string) => {
      log.push(text);
      if (text.startsWith("SELECT current_database()")) {
        return { rows: [{ name: currentDatabase }] };
      }
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
      }),
    ).resolves.toBeUndefined();
    for (const args of [
      { db: fakeDb([marker]), pgdatabase: "smc" },
      { db: fakeDb([marker]), pgdatabase: undefined },
      { db: fakeDb([marker], "smc"), pgdatabase: TEST_DATABASE },
      { db: fakeDb([marker], null), pgdatabase: TEST_DATABASE },
      { db: fakeDb(null), pgdatabase: TEST_DATABASE },
      { db: fakeDb(["forged"]), pgdatabase: TEST_DATABASE },
    ]) {
      await expect(assertDisposablePostgres(args)).rejects.toThrow(
        NotDisposableError,
      );
    }
  });

  it("the PostgreSQL gate takes the database name from the server, not from the caller, and a refusal changes nothing", async () => {
    // The test database's state before the refused check: a sentinel row and
    // the harness marker.
    const sentinel = await insertMint();
    const markersBefore = await readTestMarkers(getPool());
    expect(markersBefore).toHaveLength(1);
    if (isPgliteEnabled()) {
      // PGlite's session is not in the test database, so the query-backed
      // check refuses even though PGDATABASE and the marker (this process's
      // nonce) are both right.
      const { rows } = await getPool().query(
        "SELECT current_database() AS name",
      );
      expect(rows[0].name).not.toBe(TEST_DATABASE);
      await expect(
        assertDisposablePostgres({ db: getPool(), pgdatabase: TEST_DATABASE }),
      ).rejects.toThrow(`connected database is not ${TEST_DATABASE}`);
    } else {
      // Real PostgreSQL: a session on the test database passes; a session on
      // another database is refused by the server-derived name.
      for (const [database, ok] of [
        [TEST_DATABASE, true],
        ["smc", false],
      ] as const) {
        const client = new Client({ database });
        await client.connect();
        try {
          const check = assertDisposablePostgres({
            db: client,
            pgdatabase: TEST_DATABASE,
          });
          if (ok) {
            await expect(check).resolves.toBeUndefined();
          } else {
            await expect(check).rejects.toThrow(
              `connected database is not ${TEST_DATABASE}`,
            );
          }
        } finally {
          await client.end();
        }
      }
    }
    // The test database is unchanged: same marker, sentinel still there.
    expect(await readTestMarkers(getPool())).toEqual(markersBefore);
    const { rows } = await getPool().query(
      "SELECT COUNT(*)::INT AS n FROM federated_connector_mint_log WHERE mint_id=$1",
      [sentinel],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a wrong server identity is refused before any marker query", async () => {
    for (const name of ["smc", null]) {
      const db = fakeDb(["a".repeat(32)], name);
      await expect(
        assertDisposablePostgres({ db, pgdatabase: TEST_DATABASE }),
      ).rejects.toThrow(`connected database is not ${TEST_DATABASE}`);
      expect(db.log).toEqual(["SELECT current_database() AS name"]);
    }
    // The right identity is checked first, then the marker is read.
    const ok = fakeDb(["a".repeat(32)]);
    await assertDisposablePostgres({ db: ok, pgdatabase: TEST_DATABASE });
    expect(ok.log[0]).toBe("SELECT current_database() AS name");
    expect(ok.log.length).toBeGreaterThan(1);
  });

  it("DROP/CREATE runs only on a session the server reports is in the maintenance database", async () => {
    await expect(
      assertMaintenanceSession(fakeDb([], MAINTENANCE_DATABASE)),
    ).resolves.toBeUndefined();
    for (const name of [TEST_DATABASE, "postgres", null]) {
      await expect(assertMaintenanceSession(fakeDb([], name))).rejects.toThrow(
        `maintenance session is not in ${MAINTENANCE_DATABASE}`,
      );
    }
    if (isPgliteEnabled()) {
      return;
    }
    for (const [database, ok] of [
      [MAINTENANCE_DATABASE, true],
      [TEST_DATABASE, false],
    ] as const) {
      const client = new Client({ database });
      await client.connect();
      try {
        const check = assertMaintenanceSession(client);
        if (ok) {
          await expect(check).resolves.toBeUndefined();
        } else {
          await expect(check).rejects.toThrow(NotDisposableError);
        }
      } finally {
        await client.end();
      }
    }
  });
});
