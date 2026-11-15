/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Real PostgreSQL only: the placement locks that fence an archive's host
// cleanup must refuse a project whose host changed, and must really hold the
// project row while the archive transaction runs. (PGlite runs one
// transaction at a time, so it can't show a second session being blocked.)

export {};

import { before, after, getPool } from "@cocalc/server/test";

jest.setTimeout(30000);

const PGLITE =
  !!process.env.COCALC_TEST_USE_PGLITE || process.env.COCALC_DB === "pglite";
const describeRealPg = PGLITE ? describe.skip : describe;

const PROJECT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const H1 = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const H2 = "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const JOB_ID = "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

beforeAll(async () => {
  await before({ noConat: true });
}, 30000);

// Leak check, real PostgreSQL only (as in copy-db.test.ts). Phase A, while
// the pool is open: no client is still checked out, every other session
// belongs to the code's pool, and no advisory lock is held anywhere.
// Phase B, after the normal teardown: no client backend is left in any
// database. Both use one connection outside the code's pool.
afterAll(async () => {
  if (PGLITE) {
    process.stdout.write("afterAll leak check: n/a (PGlite)\n");
    await after();
    return;
  }
  const { Client } = await import("pg");
  const verifier = new Client({ database: "smc" });
  await verifier.connect();
  try {
    const count = async (sql: string) =>
      Number((await verifier.query(sql)).rows[0]?.n ?? -1);
    const backends = () =>
      count(
        "SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
      );
    const advisoryLocks = () =>
      count(
        "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid <> pg_backend_pid()",
      );
    const pool = getPool() as any;
    const poolTotal = pool.totalCount;
    const checkedOut = poolTotal - pool.idleCount;
    const waiting = pool.waitingCount;
    const otherBackends = await backends();
    const locksA = await advisoryLocks();
    process.stdout.write(
      `afterAll leak check A (pool open): checked_out=${checkedOut} waiting=${waiting} other_client_backends=${otherBackends} pool_total=${poolTotal} advisory_locks=${locksA}\n`,
    );
    expect({
      checkedOut,
      waiting,
      outsidePool: otherBackends - poolTotal,
      locksA,
    }).toEqual({ checkedOut: 0, waiting: 0, outsidePool: 0, locksA: 0 });
    await after();
    let backendsB = await backends();
    let locksB = await advisoryLocks();
    for (let i = 0; i < 50 && (backendsB !== 0 || locksB !== 0); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      backendsB = await backends();
      locksB = await advisoryLocks();
    }
    process.stdout.write(
      `afterAll leak check B (pool closed): client_backends=${backendsB} advisory_locks=${locksB}\n`,
    );
    expect({ backendsB, locksB }).toEqual({ backendsB: 0, locksB: 0 });
  } finally {
    await verifier.end();
  }
});

describeRealPg("archive placement locks on PostgreSQL", () => {
  async function placeProject({ archiving }: { archiving: boolean }) {
    await getPool().query("DELETE FROM projects WHERE project_id = $1", [
      PROJECT_ID,
    ]);
    await getPool().query(
      `INSERT INTO projects (project_id, host_id, state, archive_lifecycle_job_id)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [
        PROJECT_ID,
        H1,
        JSON.stringify({ state: archiving ? "archiving" : "opened" }),
        archiving ? JOB_ID : null,
      ],
    );
  }
  async function projectRow(): Promise<Record<string, any>> {
    const { rows } = await getPool().query(
      `SELECT host_id::text AS host_id, state, archive_lifecycle_job_id::text AS job_id,
              provisioned, archive_reason, archived_at
         FROM projects WHERE project_id = $1`,
      [PROJECT_ID],
    );
    return rows[0];
  }
  // Two independent connections; both are released (or closed) on every path.
  async function withTwoClients(
    fn: (a: any, b: any) => Promise<void>,
  ): Promise<void> {
    const a = await getPool().connect();
    let b: any;
    let aClean = false;
    try {
      b = await getPool().connect();
      await fn(a, b);
      aClean = true;
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      a.release(aClean ? undefined : true);
      if (b) {
        await b.query("ROLLBACK").catch(() => undefined);
        b.release(aClean ? undefined : true);
      }
    }
  }
  // While `a` holds the row, an UPDATE from `b` must time out; after `a`
  // ends, the same UPDATE goes through.
  async function expectRowHeldBy(a: any, b: any) {
    await b.query("SET lock_timeout = '300ms'");
    await expect(
      b.query("UPDATE projects SET last_edited = NOW() WHERE project_id = $1", [
        PROJECT_ID,
      ]),
    ).rejects.toMatchObject({ code: "55P03" });
    await a.query("ROLLBACK");
    const { rowCount } = await b.query(
      "UPDATE projects SET last_edited = NOW() WHERE project_id = $1",
      [PROJECT_ID],
    );
    expect(rowCount).toBe(1);
    await b.query("RESET lock_timeout");
  }

  afterEach(async () => {
    await getPool().query("DELETE FROM projects WHERE project_id = $1", [
      PROJECT_ID,
    ]);
  });

  it("manual archive placement lock refuses a project whose host changed", async () => {
    const { __test__ } = await import("./archive");
    await placeProject({ archiving: false });
    const before = await projectRow();
    await withTwoClients(async (a) => {
      await a.query("BEGIN");
      await expect(
        __test__.lockCurrentManualArchivePlacement({
          db: a,
          project_id: PROJECT_ID,
          expected_host_id: H2,
        }),
      ).rejects.toThrow(
        "the project's owner or host changed during the archive; retry the archive",
      );
      await a.query("ROLLBACK");
    });
    expect(await projectRow()).toEqual(before);
  });

  it("manual archive placement lock holds the row for the expected host", async () => {
    const { __test__ } = await import("./archive");
    await placeProject({ archiving: false });
    await withTwoClients(async (a, b) => {
      await a.query("BEGIN");
      await expect(
        __test__.lockCurrentManualArchivePlacement({
          db: a,
          project_id: PROJECT_ID,
          expected_host_id: H1,
        }),
      ).resolves.toBeUndefined();
      await expectRowHeldBy(a, b);
    });
  });

  it("automatic archive claim lock refuses a project whose host changed", async () => {
    const { __test__ } = await import("./archive");
    await placeProject({ archiving: true });
    const before = await projectRow();
    await withTwoClients(async (a) => {
      await a.query("BEGIN");
      await expect(
        __test__.lockCurrentAutomaticArchiveClaim({
          db: a,
          project_id: PROJECT_ID,
          job_id: JOB_ID,
          expected_host_id: H2,
        }),
      ).rejects.toThrow(
        "automatic archive ownership, claim, or placement changed before cleanup",
      );
      await a.query("ROLLBACK");
    });
    expect(await projectRow()).toEqual(before);
  });

  it("automatic archive claim lock holds the row for the expected host and job", async () => {
    const { __test__ } = await import("./archive");
    await placeProject({ archiving: true });
    await withTwoClients(async (a, b) => {
      await a.query("BEGIN");
      await expect(
        __test__.lockCurrentAutomaticArchiveClaim({
          db: a,
          project_id: PROJECT_ID,
          job_id: JOB_ID,
          expected_host_id: H1,
        }),
      ).resolves.toBeUndefined();
      await expectRowHeldBy(a, b);
    });
  });

  it.each([
    ["manual", false, "the project's owner or host changed during the archive"],
    [
      "automatic",
      true,
      "automatic archive ownership, claim, or placement changed before cleanup",
    ],
  ])(
    "a %s archive whose host moved deletes nothing and records nothing",
    async (_mode, automatic, message) => {
      const { __test__ } = await import("./archive");
      await placeProject({ archiving: automatic });
      const before = await projectRow();
      const cleanupHostData = jest.fn(async () => undefined);
      await expect(
        __test__.setArchivedState({
          project_id: PROJECT_ID,
          reason: automatic ? "free-inactive" : "manual",
          job_id: JOB_ID,
          automatic,
          expected_host_id: H2,
          cleanupHostData,
        }),
      ).rejects.toThrow(message);
      expect(cleanupHostData).not.toHaveBeenCalled();
      expect(await projectRow()).toEqual(before);
    },
  );
});
