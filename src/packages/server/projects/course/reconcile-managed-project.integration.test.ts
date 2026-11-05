/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import type * as Reconcile from "./reconcile-managed-project";

const describePglite =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

// Exercises the restore predicate's SQL on a real Postgres engine; the unit
// tests mock query results and cannot check its semantics.
describePglite("restoring a student after a legacy course acceptance", () => {
  const originalEnv = {
    COCALC_DB: process.env.COCALC_DB,
    COCALC_PGLITE_DATA_DIR: process.env.COCALC_PGLITE_DATA_DIR,
  };
  let pool: Awaited<
    ReturnType<(typeof import("@cocalc/database/pool"))["default"]>
  >;
  let reconcile: typeof Reconcile;

  beforeAll(async () => {
    process.env.COCALC_DB = "pglite";
    process.env.COCALC_PGLITE_DATA_DIR = "memory://";
    const getPool = (await import("@cocalc/database/pool")).default;
    pool = getPool();
    await pool.query(`CREATE TABLE project_collab_invites (
      invite_id UUID PRIMARY KEY,
      project_id UUID,
      scope VARCHAR,
      invite_source VARCHAR,
      status VARCHAR,
      accepted_account_id UUID,
      invitee_account_id UUID,
      context JSONB,
      responded TIMESTAMP,
      updated TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE central_log (
      id UUID PRIMARY KEY,
      event VARCHAR,
      value JSONB,
      time TIMESTAMP,
      expire TIMESTAMP
    )`);
    reconcile = await import("./reconcile-managed-project");
  });

  afterAll(async () => {
    const { closePglite } = await import("@cocalc/database/pglite");
    await closePglite();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function acceptance({
    context = {},
    invite_source = "email",
    responded = "NOW() - INTERVAL '30 days'",
  }: {
    context?: Record<string, unknown>;
    invite_source?: string;
    responded?: string;
  } = {}) {
    const project_id = randomUUID();
    const account_id = randomUUID();
    const invite_id = randomUUID();
    await pool.query(
      `INSERT INTO project_collab_invites
         (invite_id, project_id, scope, invite_source, status,
          accepted_account_id, context, responded, updated)
       VALUES ($1, $2, 'course_student', $3, 'accepted', $4, $5::jsonb,
               ${responded}, ${responded})`,
      [
        invite_id,
        project_id,
        invite_source,
        account_id,
        JSON.stringify(context),
      ],
    );
    return { project_id, account_id, invite_id };
  }

  async function removal(
    { project_id, account_id }: { project_id: string; account_id: string },
    via: string | null,
    time = "NOW() - INTERVAL '1 day'",
  ) {
    await pool.query(
      `INSERT INTO central_log(id, event, value, time, expire)
       VALUES ($1, 'project_collaborator_removed', $2::jsonb, ${time},
               NOW() + INTERVAL '13 months')`,
      [
        randomUUID(),
        JSON.stringify({
          project_id,
          removed_account_ids: [account_id],
          ...(via == null ? {} : { via }),
        }),
      ],
    );
  }

  function restorable(x: { project_id: string; account_id: string }) {
    return reconcile.acceptedLegacyCourseStudentInviteToRestore(pool, x);
  }

  it("restores a legacy acceptance with no later removal", async () => {
    const x = await acceptance();
    await expect(restorable(x)).resolves.toBe(x.invite_id);
  });

  it("never restores an acceptance that granted membership itself", async () => {
    const x = await acceptance({ context: { membership_granted: true } });
    await expect(restorable(x)).resolves.toBeUndefined();
  });

  it("restores at most once", async () => {
    const x = await acceptance({
      context: { restored_at: new Date().toISOString() },
    });
    await expect(restorable(x)).resolves.toBeUndefined();
  });

  it("only uses course email acceptances by the same account", async () => {
    const account = await acceptance({ invite_source: "account" });
    await expect(restorable(account)).resolves.toBeUndefined();
    const email = await acceptance();
    await expect(
      restorable({ ...email, account_id: randomUUID() }),
    ).resolves.toBeUndefined();
  });

  it("ignores acceptances older than the membership audit retention", async () => {
    const x = await acceptance({ responded: "NOW() - INTERVAL '14 months'" });
    await expect(restorable(x)).resolves.toBeUndefined();
  });

  it.each([
    "self",
    "collaborator",
    "self-remove",
    "collaborator-remove",
    "self-leave",
    "admin",
    "unattributed",
    null,
  ])("treats a later removal via %s as deliberate", async (via) => {
    const x = await acceptance();
    await removal(x, via);
    await expect(restorable(x)).resolves.toBeUndefined();
  });

  it("does not let course reconciliation's own removal block a restore", async () => {
    const x = await acceptance();
    await removal(x, "course-reconcile");
    await expect(restorable(x)).resolves.toBe(x.invite_id);
  });

  it("ignores removals before the acceptance", async () => {
    const x = await acceptance();
    await removal(x, "self", "NOW() - INTERVAL '60 days'");
    await expect(restorable(x)).resolves.toBe(x.invite_id);
  });
});
