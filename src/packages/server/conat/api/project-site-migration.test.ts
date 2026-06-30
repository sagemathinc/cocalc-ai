export {};

let queryMock: jest.Mock;
let getPoolMock: jest.Mock;
let createProjectMock: jest.Mock;
let isAdminMock: jest.Mock;
let getSeedProjectBackupConfigMock: jest.Mock;
let setProjectEntitlementOverrideLocalMock: jest.Mock;
let setProjectLabelsMock: jest.Mock;
let requireDangerousProjectMutationAuthMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

jest.mock("@cocalc/server/projects/create", () => ({
  __esModule: true,
  default: (...args: any[]) => createProjectMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/project-backup", () => ({
  __esModule: true,
  getSeedProjectBackupConfig: (...args: any[]) =>
    getSeedProjectBackupConfigMock(...args),
}));

jest.mock("@cocalc/server/membership/project-entitlement-overrides", () => ({
  __esModule: true,
  setProjectEntitlementOverrideLocal: (...args: any[]) =>
    setProjectEntitlementOverrideLocalMock(...args),
}));

jest.mock("@cocalc/server/projects/labels", () => ({
  __esModule: true,
  setProjectLabels: (...args: any[]) => setProjectLabelsMock(...args),
}));

jest.mock("./project-dangerous-auth", () => ({
  __esModule: true,
  requireDangerousProjectMutationAuth: (...args: any[]) =>
    requireDangerousProjectMutationAuthMock(...args),
}));

describe("project site migration destination RPCs", () => {
  const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
  const OWNER_ID = "22222222-2222-4222-8222-222222222222";
  const SOURCE_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
  const DESTINATION_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
  const BACKUP_REPO_ID = "55555555-5555-4555-8555-555555555555";
  const MIGRATION_ID = "66666666-6666-4666-8666-666666666666";

  const migrationRow = {
    id: MIGRATION_ID,
    source_site: "alpha",
    source_project_id: SOURCE_PROJECT_ID,
    destination_project_id: DESTINATION_PROJECT_ID,
    destination_owner_account_id: OWNER_ID,
    destination_backup_repo_id: BACKUP_REPO_ID,
    status: "prepared",
    source_backup_op_id: null,
    destination_restore_op_id: null,
    snapshot_id: null,
    backup_index_key: null,
    source_project_title: "Example",
    source_project_description: "Migrated example",
    source_usage_bytes: "10485760",
    backup_summary: {},
    metadata: {},
    error: null,
    created_by: ADMIN_ID,
    created_at: new Date("2026-06-30T12:00:00Z"),
    updated_at: new Date("2026-06-30T12:00:00Z"),
    completed_at: null,
  };

  beforeEach(() => {
    jest.resetModules();
    createProjectMock = jest.fn(async () => DESTINATION_PROJECT_ID);
    isAdminMock = jest.fn(async () => true);
    getSeedProjectBackupConfigMock = jest.fn(async () => ({
      toml: '[repository]\npassword = "secret"',
      ttl_seconds: 3600,
      backup_repo_id: BACKUP_REPO_ID,
      index_store: {
        kind: "r2-object-store",
        endpoint: "https://example.invalid",
        bucket: "backups",
        access_key_id: "access",
        secret_access_key: "secret",
        key_prefix: "project-backup-indexes",
        compression: "zstd",
      },
    }));
    setProjectEntitlementOverrideLocalMock = jest.fn(async () => ({}));
    setProjectLabelsMock = jest.fn(async () => ({}));
    requireDangerousProjectMutationAuthMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM accounts")) {
        return { rows: [{ account_id: OWNER_ID }] };
      }
      if (sql.includes("SELECT region FROM projects")) {
        return { rows: [{ region: "WNAM" }] };
      }
      if (sql.includes("SELECT backup_repo_id FROM projects")) {
        return { rows: [{ backup_repo_id: BACKUP_REPO_ID }] };
      }
      if (sql.includes("FROM project_site_migrations")) {
        return { rows: [migrationRow] };
      }
      return { rows: [] };
    });
    getPoolMock = jest.fn(() => ({ query: queryMock }));
  });

  it("prepares an archived destination project with backup repo credentials", async () => {
    const { prepareIncomingProjectBackupMigration } =
      await import("./project-site-migration");

    const result = await prepareIncomingProjectBackupMigration({
      account_id: ADMIN_ID,
      browser_id: "browser-1",
      session_hash: "session-1",
      source_site: "alpha",
      source_project_id: SOURCE_PROJECT_ID,
      owner: "owner@example.com",
      title: "Example",
      description: "Migrated example",
      disk_mb: "auto",
      source_usage_bytes: 10 * 1024 * 1024,
    });

    expect(createProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: OWNER_ID,
        title: "Example",
        description: "Migrated example",
        start: false,
        skip_project_count_limit: true,
      }),
    );
    expect(getSeedProjectBackupConfigMock).toHaveBeenCalledWith({
      project_id: DESTINATION_PROJECT_ID,
      project_region: "WNAM",
    });
    expect(setProjectEntitlementOverrideLocalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: DESTINATION_PROJECT_ID,
        actor_account_id: ADMIN_ID,
        source: "project-site-migration",
        override: expect.objectContaining({
          project_defaults: {
            disk_quota: { mode: "set", value: 1034 },
          },
        }),
      }),
    );
    expect(setProjectLabelsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: DESTINATION_PROJECT_ID,
        labels: expect.objectContaining({
          "cocalc.ai/project-site-migration": "prepared",
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        destination_project_id: DESTINATION_PROJECT_ID,
        destination_backup_repo_id: BACKUP_REPO_ID,
        rustic_repo_toml: '[repository]\npassword = "secret"',
      }),
    );
    expect(result.migration_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns migration status for admins", async () => {
    const { getProjectSiteMigrationStatus } =
      await import("./project-site-migration");

    await expect(
      getProjectSiteMigrationStatus({
        account_id: ADMIN_ID,
        migration_id: MIGRATION_ID,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: MIGRATION_ID,
        source_site: "alpha",
        source_usage_bytes: 10485760,
        status: "prepared",
      }),
    );
  });

  it("finalizes a migration as archive-only and records the snapshot id", async () => {
    const { finalizeIncomingProjectBackupMigration } =
      await import("./project-site-migration");

    const result = await finalizeIncomingProjectBackupMigration({
      account_id: ADMIN_ID,
      browser_id: "browser-1",
      session_hash: "session-1",
      migration_id: MIGRATION_ID,
      destination_project_id: DESTINATION_PROJECT_ID,
      snapshot_id: "snapshot-123",
      backup_index_key: "indexes/key.sqlite.zst",
      source_backup_result: { total_bytes: 1234 },
      restore: true,
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE project_site_migrations"),
      expect.arrayContaining([
        MIGRATION_ID,
        "snapshot-123",
        "indexes/key.sqlite.zst",
      ]),
    );
    expect(setProjectLabelsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: DESTINATION_PROJECT_ID,
        labels: expect.objectContaining({
          "cocalc.ai/project-site-migration": "finalized",
          "cocalc.ai/project-site-migration/id": MIGRATION_ID,
        }),
      }),
    );
    expect(result).toEqual({
      migration_id: MIGRATION_ID,
      destination_project_id: DESTINATION_PROJECT_ID,
      snapshot_id: "snapshot-123",
      status: "finalized",
      warnings: [
        "restore after finalize is not implemented yet; migration was finalized archive-only",
      ],
    });
  });
});
