/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import centralLog from "../central-log";
import {
  ensureProjectMembershipAuditSchema,
  getProjectMembershipAuditStatus,
  PROJECT_MEMBERSHIP_ADDED_EVENT,
  PROJECT_MEMBERSHIP_ROLE_CHANGED_EVENT,
  projectMembershipAuditSchemaNeedsSync,
  setProjectMembershipAuditContext,
} from "./project-membership-audit";

beforeAll(async () => {
  await initEphemeralDatabase({});
  const client = await getPool().connect();
  try {
    await ensureProjectMembershipAuditSchema(client);
  } finally {
    client.release();
  }
}, 15_000);

afterAll(async () => {
  await testCleanup();
});

async function auditRows(project_id: string) {
  const { rows } = await getPool().query(
    `SELECT event, value,
            expire = time + INTERVAL '13 months' AS thirteen_months
       FROM central_log
      WHERE value->>'project_id'=$1
      ORDER BY time, event`,
    [project_id],
  );
  return rows;
}

async function setUsers(project_id: string, users: object, context?: object) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (context) {
      await setProjectMembershipAuditContext(client, context as any);
    }
    await client.query(
      "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
      [project_id, JSON.stringify(users)],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

describe("project membership audit", () => {
  it("records grants and role changes with the writer's context, ids only", async () => {
    const project_id = uuid();
    const owner = uuid();
    const viewer = uuid();
    const collaborator = uuid();
    const inviter = uuid();
    // a new project's owner is its creator, not a grant
    await getPool().query(
      "INSERT INTO projects(project_id,users) VALUES($1,$2::jsonb)",
      [project_id, JSON.stringify({ [owner]: { group: "owner" } })],
    );
    expect(await auditRows(project_id)).toEqual([]);

    await setUsers(
      project_id,
      {
        [owner]: { group: "owner" },
        [viewer]: { group: "viewer", read_policy: { mode: "full" } },
        [collaborator]: { group: "collaborator" },
      },
      {
        actor_account_id: viewer,
        via: "invite-accept",
        invite_creator_account_id: inviter,
      },
    );
    // a change that grants nothing (hide, ssh keys) is not recorded
    await setUsers(project_id, {
      [owner]: { group: "owner", hide: true },
      [viewer]: { group: "viewer", read_policy: { mode: "full" } },
      [collaborator]: { group: "collaborator" },
    });
    // a role change, with no context: still recorded, as unattributed
    await setUsers(project_id, {
      [owner]: { group: "owner", hide: true },
      [viewer]: { group: "collaborator" },
      [collaborator]: { group: "collaborator" },
    });

    const rows = await auditRows(project_id);
    expect(rows.map((row) => row.event)).toEqual([
      PROJECT_MEMBERSHIP_ADDED_EVENT,
      PROJECT_MEMBERSHIP_ROLE_CHANGED_EVENT,
    ]);
    expect(rows[0].value).toEqual({
      project_id,
      via: "invite-accept",
      actor_account_id: viewer,
      invite_creator_account_id: inviter,
      added_account_ids: [collaborator, viewer].sort(),
      groups: { [viewer]: "viewer", [collaborator]: "collaborator" },
    });
    expect(rows[1].value).toEqual({
      project_id,
      via: "unattributed",
      actor_account_id: null,
      invite_creator_account_id: null,
      changed_account_ids: [viewer],
      groups: { [viewer]: "collaborator" },
      previous_groups: { [viewer]: "viewer" },
    });
    // 13 months
    for (const row of rows) {
      expect(row.thirteen_months).toBe(true);
    }
  });

  it("records removals, with details from the writer that cannot override the record", async () => {
    const project_id = uuid();
    const owner = uuid();
    const viewer = uuid();
    const collaborator = uuid();
    const actor = uuid();
    await getPool().query(
      "INSERT INTO projects(project_id,users) VALUES($1,$2::jsonb)",
      [
        project_id,
        JSON.stringify({
          [owner]: { group: "owner" },
          [viewer]: { group: "viewer" },
          [collaborator]: { group: "collaborator" },
        }),
      ],
    );
    await setUsers(
      project_id,
      { [owner]: { group: "owner" } },
      {
        actor_account_id: actor,
        via: "course-reconcile",
        details: {
          course_project_id: actor,
          student_deleted: true,
          via: "spoofed",
          project_id: "spoofed",
        },
      },
    );
    const rows = await auditRows(project_id);
    expect(rows.map((row) => row.event)).toEqual([
      "project_collaborator_added",
      "project_collaborator_removed",
    ]);
    expect(rows[1].value).toEqual({
      project_id,
      via: "course-reconcile",
      actor_account_id: actor,
      invite_creator_account_id: null,
      course_project_id: actor,
      student_deleted: true,
      removed_account_ids: [collaborator, viewer].sort(),
      previous_groups: { [viewer]: "viewer", [collaborator]: "collaborator" },
    });
    expect(rows[1].thirteen_months).toBe(true);
  });

  it("records collaborators added when a project is created, and legacy string entries", async () => {
    const project_id = uuid();
    const owner = uuid();
    const manager = uuid();
    const legacy = uuid();
    await getPool().query(
      "INSERT INTO projects(project_id,users) VALUES($1,$2::jsonb)",
      [
        project_id,
        JSON.stringify({
          [owner]: { group: "owner" },
          [manager]: { group: "collaborator" },
        }),
      ],
    );
    await getPool().query(
      "UPDATE projects SET users = users || $2::jsonb WHERE project_id=$1",
      [project_id, JSON.stringify({ [legacy]: "collaborator" })],
    );
    const rows = await auditRows(project_id);
    expect(rows.map((row) => row.value.added_account_ids)).toEqual([
      [manager],
      [legacy],
    ]);
  });

  it("never blocks a membership change, and counts the failure", async () => {
    const project_id = uuid();
    const owner = uuid();
    const member = uuid();
    await getPool().query(
      "INSERT INTO projects(project_id,users) VALUES($1,$2::jsonb)",
      [project_id, JSON.stringify({ [owner]: { group: "owner" } })],
    );
    await getPool().query("DELETE FROM project_membership_audit_failures");
    await getPool().query(
      "ALTER TABLE central_log RENAME TO central_log_broken",
    );
    try {
      await setUsers(project_id, {
        [owner]: { group: "owner" },
        [member]: { group: "collaborator" },
      });
    } finally {
      await getPool().query(
        "ALTER TABLE central_log_broken RENAME TO central_log",
      );
    }
    const { rows } = await getPool().query(
      "SELECT users FROM projects WHERE project_id=$1",
      [project_id],
    );
    expect(rows[0].users[member]).toEqual({ group: "collaborator" });
    const status = await getProjectMembershipAuditStatus(getPool());
    expect(status.state).toBe("ok");
    expect(status.recent_failures).toBe(1);
    expect(status.last_error).toContain("central_log");
  });

  it("reports a disabled or missing trigger, and repairs only a missing one", async () => {
    const pool = getPool();
    await pool.query(
      "ALTER TABLE projects DISABLE TRIGGER projects_audit_membership_trigger",
    );
    expect((await getProjectMembershipAuditStatus(pool)).state).toBe(
      "disabled",
    );
    expect(await projectMembershipAuditSchemaNeedsSync(pool)).toBe(false);
    await pool.query(
      "ALTER TABLE projects ENABLE TRIGGER projects_audit_membership_trigger",
    );
    await pool.query(
      "DROP TRIGGER projects_audit_membership_trigger ON projects",
    );
    expect((await getProjectMembershipAuditStatus(pool)).state).toBe("missing");
    expect(await projectMembershipAuditSchemaNeedsSync(pool)).toBe(true);
    const client = await pool.connect();
    try {
      await ensureProjectMembershipAuditSchema(client);
    } finally {
      client.release();
    }
    expect((await getProjectMembershipAuditStatus(pool)).state).toBe("ok");
  });

  it("keeps add and remove rows 13 months, and caps older rows", async () => {
    const pool = getPool();
    const project_id = uuid();
    await centralLog({
      event: "project_collaborator_removed",
      value: { project_id, via: "self-leave" },
    });
    const old = uuid();
    await pool.query(
      `INSERT INTO central_log(id,event,value,time,expire)
       VALUES ($1,'project_collaborator_removed',$2,NOW() - INTERVAL '2 years',NULL),
              ($3,'project_collaborator_added',$2,NOW() - INTERVAL '1 month',NOW() + INTERVAL '5 years'),
              ($4,'create_account',$2,NOW(),NULL)`,
      [old, { project_id }, uuid(), uuid()],
    );
    const client = await pool.connect();
    try {
      await ensureProjectMembershipAuditSchema(client);
    } finally {
      client.release();
    }
    const { rows } = await pool.query(
      `SELECT event, expire = time + INTERVAL '13 months' AS thirteen_months
         FROM central_log WHERE value->>'project_id'=$1 ORDER BY event`,
      [project_id],
    );
    expect(rows).toEqual([
      // other events keep their own retention
      { event: "create_account", thirteen_months: null },
      { event: "project_collaborator_added", thirteen_months: true },
      { event: "project_collaborator_removed", thirteen_months: true },
      { event: "project_collaborator_removed", thirteen_months: true },
    ]);
    // and the existing delete_expired loop removes the capped old row
    const { rows: expired } = await pool.query(
      "SELECT expire <= NOW() AS expired FROM central_log WHERE id=$1",
      [old],
    );
    expect(expired[0].expired).toBe(true);
  });
});
