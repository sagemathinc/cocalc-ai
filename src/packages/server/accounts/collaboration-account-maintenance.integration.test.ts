/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { syncCollaboratorsSchema } from "@cocalc/database/postgres/collaborators-common";
import {
  collaborationNotificationStore,
  seedCollaborationNotificationJobs,
  pruneCollaborationNotificationEvents,
} from "@cocalc/database/postgres/collaborators-notifications";
import { ensureCollaborationAccountRehomeSchema } from "./collaboration-account-rehome";

// Exercise new DB sources before the coordinated package build, with one shared
// isolated pool rather than separate source/dist PGlite instances.
jest.mock("@cocalc/database/postgres/collaborators-notifications", () =>
  jest.requireActual("../../database/postgres/collaborators-notifications"),
);
jest.mock("../../database/pool", () =>
  jest.requireActual("@cocalc/database/pool"),
);

const pglite = process.env.COCALC_TEST_USE_PGLITE === "1";
const isolatedPg =
  process.env.COCALC_TEST_ACCOUNT_MAINTENANCE_PG === "1" &&
  process.env.PGHOST?.startsWith("/tmp/collaborators-account-maintenance-");
const describeDb = pglite || isolatedPg ? describe : describe.skip;
const frozenAccount = "00000000-0000-4000-8000-000000000001";
const healthyAccount = "00000000-0000-4000-8000-000000000002";
const bay = "account-maintenance-test";
const previousBay = process.env.COCALC_BAY_ID;
const due = "2020-01-01 00:00:00.123456+00";

describeDb("bounded notification maintenance across account rehome", () => {
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = bay;
    await initEphemeralDatabase();
    await syncCollaboratorsSchema();
    await getPool().query(`CREATE TABLE IF NOT EXISTS account_rehome_operations(
      op_id UUID PRIMARY KEY,account_id UUID,source_bay_id TEXT,dest_bay_id TEXT,status TEXT,stage TEXT,created_at TIMESTAMPTZ DEFAULT now())`);
    await getPool()
      .query(`CREATE TABLE IF NOT EXISTS account_financial_handoffs(
      op_id UUID PRIMARY KEY,account_id UUID,state TEXT)`);
    await ensureCollaborationAccountRehomeSchema();
    await getPool().query(
      `INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$3),($2,$3)
      ON CONFLICT(account_id) DO UPDATE SET home_bay_id=excluded.home_bay_id`,
      [frozenAccount, healthyAccount, bay],
    );
  }, 30000);
  beforeEach(async () => {
    // Only enabled for an in-memory DB or an explicitly isolated private cluster.
    await getPool()
      .query(`TRUNCATE account_collaboration_handoffs,account_collaboration_rehome_pages,
      account_rehome_operations,account_financial_handoffs,collaboration_notification_cursors,
      collaboration_access,collaboration_maintenance,collaboration_notification_events,collaboration_notification_floors`);
  });
  afterAll(async () => {
    await getPool().end();
    if (previousBay == null) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = previousBay;
  });

  const store = () => collaborationNotificationStore(jest.fn(), bay);
  async function inventory(
    account_id: string,
    count: number,
    withCursors = true,
  ) {
    const ids = Array.from({ length: count }, () => randomUUID());
    await getPool().query(
      `INSERT INTO collaboration_access(account_id,project_id,generation,grant_request_id)
      SELECT $1,project_id,$3,$4 FROM unnest($2::uuid[]) p(project_id)`,
      [account_id, ids, randomUUID(), randomUUID()],
    );
    if (withCursors)
      await getPool().query(
        `INSERT INTO collaboration_notification_cursors(account_id,project_id,cursor,due_at)
      SELECT $1,project_id,'17',$3::timestamptz FROM unnest($2::uuid[]) p(project_id)`,
        [account_id, ids, due],
      );
    return ids;
  }
  async function fence(account_id: string, state = "frozen", db = getPool()) {
    await db.query(
      `INSERT INTO account_collaboration_handoffs(account_id,op_id,source_bay_id,dest_bay_id,manifest,state,rolling_hash)
      VALUES($1,$2,$3,'next-home','{}',$4,'hash') ON CONFLICT(account_id) DO UPDATE SET state=excluded.state`,
      [account_id, randomUUID(), bay, state],
    );
  }
  async function cursors(account_id: string) {
    return (
      await getPool().query(
        "SELECT * FROM collaboration_notification_cursors WHERE account_id=$1 ORDER BY project_id",
        [account_id],
      )
    ).rows;
  }

  test.each(["frozen", "accepted", "imported", "retired"])(
    "claim skips %s receipts without aborting healthy jobs",
    async (state) => {
      await inventory(frozenAccount, 3);
      await inventory(healthyAccount, 2);
      const before = await cursors(frozenAccount);
      await fence(frozenAccount, state);
      const jobs = await store().claim(8);
      expect(jobs).toHaveLength(2);
      expect(jobs.every((job) => job.account_id === healthyAccount)).toBe(true);
      expect(await cursors(frozenAccount)).toEqual(before);
    },
  );

  test("a frozen prefix larger than the claim budget cannot starve a later account", async () => {
    await inventory(frozenAccount, 150);
    await inventory(healthyAccount, 1);
    await fence(frozenAccount);
    const worker = store();
    expect(await worker.claim(8)).toEqual([]);
    const checkpoint = (
      await getPool().query(
        "SELECT cursor FROM collaboration_maintenance WHERE id='notification-claim'",
      )
    ).rows[0].cursor;
    expect(checkpoint.due_at_key).toContain(".123456");
    expect(await worker.claim(8)).toEqual([]);
    expect(await worker.claim(8)).toEqual([
      expect.objectContaining({ account_id: healthyAccount }),
    ]);
    expect(
      (await cursors(frozenAccount)).every((row) => row.claim_id == null),
    ).toBe(true);
    await fence(frozenAccount, "active");
    // Wrap after the exhausted suffix; newly active earlier accounts are revisited.
    expect(await worker.claim(8)).toHaveLength(8);
  });

  test("seeding advances past 501 frozen projects and revisits them after activation", async () => {
    await inventory(frozenAccount, 501, false);
    await inventory(healthyAccount, 1, false);
    await fence(frozenAccount);
    await seedCollaborationNotificationJobs(bay);
    expect(await cursors(frozenAccount)).toEqual([]);
    await seedCollaborationNotificationJobs(bay);
    expect(await cursors(healthyAccount)).toHaveLength(1);
    await fence(frozenAccount, "active");
    await seedCollaborationNotificationJobs(bay);
    await seedCollaborationNotificationJobs(bay);
    expect(await cursors(frozenAccount)).toHaveLength(501);
  });

  test("cursor pruning advances past a frozen prefix without rolling back owner-event cleanup", async () => {
    await inventory(frozenAccount, 201);
    await inventory(healthyAccount, 1);
    await getPool().query("DELETE FROM collaboration_access");
    const before = await cursors(frozenAccount);
    await fence(frozenAccount);
    const project = randomUUID(),
      event = randomUUID();
    await getPool().query(
      "INSERT INTO projects(project_id,owning_bay_id) VALUES($1,$2)",
      [project, bay],
    );
    await getPool().query(
      `INSERT INTO collaboration_notification_events(event_id,project_id,generation,event_json,event_hash,created_at)
      VALUES($1,$2,$3,'{}','hash',now()-interval '31 days')`,
      [event, project, randomUUID()],
    );
    expect(await pruneCollaborationNotificationEvents(bay)).toBe(1);
    expect(
      (
        await getPool().query(
          "SELECT * FROM collaboration_notification_events WHERE event_id=$1",
          [event],
        )
      ).rows,
    ).toEqual([]);
    await pruneCollaborationNotificationEvents(bay);
    expect(await cursors(healthyAccount)).toEqual([]);
    expect(await cursors(frozenAccount)).toEqual(before);
    await fence(frozenAccount, "active");
    await pruneCollaborationNotificationEvents(bay);
    await pruneCollaborationNotificationEvents(bay);
    expect(await cursors(frozenAccount)).toEqual([]);
  });

  test("failure cleanup after a concurrent freeze is a no-op, then healthy jobs still retry", async () => {
    await inventory(frozenAccount, 1);
    await inventory(healthyAccount, 1);
    const worker = store(),
      jobs = await worker.claim(8);
    const before = await cursors(frozenAccount);
    await fence(frozenAccount);
    for (const job of jobs) await worker.fail(job, Error("private payload"));
    expect(await cursors(frozenAccount)).toEqual(before);
    expect((await cursors(healthyAccount))[0]).toMatchObject({
      claim_id: null,
      failures: "1",
      last_error: "notification delivery unavailable; retrying",
    });
  });

  test("financial and legacy operation fences remain enforced without a collaboration receipt", async () => {
    await inventory(frozenAccount, 1);
    await inventory(healthyAccount, 1);
    await getPool().query(
      "INSERT INTO account_financial_handoffs(op_id,account_id,state) VALUES($1,$2,'frozen')",
      [randomUUID(), frozenAccount],
    );
    expect(await store().claim(8)).toEqual([
      expect.objectContaining({ account_id: healthyAccount }),
    ]);
    await getPool().query("DELETE FROM account_financial_handoffs");
    await getPool().query(
      "INSERT INTO account_rehome_operations(op_id,account_id,status) VALUES($1,$2,'running')",
      [randomUUID(), frozenAccount],
    );
    expect(await store().claim(8)).toEqual([]);
    await getPool().query(
      "UPDATE account_rehome_operations SET status='failed'",
    );
    expect(await store().claim(8)).toEqual([
      expect.objectContaining({ account_id: frozenAccount }),
    ]);
  });

  test("a freeze appearing after candidate selection is rechecked before row writes", async () => {
    await inventory(frozenAccount, 1);
    await inventory(healthyAccount, 1);
    const connect = getPool().connect.bind(getPool());
    const spy = jest
      .spyOn(getPool(), "connect")
      .mockImplementationOnce(async () => {
        const db = await connect();
        const query = db.query.bind(db);
        const release = db.release.bind(db);
        db.query = async (sql, params) => {
          const result = await query(sql, params);
          if (typeof sql === "string" && sql.includes("LIMIT 64"))
            await fence(frozenAccount, "frozen", { query } as any);
          return result;
        };
        db.release = (...args) => {
          db.query = query;
          db.release = release;
          return release(...args);
        };
        return db;
      });
    try {
      expect(await store().claim(8)).toEqual([
        expect.objectContaining({ account_id: healthyAccount }),
      ]);
      expect((await cursors(frozenAccount))[0].claim_id).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  (isolatedPg ? test : test.skip)(
    "a live account lock cannot block or starve another account (real PG)",
    async () => {
      await inventory(frozenAccount, 1);
      await inventory(healthyAccount, 1);
      const db = await getPool().connect();
      try {
        await db.query("BEGIN");
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtext('account-rehome'),hashtext($1))",
          [frozenAccount],
        );
        const worker = store();
        expect(await worker.claim(8)).toEqual([
          expect.objectContaining({ account_id: healthyAccount }),
        ]);
      } finally {
        await db.query("ROLLBACK");
        db.release();
      }
      expect(await store().claim(8)).toEqual([
        expect.objectContaining({ account_id: frozenAccount }),
      ]);
    },
  );
});
