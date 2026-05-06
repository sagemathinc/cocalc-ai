export {};

let queryMock: jest.Mock;
let readFileMock: jest.Mock;
let writeFileMock: jest.Mock;
let createBucketMock: jest.Mock;
let listBucketsMock: jest.Mock;
let deleteObjectMock: jest.Mock;
let seedBackupConfigMock: jest.Mock;
let settings: Record<string, any> = {};

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: queryMock,
    connect: jest.fn(async () => ({
      query: queryMock,
      release: jest.fn(),
    })),
  })),
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
  deleteObject: (...args: any[]) => deleteObjectMock(...args),
  listBuckets: (...args: any[]) => listBucketsMock(...args),
}));

const HOST_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const BUCKET_ID = "33333333-3333-3333-3333-333333333333";
const REPO_ID = "44444444-4444-4444-4444-444444444444";
const REPO_IDS = [
  REPO_ID,
  "55555555-4444-4444-4444-444444444444",
  "66666666-4444-4444-4444-444444444444",
  "77777777-4444-4444-4444-444444444444",
  "88888888-4444-4444-4444-444444444444",
];
const BACKUP_ID = "backup-123";

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

function repoStateRows(): any[] {
  if (settings.repos) {
    return settings.repos;
  }
  if (!settings.active_repo && !settings.backup_repo_id) {
    settings.repos = [];
    return settings.repos;
  }
  settings.repos = [repoRow()];
  return settings.repos;
}

function assignmentState() {
  if (!settings.project_backup_assignments) {
    settings.project_backup_assignments = {};
  }
  return settings.project_backup_assignments;
}

function backupIndexRow(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? "55555555-5555-5555-5555-555555555555",
    project_id: overrides.project_id ?? PROJECT_ID,
    backup_id: overrides.backup_id ?? BACKUP_ID,
    backup_time: overrides.backup_time ?? new Date("2026-01-02T00:00:00.000Z"),
    status: overrides.status ?? "complete",
    storage_backend: overrides.storage_backend ?? "r2-object-store",
    bucket_id: overrides.bucket_id ?? BUCKET_ID,
    object_key:
      overrides.object_key ??
      `project-backup-index/v1/${PROJECT_ID.slice(0, 2)}/${PROJECT_ID}/backup-${BACKUP_ID}.sqlite.gz`,
    compression: overrides.compression ?? "gzip",
    sqlite_bytes: overrides.sqlite_bytes ?? 1024,
    object_bytes: overrides.object_bytes ?? 256,
    sha256: overrides.sha256 ?? "a".repeat(64),
    error: overrides.error ?? null,
    host_id: overrides.host_id ?? HOST_ID,
    created: overrides.created ?? new Date("2026-01-02T00:00:00.000Z"),
    updated: overrides.updated ?? new Date("2026-01-02T00:00:00.000Z"),
  };
}

describe("project-backup", () => {
  const masterKeyBase64 = Buffer.alloc(32, 7).toString("base64");

  beforeEach(() => {
    jest.resetModules();
    settings = {};
    seedBackupConfigMock = jest.fn(async () => ({
      toml: "seed-toml",
      ttl_seconds: 123,
      backup_repo_id: REPO_ID,
    }));
    jest.doMock("@cocalc/database/settings/server-settings", () => ({
      __esModule: true,
      getServerSettings: jest.fn(async () => settings),
    }));
    jest.doMock("@cocalc/server/cluster-config", () => ({
      getClusterConfig: jest.fn(() => ({
        role: settings.cluster_role ?? "standalone",
        seed_bay_id: settings.seed_bay_id ?? "bay-0",
      })),
    }));
    jest.doMock("@cocalc/server/bay-config", () => ({
      getConfiguredBayId: jest.fn(() => settings.bay_id ?? "bay-0"),
    }));
    jest.doMock("@cocalc/server/inter-bay/bridge", () => ({
      getInterBayBridge: jest.fn(() => ({
        hostConnection: jest.fn(() => ({
          getSeedBackupConfig: (...args: any[]) =>
            seedBackupConfigMock(...args),
          resolveSeedBackupRepoAssignment: jest.fn(async () => ({
            backup_repo_id: REPO_ID,
          })),
          getSeedProjectBackupShards: jest.fn(async () => ({
            checked_at: new Date().toISOString(),
            active_shards_per_region: 4,
            projects_per_shard: 500,
            authoritative_bay_id: "bay-0",
            regions: [],
            repos: [],
          })),
        })),
      })),
    }));
    createBucketMock = jest.fn(async () => ({
      name: "cocalc-backups-wnam",
      location: "wnam",
    }));
    deleteObjectMock = jest.fn(async () => undefined);
    listBucketsMock = jest.fn(async () => ["cocalc-backups-wnam"]);
    readFileMock = jest.fn(async () => masterKeyBase64);
    writeFileMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes("CREATE TABLE IF NOT EXISTS project_backup_repos") ||
        sql.includes(
          "CREATE TABLE IF NOT EXISTS project_backup_repo_assignments",
        ) ||
        sql.includes("CREATE TABLE IF NOT EXISTS project_backup_indexes") ||
        sql.includes(
          "ALTER TABLE projects ADD COLUMN IF NOT EXISTS backup_repo_id",
        ) ||
        sql.includes("CREATE INDEX IF NOT EXISTS project_backup_repos_") ||
        sql.includes(
          "CREATE UNIQUE INDEX IF NOT EXISTS project_backup_repos_",
        ) ||
        sql.includes(
          "CREATE INDEX IF NOT EXISTS projects_backup_repo_id_idx",
        ) ||
        sql.includes(
          "CREATE INDEX IF NOT EXISTS project_backup_repo_assignments_",
        ) ||
        sql.includes("CREATE INDEX IF NOT EXISTS project_backup_indexes_") ||
        sql.includes(
          "CREATE UNIQUE INDEX IF NOT EXISTS project_backup_indexes_",
        )
      ) {
        return { rows: [] };
      }
      if (
        sql === "BEGIN" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK" ||
        sql.includes("pg_advisory_xact_lock")
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
      if (
        sql.includes("FROM project_backup_repo_assignments") &&
        sql.includes("WHERE project_id=$1")
      ) {
        const row = assignmentState()[params?.[0] ?? PROJECT_ID];
        return { rows: row ? [row] : [] };
      }
      if (
        sql.includes("FROM project_backup_repos") &&
        sql.includes("WHERE id=$1")
      ) {
        const repo = repoStateRows().find((row: any) => row.id === params?.[0]);
        return repo ? { rows: [repo] } : { rows: [] };
      }
      if (sql.includes("FROM project_backup_repos r")) {
        const region = params?.[0] ?? settings.project_region ?? "wnam";
        let repos = repoStateRows().filter((row: any) => row.region === region);
        if (sql.includes("ANY(")) {
          const statuses = params?.[1] ?? [];
          repos = repos.filter((row: any) =>
            statuses.includes(row.status ?? "active"),
          );
        }
        const counts = Object.values(assignmentState()).reduce(
          (map: Record<string, number>, row: any) => {
            map[row.backup_repo_id] = (map[row.backup_repo_id] ?? 0) + 1;
            return map;
          },
          {},
        );
        return {
          rows: repos.map((row: any) => ({
            ...row,
            assigned_project_count:
              counts[row.id] ?? row.assigned_project_count ?? 0,
          })),
        };
      }
      if (
        sql.startsWith(
          "SELECT COUNT(*)::INTEGER AS count FROM project_backup_repos",
        )
      ) {
        return {
          rows: [
            {
              count:
                settings.repos == null
                  ? (settings.project_backup_repo_count ?? 0)
                  : repoStateRows().length,
            },
          ],
        };
      }
      if (sql.startsWith("INSERT INTO project_backup_repos")) {
        const nextIndex = repoStateRows().length;
        const repo = repoRow({
          id: REPO_IDS[nextIndex] ?? REPO_ID,
          region: params?.[0] ?? settings.project_region ?? "wnam",
          bucket_id: params?.[1] ?? BUCKET_ID,
          root:
            params?.[2] ??
            `rustic/shared-${settings.project_region ?? "wnam"}-${String(nextIndex + 1).padStart(4, "0")}`,
          secret: params?.[3] ?? settings.repo_secret ?? "repo-secret",
          status: params?.[4] ?? "active",
        });
        repoStateRows().push(repo);
        settings.backup_repo_id = repo.id;
        return { rows: [repo] };
      }
      if (sql.startsWith("UPDATE project_backup_repos")) {
        const ids = new Set(params?.[0] ?? []);
        for (const row of repoStateRows()) {
          if (ids.has(row.id)) {
            row.status = params?.[1] ?? row.status;
          }
        }
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO project_backup_repo_assignments")) {
        assignmentState()[params?.[0] ?? PROJECT_ID] = {
          project_id: params?.[0] ?? PROJECT_ID,
          region: params?.[1] ?? settings.project_region ?? "wnam",
          backup_repo_id: params?.[2] ?? REPO_ID,
          created: new Date("2026-01-01T00:00:00Z"),
          updated: new Date("2026-01-01T00:00:00Z"),
        };
        settings.backup_repo_id = params?.[2] ?? REPO_ID;
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM project_backup_repo_assignments")) {
        delete assignmentState()[params?.[0] ?? PROJECT_ID];
        return { rows: [] };
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
      if (sql.startsWith("INSERT INTO project_backup_indexes")) {
        settings.project_backup_indexes_rows = [
          backupIndexRow({
            backup_id: params?.[1],
            backup_time: params?.[2],
            status: params?.[3],
            storage_backend: params?.[4],
            bucket_id: params?.[5],
            object_key: params?.[6],
            compression: params?.[7],
            sqlite_bytes: params?.[8],
            object_bytes: params?.[9],
            sha256: params?.[10],
            error: params?.[11],
            host_id: params?.[12],
          }),
        ];
        return { rows: [] };
      }
      if (
        sql.includes("DELETE FROM project_backup_indexes WHERE project_id=$1")
      ) {
        const rows = settings.project_backup_indexes_rows ?? [];
        if (sql.includes("backup_id=$2")) {
          settings.project_backup_indexes_rows = rows.filter(
            (row: any) =>
              !(
                row.project_id === params?.[0] && row.backup_id === params?.[1]
              ),
          );
        } else if (sql.includes("NOT (backup_id = ANY")) {
          const keep = new Set(params?.[1] ?? []);
          settings.project_backup_indexes_rows = rows.filter(
            (row: any) =>
              row.project_id !== params?.[0] || keep.has(row.backup_id),
          );
        } else {
          settings.project_backup_indexes_rows = rows.filter(
            (row: any) => row.project_id !== params?.[0],
          );
        }
        return { rows: [] };
      }
      if (
        sql.includes("FROM project_backup_indexes") &&
        sql.includes("WHERE project_id=$1 AND backup_id=$2")
      ) {
        const rows = (settings.project_backup_indexes_rows ?? []).filter(
          (row: any) =>
            row.project_id === params?.[0] && row.backup_id === params?.[1],
        );
        return { rows };
      }
      if (
        sql.includes("FROM project_backup_indexes") &&
        sql.includes("WHERE project_id=$1")
      ) {
        const rows = (settings.project_backup_indexes_rows ?? []).filter(
          (row: any) => row.project_id === params?.[0],
        );
        return { rows };
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
    expect(result.index_store).toMatchObject({
      kind: "r2-object-store",
      bucket: "cocalc-backups-wnam",
      key_prefix: "project-backup-index/v1",
      compression: "gzip",
    });
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
    expect(settings.repos).toHaveLength(4);
    expect(settings.repos.map((repo: any) => repo.root)).toEqual([
      "rustic/shared-wnam-0001",
      "rustic/shared-wnam-0002",
      "rustic/shared-wnam-0003",
      "rustic/shared-wnam-0004",
    ]);
    expect(result.toml).toContain('root = "rustic/shared-wnam-0001"');
  });

  it("delegates project backup config to the seed bay from attached bays", async () => {
    settings = {
      cluster_role: "attached",
      seed_bay_id: "bay-0",
      bay_id: "bay-1",
      project_host_id: HOST_ID,
      project_region: "wnam",
    };
    const { getBackupConfig } = await import("./index");
    const result = await getBackupConfig({
      host_id: HOST_ID,
      project_id: PROJECT_ID,
      host_region: "us-west1",
      host_machine: { cloud: "gcp" } as any,
    });
    expect(result).toEqual({
      toml: "seed-toml",
      ttl_seconds: 123,
      index_store: undefined,
    });
    expect(seedBackupConfigMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      project_region: "wnam",
      backup_repo_id: null,
    });
    expect(
      queryMock.mock.calls.some(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("backup_repo_id IS DISTINCT FROM"),
      ),
    ).toBe(true);
  });

  it("builds a seed-managed project backup config without a local project row", async () => {
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
    const { getSeedProjectBackupConfig } = await import("./index");
    const result = await getSeedProjectBackupConfig({
      project_id: PROJECT_ID,
      project_region: "wnam",
    });
    expect(result.backup_repo_id).toBe(REPO_ID);
    expect(result.toml).toContain('repository = "opendal:s3"');
    expect(result.toml).toContain('password = "repo-secret"');
    expect(result.toml).toContain('bucket = "cocalc-backups-wnam"');
    expect(result.ttl_seconds).toBeGreaterThan(0);
    expect(result.index_store).toMatchObject({
      kind: "r2-object-store",
      bucket: "cocalc-backups-wnam",
    });
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

  it("records and lists direct backup index manifests", async () => {
    settings = {
      project_host_id: HOST_ID,
      project_region: "wnam",
      backup_repo_id: REPO_ID,
    };
    const { recordProjectBackupIndex, getProjectBackupIndexes } =
      await import("./index");
    await recordProjectBackupIndex({
      host_id: HOST_ID,
      project_id: PROJECT_ID,
      backup_id: BACKUP_ID,
      backup_time: "2026-01-02T00:00:00.000Z",
      status: "complete",
      object_key:
        "project-backup-index/v1/22/22222222-2222-2222-2222-222222222222/backup-backup-123.sqlite.gz",
      compression: "gzip",
      sqlite_bytes: 2048,
      object_bytes: 512,
      sha256: "b".repeat(64),
    });
    await expect(
      getProjectBackupIndexes({
        host_id: HOST_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        backup_id: BACKUP_ID,
        status: "complete",
        storage_backend: "r2-object-store",
        compression: "gzip",
      }),
    ]);
  });

  it("syncs and deletes backup index manifests", async () => {
    settings = {
      project_host_id: HOST_ID,
      project_region: "wnam",
      backup_repo_id: REPO_ID,
      project_backup_indexes_rows: [
        backupIndexRow({ backup_id: "backup-a" }),
        backupIndexRow({ backup_id: "backup-b" }),
      ],
    };
    const { syncProjectBackupIndexes, deleteProjectBackupIndex } =
      await import("./index");
    await syncProjectBackupIndexes({
      host_id: HOST_ID,
      project_id: PROJECT_ID,
      backup_ids: ["backup-b"],
    });
    expect(settings.project_backup_indexes_rows).toHaveLength(1);
    expect(settings.project_backup_indexes_rows[0].backup_id).toBe("backup-b");
    await deleteProjectBackupIndex({
      host_id: HOST_ID,
      project_id: PROJECT_ID,
      backup_id: "backup-b",
    });
    expect(settings.project_backup_indexes_rows).toHaveLength(0);
  });
});
