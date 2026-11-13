/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  ensureRestoreDrillAttestationTable,
  getProjectRestoreDrillHealth,
} from "./restore-drill-attestation";
import { uuid } from "@cocalc/util/misc";

const publishAccountFeedEventBestEffortMock = jest.fn();
const stopProjectOnHostMock = jest.fn();
const deleteProjectDataOnHostMock = jest.fn();
const deleteAppSubdomainDnsMock = jest.fn();
const releaseProjectBackupRepoAssignmentMock = jest.fn();
const resolveProjectBackupRepoAssignmentMock = jest.fn();
const getDeletedProjectBackupConfigForDeletionMock = jest.fn();
const invalidateProjectBackupConfigOnHostCheckedMock = jest.fn();
const getProjectBackupConfigForDeletionMock = jest.fn();

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/backend/sandbox/rustic", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/backend/sandbox/exec", () => ({
  parseOutput: jest.fn(),
}));

jest.mock("@cocalc/server/account/feed", () => ({
  __esModule: true,
  publishAccountFeedEventBestEffort: (...args: any[]) =>
    publishAccountFeedEventBestEffortMock(...args),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  stopProjectOnHost: (...args: any[]) => stopProjectOnHostMock(...args),
  deleteProjectDataOnHost: (...args: any[]) =>
    deleteProjectDataOnHostMock(...args),
  invalidateProjectBackupConfigOnHostChecked: (...args: any[]) =>
    invalidateProjectBackupConfigOnHostCheckedMock(...args),
}));

jest.mock("@cocalc/server/cloud/dns", () => ({
  __esModule: true,
  deleteAppSubdomainDns: (...args: any[]) => deleteAppSubdomainDnsMock(...args),
  getCnameTargetForHostname: jest.fn(),
  hasDns: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/project-backup", () => ({
  __esModule: true,
  getDeletedProjectBackupConfigForDeletion: (...args: any[]) =>
    getDeletedProjectBackupConfigForDeletionMock(...args),
  getProjectBackupConfigForDeletion: (...args: any[]) =>
    getProjectBackupConfigForDeletionMock(...args),
  // No status known: every shard counts toward restore drill coverage.
  getProjectBackupRepoStatuses: jest.fn(async () => new Map()),
  releaseProjectBackupRepoAssignment: (...args: any[]) =>
    releaseProjectBackupRepoAssignmentMock(...args),
  resolveProjectBackupRepoAssignment: (...args: any[]) =>
    resolveProjectBackupRepoAssignmentMock(...args),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const NOTIFICATION_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";
const BACKUP_INDEX_ID = "66666666-6666-4666-8666-666666666666";
const BACKUP_REPO_ID = "77777777-7777-4777-8777-777777777777";
const BLOB_ID = "88888888-8888-4888-8888-888888888888";
const ARCHIVED_BLOB_ID = "99999999-9999-4999-8999-999999999999";
const STRING_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BAY_ID = "bay-0";

async function ensureSupplementalSchemas(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_active_operations (
      project_id UUID PRIMARY KEY,
      op_id UUID,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_secrets (
      project_id UUID NOT NULL,
      name TEXT NOT NULL,
      encrypted_value JSONB NOT NULL,
      value_bytes INTEGER NOT NULL,
      PRIMARY KEY (project_id, name)
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_backup_indexes (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL,
      backup_id TEXT NOT NULL,
      backup_time TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_backup_repo_assignments (
      project_id UUID PRIMARY KEY,
      region TEXT NOT NULL,
      backup_repo_id UUID NOT NULL
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_rehome_operations (
      op_id UUID PRIMARY KEY,
      project_id UUID NOT NULL,
      source_bay_id TEXT NOT NULL,
      dest_bay_id TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_collab_invite_inbox (
      invite_id UUID PRIMARY KEY,
      source_bay_id VARCHAR(64) NOT NULL,
      project_id UUID NOT NULL,
      invitee_account_id UUID NOT NULL,
      status VARCHAR(32) NOT NULL,
      created TIMESTAMP NOT NULL,
      updated TIMESTAMP NOT NULL
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_app_public_subdomains (
      project_id UUID NOT NULL,
      app_id TEXT NOT NULL,
      label TEXT NOT NULL,
      hostname TEXT NOT NULL,
      base_path TEXT NOT NULL,
      ttl_s INTEGER NOT NULL,
      dns_record_id TEXT,
      PRIMARY KEY (project_id, app_id)
    )
  `);
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS project_app_private_hostnames (
      project_id UUID NOT NULL,
      app_id TEXT NOT NULL,
      label TEXT NOT NULL,
      hostname TEXT NOT NULL,
      base_path TEXT NOT NULL,
      dns_record_id TEXT,
      dns_target TEXT,
      created_by UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_dns_error TEXT,
      PRIMARY KEY (project_id, app_id),
      UNIQUE (hostname)
    )
  `);
}

async function seedProject(project_id: string): Promise<void> {
  await getPool().query(
    `INSERT INTO projects
       (project_id, title, description, users, state, owning_bay_id,
        created, last_edited)
     VALUES
       ($1, $2, 'hard delete cleanup test', $3::jsonb, $4::jsonb, $5,
        NOW(), NOW())`,
    [
      project_id,
      `Project ${project_id.slice(0, 8)}`,
      JSON.stringify({ [ACCOUNT_ID]: { group: "owner" } }),
      JSON.stringify({ state: "opened" }),
      BAY_ID,
    ],
  );
}

async function seedCleanupRows(): Promise<void> {
  await seedProject(PROJECT_ID);
  await seedProject(OTHER_PROJECT_ID);
  await getPool().query(
    `INSERT INTO account_project_index
       (account_id, project_id, owning_bay_id, host_id, title, description,
        theme, users_summary, state_summary, last_edited, last_backup,
        last_activity_at, last_opened_at, is_hidden, sort_key, updated_at)
     VALUES
       ($1, $2, $3, NULL, 'Project', 'project projection', '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, NOW(), NULL, NOW(), NOW(), FALSE, NOW(), NOW()),
       ($1, $4, $3, NULL, 'Other', 'other projection', '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, NOW(), NULL, NOW(), NOW(), FALSE, NOW(), NOW())`,
    [ACCOUNT_ID, PROJECT_ID, BAY_ID, OTHER_PROJECT_ID],
  );
  await getPool().query(
    `INSERT INTO account_notification_index
       (account_id, notification_id, kind, project_id, summary, read_state,
        created_at, updated_at)
     VALUES
       ($1, $2, 'mention', $3, '{}'::jsonb, '{}'::jsonb, NOW(), NOW())`,
    [ACCOUNT_ID, NOTIFICATION_ID, PROJECT_ID],
  );
  await getPool().query(
    `INSERT INTO project_runtime_slots
       (sponsor_account_id, project_id, owning_bay_id, host_id, state,
        actor_account_id, reason, acquired_at, heartbeat_at, expires_at,
        metadata)
     VALUES
       ($1, $2, $3, NULL, 'running', $1, 'test', NOW(), NOW(),
        NOW() + interval '1 hour', '{}'::jsonb)`,
    [ACCOUNT_ID, PROJECT_ID, BAY_ID],
  );
  await getPool().query(
    `INSERT INTO project_active_operations
       (project_id, kind, action, status)
     VALUES ($1, 'project-start', 'start', 'running')`,
    [PROJECT_ID],
  );
  await getPool().query(
    `INSERT INTO project_rootfs_states
       (project_id, state_role, runtime_image)
     VALUES ($1, 'current', 'ubuntu:latest')`,
    [PROJECT_ID],
  );
  await getPool().query(
    `INSERT INTO project_secrets
       (project_id, name, encrypted_value, value_bytes)
     VALUES ($1, 'TOKEN', '{}'::jsonb, 0)`,
    [PROJECT_ID],
  );
  await getPool().query(
    `INSERT INTO project_backup_indexes
       (id, project_id, backup_id, backup_time, status)
     VALUES ($1, $2, 'backup-1', NOW(), 'complete')`,
    [BACKUP_INDEX_ID, PROJECT_ID],
  );
  await getPool().query(
    `INSERT INTO project_backup_repo_assignments
       (project_id, region, backup_repo_id)
     VALUES ($1, 'local', $2)`,
    [PROJECT_ID, BACKUP_REPO_ID],
  );
  await getPool().query(
    `INSERT INTO project_app_public_subdomains
       (project_id, app_id, label, hostname, base_path, ttl_s, dns_record_id)
     VALUES ($1, 'server', 'server', 'server.example.com', '/', 60, 'dns-1')`,
    [PROJECT_ID],
  );
  await getPool().query(
    `INSERT INTO project_app_private_hostnames
       (project_id, app_id, label, hostname, base_path, dns_record_id,
        dns_target, created_by)
     VALUES
       ($1, 'private-server', 'dev-private', 'dev-private.example.com',
        '/apps/private-server', 'dns-private-1', 'host.example.com', $2)`,
    [PROJECT_ID, ACCOUNT_ID],
  );
  await getPool().query(
    `INSERT INTO project_events_outbox
       (event_id, project_id, owning_bay_id, event_type, payload_json,
        created_at)
     VALUES ($1, $2, $3, 'project.summary_changed', '{}'::jsonb, NOW())`,
    [EVENT_ID, PROJECT_ID, BAY_ID],
  );
  await getPool().query(
    `INSERT INTO project_labels
       (project_id, key, value, created_at, updated_at)
     VALUES ($1, 'cocalc.com/project-kind', 'rootfs-build', NOW(), NOW())`,
    [PROJECT_ID],
  );
  await getPool().query(
    `INSERT INTO project_rootfs_builds
       (build_id, project_id, account_id, status, recipe_ref, created_at, updated)
     VALUES
       ('rb-hard-delete-test', $1, $2, 'succeeded', 'cocalc/test', NOW(), NOW())`,
    [PROJECT_ID, ACCOUNT_ID],
  );
  await getPool().query(
    `INSERT INTO notification_events
       (event_id, kind, source_bay_id, source_project_id, payload_json,
        created_at)
     VALUES
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mention', $1, $2,
        '{}'::jsonb, NOW())`,
    [BAY_ID, PROJECT_ID],
  );
  await getPool().query(
    `INSERT INTO notification_events_outbox
       (event_id, account_id, notification_id, project_id, owning_bay_id, kind,
        event_type, payload_json, created_at)
     VALUES
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', $1,
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc', $2, $3, 'mention',
        'notification.mention_upserted', '{}'::jsonb, NOW())`,
    [ACCOUNT_ID, PROJECT_ID, BAY_ID],
  );
  await getPool().query(
    `INSERT INTO syncstrings
       (string_id, project_id, path, archived)
     VALUES ($1, $2, 'doc.md', $3)`,
    [STRING_ID, PROJECT_ID, ARCHIVED_BLOB_ID],
  );
  await getPool().query(
    `INSERT INTO patches
       (string_id, time, wall, user_id, patch, is_snapshot)
     VALUES ($1, '1', NOW(), 0, '{}', FALSE)`,
    [STRING_ID],
  );
  await getPool().query(
    `INSERT INTO cursors
       (string_id, user_id, locs, time)
     VALUES ($1, 0, ARRAY['{}'::jsonb], NOW())`,
    [STRING_ID],
  );
  await getPool().query(
    `INSERT INTO blobs (id, project_id) VALUES ($1, $3), ($2, NULL)`,
    [BLOB_ID, ARCHIVED_BLOB_ID, PROJECT_ID],
  );
}

async function countRows(table: string, where: string): Promise<number> {
  const { rows } = await getPool().query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`,
    [PROJECT_ID],
  );
  return rows[0]?.count ?? 0;
}

describe("hard delete project cleanup", () => {
  beforeAll(async () => {
    await initEphemeralDatabase({});
    await ensureSupplementalSchemas();
    await ensureRestoreDrillAttestationTable();
  }, 15000);

  beforeEach(() => {
    publishAccountFeedEventBestEffortMock.mockResolvedValue(undefined);
    stopProjectOnHostMock.mockResolvedValue(undefined);
    deleteProjectDataOnHostMock.mockResolvedValue(undefined);
    deleteAppSubdomainDnsMock.mockResolvedValue(undefined);
    releaseProjectBackupRepoAssignmentMock.mockResolvedValue(undefined);
    resolveProjectBackupRepoAssignmentMock.mockResolvedValue(undefined);
    getDeletedProjectBackupConfigForDeletionMock.mockResolvedValue({
      toml: "",
      empty: "no_backup_repo",
    });
    invalidateProjectBackupConfigOnHostCheckedMock.mockResolvedValue({
      profile: "removed",
    });
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await getPool().query(
      `TRUNCATE
        agent_identity_runs,
        agent_identities,
        agent_message_project_fences,
        agent_rpc_admission_state,
        account_notification_index,
        account_project_index,
        blobs,
        cursors,
        deleted_projects,
        notification_events,
        notification_events_outbox,
        patches,
        project_active_operations,
        project_app_private_hostnames,
        project_app_public_subdomains,
        project_backup_indexes,
        project_backup_repo_assignments,
        project_events_outbox,
        project_labels,
        project_rootfs_builds,
        project_rehome_operations,
        project_runtime_slots,
        project_rootfs_states,
        project_restore_drill_attestations,
        project_secrets,
        projects,
        syncstrings
       CASCADE`,
    );
  });

  it("deletes a canary but preserves its attestation and coverage for other projects on the shard", async () => {
    await seedCleanupRows();
    await getPool().query(
      `UPDATE projects SET backup_repo_id=$1, provisioned=true, last_backup=now()
        WHERE project_id IN ($2, $3)`,
      [BACKUP_REPO_ID, PROJECT_ID, OTHER_PROJECT_ID],
    );
    await getPool().query(
      `INSERT INTO project_restore_drill_attestations
         (op_id, project_id, backup_id, backup_repo_id, restore_host_id,
          restore_finished_at, expected_sha256, observed_sha256, passed,
          recorded_by, reason)
       VALUES ($1, $2, 'canary-backup', $3, $4, now(), $5, $5, true, $6, 'canary readback')`,
      [
        EVENT_ID,
        PROJECT_ID,
        BACKUP_REPO_ID,
        BLOB_ID,
        "a".repeat(64),
        ACCOUNT_ID,
      ],
    );
    const { hardDeleteProject } = await import("./hard-delete");
    await hardDeleteProject({ project_id: PROJECT_ID, account_id: ACCOUNT_ID });
    await expect(countRows("projects", "project_id=$1")).resolves.toBe(0);
    await expect(
      countRows("account_project_index", "project_id=$1"),
    ).resolves.toBe(0);
    await expect(
      countRows("project_restore_drill_attestations", "project_id=$1"),
    ).resolves.toBe(1);
    await expect(getProjectRestoreDrillHealth(BAY_ID)).resolves.toEqual([
      expect.objectContaining({
        backup_repo_id: BACKUP_REPO_ID,
        backed_up_projects: 1,
        latest_passed: true,
        latest_backup_id: "canary-backup",
      }),
    ]);
  });

  it("purges project-scoped projection, runtime, backup, secret, and TimeTravel rows", async () => {
    await seedCleanupRows();

    const { hardDeleteProject } = await import("./hard-delete");
    const result = await hardDeleteProject({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
    });

    expect(result.purged_tables).toEqual(
      expect.arrayContaining([
        "account_notification_index",
        "account_project_index",
        "blobs",
        "cursors",
        "notification_events",
        "notification_events_outbox",
        "patches",
        "project_active_operations",
        "project_app_private_hostnames",
        "project_app_public_subdomains",
        "project_backup_indexes",
        "project_backup_repo_assignments",
        "project_events_outbox",
        "project_labels",
        "project_rootfs_builds",
        "project_runtime_slots",
        "project_rootfs_states",
        "project_secrets",
        "syncstrings",
      ]),
    );
    await expect(
      countRows("account_project_index", "project_id=$1"),
    ).resolves.toBe(0);
    await expect(
      countRows("account_notification_index", "project_id=$1"),
    ).resolves.toBe(0);
    await expect(
      countRows("project_runtime_slots", "project_id=$1"),
    ).resolves.toBe(0);
    await expect(countRows("project_secrets", "project_id=$1")).resolves.toBe(
      0,
    );
    await expect(
      countRows("project_app_public_subdomains", "project_id=$1"),
    ).resolves.toBe(0);
    await expect(
      countRows("project_app_private_hostnames", "project_id=$1"),
    ).resolves.toBe(0);
    await expect(countRows("project_labels", "project_id=$1")).resolves.toBe(0);
    await expect(
      countRows("project_rootfs_builds", "project_id=$1"),
    ).resolves.toBe(0);
    expect(deleteAppSubdomainDnsMock).toHaveBeenCalledWith({
      record_id: "dns-1",
      hostname: "server.example.com",
    });
    // Private app hostnames are retired: a stale row is purged with the
    // project, and no DNS work is done for it.
    expect(deleteAppSubdomainDnsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "dev-private.example.com" }),
    );
    await expect(countRows("syncstrings", "project_id=$1")).resolves.toBe(0);
    await expect(
      getPool().query("SELECT COUNT(*)::int AS count FROM patches", []),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      getPool().query("SELECT COUNT(*)::int AS count FROM blobs", []),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(countRows("projects", "project_id=$1")).resolves.toBe(0);
    await expect(
      countRows("account_project_index", "project_id=$1"),
    ).resolves.toBe(0);
    await expect(
      getPool().query(
        "SELECT COUNT(*)::int AS count FROM projects WHERE project_id=$1",
        [OTHER_PROJECT_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(
      getPool().query(
        "SELECT COUNT(*)::int AS count FROM account_project_index WHERE project_id=$1",
        [OTHER_PROJECT_ID],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it("deletes active and disabled agents and their dependencies without touching another project", async () => {
    await seedProject(PROJECT_ID);
    await seedProject(OTHER_PROJECT_ID);
    for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
      for (const disabled of [false, true]) {
        const agentId = uuid();
        await getPool().query(
          `INSERT INTO agent_identities
             (agent_id, project_id, path, thread_id, name, created_by, disabled_at)
           VALUES ($1::uuid, $2, '/home/user/test.chat', $1::uuid::text, 'agent', $3,
                   CASE WHEN $4 THEN now() ELSE NULL END)`,
          [agentId, projectId, ACCOUNT_ID, disabled],
        );
        await getPool().query(
          `INSERT INTO agent_identity_runs
             (agent_id, run_id, account_id, token_hash, expires_at)
           VALUES ($1::uuid, $2, $3, $1::uuid::text, now() + interval '1 hour')`,
          [agentId, uuid(), ACCOUNT_ID],
        );
      }
      await getPool().query(
        `INSERT INTO agent_message_project_fences (project_id, host_id, generation)
         VALUES ($1, $2, $3)`,
        [projectId, uuid(), uuid()],
      );
      for (const kind of ["permit", "preparation"]) {
        await getPool().query(
          `INSERT INTO agent_rpc_admission_state
             (token_id, kind, binding_hash, host_id, project_id, account_id, expires_at)
           VALUES ($1, $2, 'test-binding', $3, $4, $5, now() + interval '1 minute')`,
          [uuid(), kind, uuid(), projectId, ACCOUNT_ID],
        );
      }
    }
    const { hardDeleteProject } = await import("./hard-delete");
    const result = await hardDeleteProject({
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
    });
    expect(result.purged_tables).toEqual(
      expect.arrayContaining([
        "agent_identity_runs",
        "agent_identities",
        "agent_message_project_fences",
        "agent_rpc_admission_state",
        "projects",
      ]),
    );
    for (const table of [
      "projects",
      "agent_identities",
      "agent_message_project_fences",
      "agent_rpc_admission_state",
    ]) {
      await expect(countRows(table, "project_id=$1")).resolves.toBe(0);
      const { rows } = await getPool().query(
        `SELECT DISTINCT project_id FROM ${table}`,
      );
      expect(rows).toEqual([{ project_id: OTHER_PROJECT_ID }]);
    }
    const { rows } = await getPool().query(
      `SELECT a.project_id FROM agent_identity_runs r JOIN agent_identities a USING (agent_id)`,
    );
    expect(rows).toEqual([
      { project_id: OTHER_PROJECT_ID },
      { project_id: OTHER_PROJECT_ID },
    ]);
    await expect(
      hardDeleteProject({ project_id: PROJECT_ID, account_id: ACCOUNT_ID }),
    ).resolves.toBeDefined();
  });

  it("backs off a failed purge so later work can proceed", async () => {
    await getPool().query(
      `INSERT INTO deleted_projects
         (project_id, backup_purge_due_at, backup_purge_status)
       VALUES
         ($1, NOW() - INTERVAL '2 hours', 'scheduled'),
         ($2, NOW() - INTERVAL '1 hour', 'scheduled')`,
      [PROJECT_ID, OTHER_PROJECT_ID],
    );
    getDeletedProjectBackupConfigForDeletionMock
      .mockRejectedValueOnce(new Error("damaged repository"))
      .mockResolvedValue({ toml: "", empty: "no_backup_repo" });

    const { processDueDeletedProjectBackupPurges } =
      await import("./hard-delete");
    await expect(
      processDueDeletedProjectBackupPurges({ limit: 1 }),
    ).resolves.toMatchObject({ processed: 1, failed: 1, quarantined: 0 });
    // no repository recorded: done, but never counted as purged
    await expect(
      processDueDeletedProjectBackupPurges({ limit: 1 }),
    ).resolves.toMatchObject({ processed: 1, purged: 0, no_backup_repo: 1 });

    const { rows } = await getPool().query<{
      project_id: string;
      backup_purge_status: string;
      backup_purge_attempts: number;
      backup_purge_next_attempt_at: Date | null;
    }>(
      `SELECT project_id, backup_purge_status, backup_purge_attempts,
              backup_purge_next_attempt_at
       FROM deleted_projects
       ORDER BY backup_purge_due_at`,
    );
    expect(rows[0]).toMatchObject({
      project_id: PROJECT_ID,
      backup_purge_status: "failed",
      backup_purge_attempts: 1,
    });
    expect(rows[0]?.backup_purge_next_attempt_at).toBeInstanceOf(Date);
    expect(rows[1]).toMatchObject({
      project_id: OTHER_PROJECT_ID,
      backup_purge_status: "no_backup_repo",
      backup_purge_attempts: 1,
    });
  });

  it("quarantines exhausted stale purges without blocking the queue", async () => {
    await getPool().query(
      `INSERT INTO deleted_projects
         (project_id, backup_purge_due_at, backup_purge_status,
          backup_purge_started_at, backup_purge_attempts)
       VALUES
         ($1, NOW() - INTERVAL '2 hours', 'running',
          NOW() - INTERVAL '1 hour', 5),
         ($2, NOW() - INTERVAL '1 hour', 'scheduled', NULL, 0)`,
      [PROJECT_ID, OTHER_PROJECT_ID],
    );

    const { processDueDeletedProjectBackupPurges } =
      await import("./hard-delete");
    await expect(
      processDueDeletedProjectBackupPurges({ limit: 1 }),
    ).resolves.toMatchObject({
      processed: 1,
      purged: 0,
      no_backup_repo: 1,
      quarantined: 1,
      recovered_stale: 1,
    });
    const { rows } = await getPool().query<{
      backup_purge_status: string;
      backup_purge_quarantined_at: Date | null;
    }>(
      `SELECT backup_purge_status, backup_purge_quarantined_at
       FROM deleted_projects WHERE project_id=$1`,
      [PROJECT_ID],
    );
    expect(rows[0]?.backup_purge_status).toBe("quarantined");
    expect(rows[0]?.backup_purge_quarantined_at).toBeInstanceOf(Date);
  });

  describe("backup purge outcomes", () => {
    const HOST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const parseOutputMock = () =>
      jest.requireMock("@cocalc/backend/sandbox/exec").parseOutput as jest.Mock;
    const row = async (project_id = PROJECT_ID) =>
      (
        await getPool().query(
          `SELECT backup_purge_status, backups_purged_at, backup_purge_due_at,
                  backup_purge_attempts, backup_purge_next_attempt_at,
                  backup_purge_error, metadata
           FROM deleted_projects WHERE project_id=$1`,
          [project_id],
        )
      ).rows[0];
    const scheduleDue = async (project_id = PROJECT_ID) =>
      await getPool().query(
        `INSERT INTO deleted_projects (project_id, backup_purge_due_at, backup_purge_status)
         VALUES ($1, NOW() - INTERVAL '1 hour', 'scheduled')`,
        [project_id],
      );
    const worker = async () =>
      await (
        await import("./hard-delete")
      ).processDueDeletedProjectBackupPurges({
        limit: 5,
      });
    const health = async () =>
      await (await import("./backup-purge-health")).getBackupPurgeHealth();

    beforeEach(() => {
      parseOutputMock().mockReset();
      getProjectBackupConfigForDeletionMock.mockReset();
    });

    describe("the scheduled purge", () => {
      it("records no repository as no_backup_repo: not purged, not due, not counted as purged", async () => {
        await scheduleDue();
        await expect(worker()).resolves.toMatchObject({
          processed: 1,
          purged: 0,
          no_backup_repo: 1,
        });
        expect(await row()).toMatchObject({
          backup_purge_status: "no_backup_repo",
          backups_purged_at: null,
          backup_purge_due_at: null,
        });
        // not claimed again, not overdue
        await expect(worker()).resolves.toMatchObject({ processed: 0 });
        expect(await health()).toMatchObject({ overdue: 0, quarantined: 0 });
      });

      it.each([
        "local_config_missing",
        "repo_missing",
        "bucket_missing",
        "credentials_missing",
        "seed_config_unavailable",
      ])(
        "fails a missing configuration (%s), retries it and quarantines it, never 'purged'",
        async (token) => {
          await scheduleDue();
          getDeletedProjectBackupConfigForDeletionMock.mockResolvedValue({
            toml: "",
            empty: token,
          });
          for (let attempt = 1; attempt <= 5; attempt++) {
            const result = await worker();
            expect(result).toMatchObject({
              processed: 1,
              purged: 0,
              no_backup_repo: 0,
            });
            const current = await row();
            expect(current.backup_purge_attempts).toBe(attempt);
            expect(current.backups_purged_at).toBeNull();
            expect(current.backup_purge_error).toContain(token);
            expect(current.backup_purge_status).toBe(
              attempt < 5 ? "failed" : "quarantined",
            );
            // the retry is due now
            await getPool().query(
              "UPDATE deleted_projects SET backup_purge_next_attempt_at=NOW() - INTERVAL '1 second' WHERE project_id=$1",
              [PROJECT_ID],
            );
          }
          expect(await health()).toMatchObject({ quarantined: 1 });
        },
      );

      it.each([
        ["no reason", { toml: "" }],
        ["no reason, whitespace only", { toml: "  \n" }],
        ["an undefined reason", { toml: "", empty: undefined }],
      ])(
        "fails an empty configuration with %s, never no_backup_repo or purged",
        async (_label, config) => {
          await scheduleDue();
          getDeletedProjectBackupConfigForDeletionMock.mockResolvedValue(
            config,
          );
          await expect(worker()).resolves.toMatchObject({
            processed: 1,
            purged: 0,
            no_backup_repo: 0,
            failed: 1,
          });
          const current = await row();
          expect(current.backup_purge_status).toBe("failed");
          expect(current.backups_purged_at).toBeNull();
          expect(current.backup_purge_attempts).toBe(1);
          expect(current.backup_purge_error).toContain("repo_missing");
        },
      );

      it("records a forget that ran as purged", async () => {
        await scheduleDue();
        getDeletedProjectBackupConfigForDeletionMock.mockResolvedValue({
          toml: "[repository]",
        });
        parseOutputMock().mockReturnValue({ stdout: "[]" });
        await expect(worker()).resolves.toMatchObject({
          processed: 1,
          purged: 1,
        });
        const current = await row();
        expect(current.backup_purge_status).toBe("purged");
        expect(current.backups_purged_at).toBeInstanceOf(Date);
        expect(current.metadata.backup_purge_result).toMatchObject({
          outcome: "purged",
          skipped: false,
        });
      });
    });

    describe("an immediate purge", () => {
      const deleteNow = async () =>
        await (
          await import("./hard-delete")
        ).hardDeleteProject({
          project_id: PROJECT_ID,
          account_id: ACCOUNT_ID,
          purge_backups_now: true,
        });

      it("records no repository as no_backup_repo, with no purge time", async () => {
        await seedProject(PROJECT_ID);
        getProjectBackupConfigForDeletionMock.mockResolvedValue({
          toml: "",
          empty: "no_backup_repo",
        });
        const result = await deleteNow();
        expect(result.backup).toMatchObject({
          mode: "immediate",
          outcome: "no_backup_repo",
          purged_at: null,
          purge_due_at: null,
          skipped: true,
        });
        expect(await row()).toMatchObject({
          backup_purge_status: "no_backup_repo",
          backups_purged_at: null,
          backup_purge_due_at: null,
        });
      });

      it("still deletes on a missing configuration, and hands the purge to the worker", async () => {
        await seedProject(PROJECT_ID);
        getProjectBackupConfigForDeletionMock.mockResolvedValue({
          toml: "",
          empty: "bucket_missing",
        });
        const result = await deleteNow();
        expect(result.backup).toMatchObject({
          mode: "immediate",
          outcome: "retrying",
          purged_at: null,
          skipped: true,
        });
        await expect(countRows("projects", "project_id=$1")).resolves.toBe(0);
        const current = await row();
        expect(current).toMatchObject({
          backup_purge_status: "failed",
          backups_purged_at: null,
          backup_purge_attempts: 1,
        });
        expect(current.backup_purge_due_at).toBeInstanceOf(Date);
        expect(current.backup_purge_next_attempt_at).toBeInstanceOf(Date);
        expect(current.backup_purge_error).toContain("bucket_missing");
        // the worker takes it over once its retry is due
        await getPool().query(
          "UPDATE deleted_projects SET backup_purge_next_attempt_at=NOW() - INTERVAL '1 second' WHERE project_id=$1",
          [PROJECT_ID],
        );
        getDeletedProjectBackupConfigForDeletionMock.mockResolvedValue({
          toml: "",
          empty: "bucket_missing",
        });
        await expect(worker()).resolves.toMatchObject({
          processed: 1,
          failed: 1,
        });
        expect((await row()).backup_purge_attempts).toBe(2);
      });

      it.each([
        ["no reason", { toml: "" }],
        ["no reason, whitespace only", { toml: "  \n" }],
        ["an undefined reason", { toml: "", empty: undefined }],
      ])(
        "hands an empty configuration with %s to the worker, never no_backup_repo or purged",
        async (_label, config) => {
          await seedProject(PROJECT_ID);
          getProjectBackupConfigForDeletionMock.mockResolvedValue(config);
          const result = await deleteNow();
          expect(result.backup).toMatchObject({
            mode: "immediate",
            outcome: "retrying",
            purged_at: null,
          });
          const current = await row();
          expect(current).toMatchObject({
            backup_purge_status: "failed",
            backups_purged_at: null,
            backup_purge_attempts: 1,
          });
          expect(current.backup_purge_due_at).toBeInstanceOf(Date);
          expect(current.backup_purge_error).toContain("repo_missing");
        },
      );

      it("records a forget that ran as purged", async () => {
        await seedProject(PROJECT_ID);
        getProjectBackupConfigForDeletionMock.mockResolvedValue({
          toml: "[repository]",
        });
        parseOutputMock().mockReturnValue({ stdout: "[]" });
        const result = await deleteNow();
        expect(result.backup.outcome).toBe("purged");
        expect(result.backup.purged_at).not.toBeNull();
        expect((await row()).backup_purge_status).toBe("purged");
      });

      it("propagates a failing forget and deletes nothing", async () => {
        await seedProject(PROJECT_ID);
        getProjectBackupConfigForDeletionMock.mockResolvedValue({
          toml: "[repository]",
        });
        parseOutputMock().mockImplementation(() => {
          throw new Error("rustic exploded");
        });
        await expect(deleteNow()).rejects.toThrow("rustic exploded");
        await expect(countRows("projects", "project_id=$1")).resolves.toBe(1);
        await expect(
          countRows("deleted_projects", "project_id=$1"),
        ).resolves.toBe(0);
      });
    });

    describe("host cleanup", () => {
      const deleteOnHost = async () => {
        await seedProject(PROJECT_ID);
        await getPool().query(
          "UPDATE projects SET host_id=$2 WHERE project_id=$1",
          [PROJECT_ID, HOST_ID],
        );
        return await (
          await import("./hard-delete")
        ).hardDeleteProject({
          project_id: PROJECT_ID,
          account_id: ACCOUNT_ID,
        });
      };

      it("removes the profile only after the rows are committed, with the record pending until then", async () => {
        let seen: any;
        invalidateProjectBackupConfigOnHostCheckedMock.mockImplementation(
          async () => {
            seen = {
              projects: await countRows("projects", "project_id=$1"),
              host_cleanup: (await row()).metadata.host_cleanup,
            };
            return { profile: "removed" };
          },
        );
        await deleteOnHost();
        expect(
          invalidateProjectBackupConfigOnHostCheckedMock,
        ).toHaveBeenCalledWith({
          project_id: PROJECT_ID,
          host_id: HOST_ID,
        });
        expect(seen.projects).toBe(0);
        expect(seen.host_cleanup).toMatchObject({
          data: "completed",
          profile: "pending",
        });
        expect((await row()).metadata.host_cleanup).toEqual({
          at: expect.any(String),
          data: "completed",
          profile: "removed",
        });
      });

      it.each([
        ["absent", { profile: "absent" }, { profile: "absent" }],
        [
          "failed",
          { profile: "failed" },
          { profile: "failed", profile_error: "rm_failed" },
        ],
        // an older host: never read as removed
        ["unconfirmed", {}, { profile: "unconfirmed" }],
      ])("records a %s profile", async (_label, answer, expected) => {
        invalidateProjectBackupConfigOnHostCheckedMock.mockResolvedValue(
          answer,
        );
        await deleteOnHost();
        expect((await row()).metadata.host_cleanup).toEqual({
          at: expect.any(String),
          data: "completed",
          ...expected,
        });
      });

      it("records a failed call with a fixed token and still deletes", async () => {
        invalidateProjectBackupConfigOnHostCheckedMock.mockRejectedValue(
          new Error(`no responders for host ${HOST_ID}`),
        );
        await expect(deleteOnHost()).resolves.toBeDefined();
        const host_cleanup = (await row()).metadata.host_cleanup;
        expect(host_cleanup).toEqual({
          at: expect.any(String),
          data: "completed",
          profile: "error",
          profile_error: "unreachable",
        });
        // fixed tokens only: the raw error (with the host id) is not stored
        expect(JSON.stringify((await row()).metadata)).not.toContain(HOST_ID);
      });

      it("records the data and the profile independently", async () => {
        deleteProjectDataOnHostMock.mockRejectedValue(
          new Error(`request timed out talking to ${HOST_ID}`),
        );
        invalidateProjectBackupConfigOnHostCheckedMock.mockResolvedValue({
          profile: "removed",
        });
        await expect(deleteOnHost()).resolves.toBeDefined();
        expect(
          invalidateProjectBackupConfigOnHostCheckedMock,
        ).toHaveBeenCalled();
        expect((await row()).metadata.host_cleanup).toEqual({
          at: expect.any(String),
          data: "failed",
          data_error: "timeout",
          profile: "removed",
        });
        expect(JSON.stringify((await row()).metadata)).not.toContain(HOST_ID);
      });

      it("records no host, and calls nothing", async () => {
        await seedProject(PROJECT_ID);
        await (
          await import("./hard-delete")
        ).hardDeleteProject({
          project_id: PROJECT_ID,
          account_id: ACCOUNT_ID,
        });
        expect(
          invalidateProjectBackupConfigOnHostCheckedMock,
        ).not.toHaveBeenCalled();
        expect((await row()).metadata.host_cleanup).toEqual({
          at: expect.any(String),
          data: "no_host",
          profile: "no_host",
        });
      });
    });

    describe("the status constraints", () => {
      const write = async (status: string | null, metadata: unknown) => {
        await worker(); // the schema, with its constraints
        await getPool().query(
          `INSERT INTO deleted_projects (project_id, backup_purge_status, metadata)
           VALUES ($1, $2, $3::jsonb)`,
          [
            OTHER_PROJECT_ID,
            status,
            metadata == null ? null : JSON.stringify(metadata),
          ],
        );
      };
      const ok = {
        reason: "repository deleted whole",
        at: "2026-10-22T12:00:00Z",
        ref: "corrective-closure-record",
      };

      it.each([
        "scheduled",
        "running",
        "failed",
        "quarantined",
        "purged",
        "no_backup_repo",
        null,
      ])("accepts the status %s", async (status) => {
        await expect(write(status, null)).resolves.toBeUndefined();
      });

      it("rejects an unknown status", async () => {
        await expect(write("deleted", null)).rejects.toThrow();
      });

      it.each([
        ["metadata NULL", null],
        ["{}", {}],
        ["a null correction", { backup_purge_correction: null }],
        ["a string correction", { backup_purge_correction: "x" }],
        ["an empty correction", { backup_purge_correction: {} }],
        ["no reason", { backup_purge_correction: { at: ok.at, ref: ok.ref } }],
        [
          "no ref",
          { backup_purge_correction: { at: ok.at, reason: ok.reason } },
        ],
        [
          "no at",
          { backup_purge_correction: { reason: ok.reason, ref: ok.ref } },
        ],
        [
          "a blank reason",
          { backup_purge_correction: { ...ok, reason: "  " } },
        ],
        ["a blank ref", { backup_purge_correction: { ...ok, ref: "" } }],
        ["a number ref", { backup_purge_correction: { ...ok, ref: 5 } }],
        ["an object at", { backup_purge_correction: { ...ok, at: {} } }],
        [
          "an at that is no date-time",
          { backup_purge_correction: { ...ok, at: "yesterday" } },
        ],
      ])("rejects purged_corrective with %s", async (_label, metadata) => {
        await expect(write("purged_corrective", metadata)).rejects.toThrow();
      });

      it("accepts purged_corrective with its evidence", async () => {
        await expect(
          write("purged_corrective", { backup_purge_correction: ok }),
        ).resolves.toBeUndefined();
      });

      it("adds each constraint once, idempotently", async () => {
        await worker();
        await jest.isolateModulesAsync(async () => {
          await (
            await import("./hard-delete")
          ).processDueDeletedProjectBackupPurges();
        });
        const { rows } = await getPool().query(
          `SELECT conname, convalidated FROM pg_constraint
           WHERE conrelid='deleted_projects'::regclass AND contype='c' ORDER BY conname`,
        );
        expect(rows).toEqual([
          {
            conname: "deleted_projects_corrective_has_evidence",
            convalidated: false,
          },
          {
            conname: "deleted_projects_purge_status_known",
            convalidated: false,
          },
        ]);
      });
    });
  });
});
