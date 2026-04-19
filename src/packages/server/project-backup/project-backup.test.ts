export {};

let queryMock: jest.Mock;
let readFileMock: jest.Mock;
let writeFileMock: jest.Mock;
let createBucketMock: jest.Mock;
let listBucketsMock: jest.Mock;
let settings: Record<string, any> = {};

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/backend/data", () => ({
  secrets: "/tmp/secrets",
  logs: "/tmp/logs",
}));

jest.mock("fs/promises", () => ({
  mkdir: jest.fn(async () => undefined),
  readFile: (...args: any[]) => readFileMock(...args),
  writeFile: (...args: any[]) => writeFileMock(...args),
}));

jest.mock("./r2", () => ({
  createBucket: (...args: any[]) => createBucketMock(...args),
  listBuckets: (...args: any[]) => listBucketsMock(...args),
}));

const HOST_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const BUCKET_ID = "33333333-3333-3333-3333-333333333333";
const REPO_ID = "44444444-4444-4444-4444-444444444444";

function bucketRow(name = "cocalc-backups-wnam") {
  return {
    id: BUCKET_ID,
    name,
    provider: "r2",
    purpose: "project-backups",
    region: "wnam",
    location: "wnam",
    account_id: settings.r2_account_id ?? "account",
    access_key_id: settings.r2_access_key_id ?? "access",
    secret_access_key: settings.r2_secret_access_key ?? "secret",
    endpoint: "https://account.r2.cloudflarestorage.com",
    status: "active",
  };
}

function repoRow(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? settings.backup_repo_id ?? REPO_ID,
    region: overrides.region ?? settings.project_region ?? "wnam",
    bucket_id: overrides.bucket_id ?? BUCKET_ID,
    root: overrides.root ?? settings.repo_root ?? "rustic/shared-wnam-0001",
    secret: overrides.secret ?? settings.repo_secret ?? "repo-secret",
    status: overrides.status ?? "active",
    created: overrides.created ?? new Date("2026-01-01T00:00:00Z"),
    updated: overrides.updated ?? new Date("2026-01-01T00:00:00Z"),
    assigned_project_count: overrides.assigned_project_count ?? 0,
  };
}

describe("project-backup", () => {
  const masterKeyBase64 = Buffer.alloc(32, 7).toString("base64");

  beforeEach(() => {
    jest.resetModules();
    settings = {};
    jest.doMock("@cocalc/database/settings/server-settings", () => ({
      __esModule: true,
      getServerSettings: jest.fn(async () => settings),
    }));
    createBucketMock = jest.fn(async () => ({
      name: "cocalc-backups-wnam",
      location: "wnam",
    }));
    listBucketsMock = jest.fn(async () => ["cocalc-backups-wnam"]);
    readFileMock = jest.fn(async () => masterKeyBase64);
    writeFileMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS project_backup_repos") ||
        sql.includes(
          "ALTER TABLE projects ADD COLUMN IF NOT EXISTS backup_repo_id",
        ) ||
        sql.includes("CREATE INDEX IF NOT EXISTS project_backup_repos_") ||
        sql.includes(
          "CREATE UNIQUE INDEX IF NOT EXISTS project_backup_repos_",
        ) ||
        sql.includes("CREATE INDEX IF NOT EXISTS projects_backup_repo_id_idx")
      ) {
        return { rows: [] };
      }
      if (sql === "SELECT backup_repo_id FROM projects WHERE project_id=$1") {
        return {
          rows: [{ backup_repo_id: settings.backup_repo_id ?? null }],
        };
      }
      if (sql === "SELECT region FROM projects WHERE project_id=$1") {
        return { rows: [{ region: settings.project_region ?? "wnam" }] };
      }
      if (
        typeof sql === "string" &&
        sql.includes("COALESCE(projects.owning_bay_id, $2)")
      ) {
        return {
          rows: [
            {
              host_id: settings.project_host_id ?? HOST_ID,
              project_owning_bay_id:
                settings.project_owning_bay_id ?? settings.bay_id ?? "bay-0",
              host_bay_id: settings.host_bay_id ?? settings.bay_id ?? "bay-0",
            },
          ],
        };
      }
      if (sql === "SELECT host_id FROM projects WHERE project_id=$1") {
        return { rows: [{ host_id: settings.project_host_id ?? HOST_ID }] };
      }
      if (sql.includes("FROM project_hosts")) {
        if (settings.host_row_missing) {
          return { rows: [] };
        }
        return { rows: [{ region: "us-west1", metadata: {} }] };
      }
      if (sql.includes("FROM project_moves")) {
        return { rows: [] };
      }
      if (sql.includes("CREATE TABLE IF NOT EXISTS project_moves")) {
        return { rows: [] };
      }
      if (sql.includes("project_copies")) {
        return { rows: [] };
      }
      if (sql.includes("FROM project_backup_repos WHERE id=$1")) {
        return settings.backup_repo_id ? { rows: [repoRow()] } : { rows: [] };
      }
      if (sql.includes("FROM project_backup_repos r")) {
        return settings.active_repo ? { rows: [repoRow()] } : { rows: [] };
      }
      if (
        sql.startsWith(
          "SELECT COUNT(*)::INTEGER AS count FROM project_backup_repos",
        )
      ) {
        return { rows: [{ count: settings.project_backup_repo_count ?? 0 }] };
      }
      if (sql.startsWith("INSERT INTO project_backup_repos")) {
        settings.backup_repo_id = REPO_ID;
        return { rows: [repoRow()] };
      }
      if (sql.startsWith("UPDATE projects SET backup_repo_id=$2")) {
        settings.backup_repo_id = params?.[1] ?? REPO_ID;
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE projects SET region=$2")) {
        settings.project_region = params?.[1];
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE projects SET last_backup")) {
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO buckets")) {
        return { rows: [] };
      }
      if (sql.includes("FROM buckets WHERE provider")) {
        return { rows: [] };
      }
      if (sql.includes("FROM buckets WHERE id=$1")) {
        return { rows: [bucketRow()] };
      }
      if (sql.includes("FROM buckets WHERE name=$1")) {
        return { rows: [bucketRow(params?.[0])] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("builds shared-repo config and assigns the project to an active repo", async () => {
    settings = {
      r2_account_id: "account",
      r2_api_token: "token",
      r2_access_key_id: "access",
      r2_secret_access_key: "secret",
      r2_bucket_prefix: "cocalc-backups",
      project_region: "wnam",
      repo_secret: "repo-secret",
      repo_root: "rustic/shared-wnam-0001",
      active_repo: true,
    };
    const { getBackupConfig } = await import("./index");
    const result = await getBackupConfig({
      host_id: HOST_ID,
      project_id: PROJECT_ID,
    });
    expect(result.toml).toContain('repository = "opendal:s3"');
    expect(result.toml).toContain('password = "repo-secret"');
    expect(result.toml).toContain('bucket = "cocalc-backups-wnam"');
    expect(result.toml).toContain('root = "rustic/shared-wnam-0001"');
    expect(
      queryMock.mock.calls.some(
        ([sql]) =>
          typeof sql === "string" &&
          sql.startsWith("UPDATE projects SET backup_repo_id=$2"),
      ),
    ).toBe(true);
    expect(result.ttl_seconds).toBeGreaterThan(0);
  });

  it("creates the first shared repo and bucket on first use", async () => {
    settings = {
      r2_account_id: "account",
      r2_api_token: "token",
      r2_access_key_id: "access",
      r2_secret_access_key: "secret",
      r2_bucket_prefix: "cocalc-backups",
      project_region: "wnam",
      project_backup_repo_count: 0,
      active_repo: false,
      repo_secret: "repo-secret",
    };
    listBucketsMock = jest.fn(async () => []);
    const { getBackupConfig } = await import("./index");
    const result = await getBackupConfig({
      host_id: HOST_ID,
      project_id: PROJECT_ID,
    });
    expect(createBucketMock).toHaveBeenCalledWith(
      "token",
      "account",
      "cocalc-backups-wnam",
      "wnam",
    );
    expect(
      queryMock.mock.calls.some(([sql]) =>
        typeof sql === "string"
          ? sql.startsWith("INSERT INTO project_backup_repos")
          : false,
      ),
    ).toBe(true);
    expect(result.toml).toContain('root = "rustic/shared-wnam-0001"');
  });

  it("ensures a region bucket exists for first use", async () => {
    settings = {
      r2_account_id: "account",
      r2_api_token: "token",
      r2_access_key_id: "access",
      r2_secret_access_key: "secret",
      r2_bucket_prefix: "cocalc-backups",
    };
    listBucketsMock = jest.fn(async () => []);
    const { ensureProjectBackupBucketForRegion } = await import("./index");
    const result = await ensureProjectBackupBucketForRegion("weur");
    expect(createBucketMock).toHaveBeenCalledWith(
      "token",
      "account",
      "cocalc-backups-weur",
      "weur",
    );
    expect(result?.name).toBe("cocalc-backups-weur");
  });

  it("treats cloudflare 409 conflict during bucket ensure as already-exists", async () => {
    settings = {
      r2_account_id: "account",
      r2_api_token: "token",
      r2_access_key_id: "access",
      r2_secret_access_key: "secret",
      r2_bucket_prefix: "cocalc-backups",
    };
    listBucketsMock = jest.fn().mockResolvedValue([]);
    createBucketMock = jest.fn(async () => {
      throw new Error("cloudflare api failed: 409 Conflict");
    });
    const { ensureProjectBackupBucketForRegion } = await import("./index");
    const result = await ensureProjectBackupBucketForRegion("weur");
    expect(createBucketMock).toHaveBeenCalledWith(
      "token",
      "account",
      "cocalc-backups-weur",
      "weur",
    );
    expect(result?.name).toBe("cocalc-backups-weur");
  });

  it("records last_backup using the provided time", async () => {
    settings = {
      project_host_id: HOST_ID,
      project_region: "wnam",
    };
    const { recordProjectBackup } = await import("./index");
    const when = new Date("2026-01-01T00:00:00Z");
    await recordProjectBackup({
      host_id: HOST_ID,
      project_id: PROJECT_ID,
      time: when.toISOString(),
    });
    const updateCall = queryMock.mock.calls.find(([sql]) =>
      sql.startsWith("UPDATE projects SET last_backup"),
    );
    expect(updateCall).toBeDefined();
    const params = updateCall?.[1] as [string, Date];
    expect(params?.[1]?.toISOString()).toBe(when.toISOString());
  });

  it("allows backup access when the authenticated host is the assigned host across bays", async () => {
    settings = {
      project_host_id: HOST_ID,
      project_region: "wnam",
      project_owning_bay_id: "bay-a",
      host_bay_id: "bay-b",
    };
    const { recordProjectBackup } = await import("./index");
    await expect(
      recordProjectBackup({
        host_id: HOST_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects backup access when a different host requests the project backup config", async () => {
    settings = {
      project_host_id: HOST_ID,
      project_region: "wnam",
      project_owning_bay_id: "bay-a",
      host_bay_id: "bay-b",
    };
    const { getBackupConfig } = await import("./index");
    await expect(
      getBackupConfig({
        host_id: "55555555-5555-5555-5555-555555555555",
        project_id: PROJECT_ID,
      }),
    ).rejects.toThrow("project not assigned to host");
  });

  it("accepts delegated host context when the owning bay does not have a local host row", async () => {
    settings = {
      project_host_id: HOST_ID,
      project_region: "wnam",
      project_owning_bay_id: "bay-a",
      host_bay_id: "bay-b",
      active_repo: true,
      host_row_missing: true,
      r2_account_id: "account",
      r2_api_token: "token",
      r2_access_key_id: "access",
      r2_secret_access_key: "secret",
      r2_bucket_prefix: "cocalc-backups",
      repo_secret: "repo-secret",
      repo_root: "rustic/shared-wnam-0001",
    };
    const { getBackupConfig } = await import("./index");
    await expect(
      getBackupConfig({
        host_id: HOST_ID,
        project_id: PROJECT_ID,
        host_region: "us-west1",
        host_machine: { cloud: "gcp" } as any,
      }),
    ).resolves.toMatchObject({
      ttl_seconds: expect.any(Number),
    });
  });
});
