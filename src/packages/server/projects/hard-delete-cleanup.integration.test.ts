/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";

const publishAccountFeedEventBestEffortMock = jest.fn();
const stopProjectOnHostMock = jest.fn();
const deleteProjectDataOnHostMock = jest.fn();
const deleteAppSubdomainDnsMock = jest.fn();
const releaseProjectBackupRepoAssignmentMock = jest.fn();
const resolveProjectBackupRepoAssignmentMock = jest.fn();

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
}));

jest.mock("@cocalc/server/cloud/dns", () => ({
  __esModule: true,
  deleteAppSubdomainDns: (...args: any[]) => deleteAppSubdomainDnsMock(...args),
  getCnameTargetForHostname: jest.fn(),
  hasDns: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/project-backup", () => ({
  __esModule: true,
  getDeletedProjectBackupConfigForDeletion: jest.fn(),
  getProjectBackupConfigForDeletion: jest.fn(),
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
  }, 15000);

  beforeEach(() => {
    publishAccountFeedEventBestEffortMock.mockResolvedValue(undefined);
    stopProjectOnHostMock.mockResolvedValue(undefined);
    deleteProjectDataOnHostMock.mockResolvedValue(undefined);
    deleteAppSubdomainDnsMock.mockResolvedValue(undefined);
    releaseProjectBackupRepoAssignmentMock.mockResolvedValue(undefined);
    resolveProjectBackupRepoAssignmentMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await getPool().query(
      `TRUNCATE
        account_notification_index,
        account_project_index,
        blobs,
        cursors,
        deleted_projects,
        notification_events,
        notification_events_outbox,
        patches,
        project_active_operations,
        project_app_public_subdomains,
        project_backup_indexes,
        project_backup_repo_assignments,
        project_events_outbox,
        project_labels,
        project_rehome_operations,
        project_runtime_slots,
        project_rootfs_states,
        project_secrets,
        projects,
        syncstrings
       CASCADE`,
    );
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
        "project_app_public_subdomains",
        "project_backup_indexes",
        "project_backup_repo_assignments",
        "project_events_outbox",
        "project_labels",
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
    await expect(countRows("project_labels", "project_id=$1")).resolves.toBe(0);
    expect(deleteAppSubdomainDnsMock).toHaveBeenCalledWith({
      record_id: "dns-1",
      hostname: "server.example.com",
    });
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
});
