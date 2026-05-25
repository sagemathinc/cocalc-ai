/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let readFileMock: jest.Mock;
let writeFileMock: jest.Mock;
let uuidCounter = 0;

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const BUCKET_ID = "22222222-2222-4222-8222-222222222222";

type RepoRow = {
  id: string;
  region: string;
  bucket_id: string;
  root: string;
  secret: string;
  status: string;
  created: Date;
  updated: Date;
};

type ReleaseRow = {
  release_id: string;
  runtime_image: string;
  repo_id: string | null;
  gc_status?: string;
  artifact_bytes?: number;
  updated?: Date;
  created?: Date;
};

type ArtifactRow = {
  artifact_id: string;
  repo_id: string | null;
  status?: string;
  artifact_bytes?: number;
};

let repos: RepoRow[] = [];
let releases: ReleaseRow[] = [];
let artifacts: ArtifactRow[] = [];

jest.mock("uuid", () => ({
  v4: () => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
  },
}));

jest.mock("@cocalc/backend/data", () => ({
  secrets: "/tmp/secrets",
}));

jest.mock("node:fs/promises", () => ({
  mkdir: jest.fn(async () => undefined),
  readFile: (...args: any[]) => readFileMock(...args),
  writeFile: (...args: any[]) => writeFileMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    warn: jest.fn(),
    debug: jest.fn(),
  }),
  getLogger: () => ({
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock("@cocalc/backend/sandbox/rustic", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/server/project-backup", () => ({
  ensureProjectBackupBucketForRegion: jest.fn(async (region: string) => ({
    id: BUCKET_ID,
    name: `cocalc-backups-${region}`,
    provider: "r2",
    purpose: "project-backups",
    region,
    location: region,
    access_key_id: "access-key",
    secret_access_key: "secret-key",
    endpoint: "https://r2.example.com",
    status: "active",
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
    connect: jest.fn(async () => ({
      query: (...args: any[]) => queryMock(...args),
      release: jest.fn(),
    })),
  })),
}));

jest.mock("@cocalc/server/rootfs/events", () => ({
  appendRootfsImageEventForReleaseImages: jest.fn(),
}));

function bucketRow(region = "wnam") {
  return {
    id: BUCKET_ID,
    name: `cocalc-backups-${region}`,
    purpose: "project-backups",
    region,
    endpoint: "https://r2.example.com",
    access_key_id: "access-key",
    secret_access_key: "secret-key",
    status: "active",
  };
}

function assignedCount(repoId: string): number {
  return (
    releases.filter(
      (release) =>
        release.repo_id === repoId && release.gc_status !== "deleted",
    ).length +
    artifacts.filter(
      (artifact) =>
        artifact.repo_id === repoId && artifact.status !== "deleted",
    ).length
  );
}

function repoWithCount(repo: RepoRow) {
  return {
    ...repo,
    assigned_artifact_count: assignedCount(repo.id),
  };
}

function seedRepo(overrides: Partial<RepoRow> = {}): RepoRow {
  const id =
    overrides.id ??
    `99999999-0000-4000-8000-${String(repos.length + 1).padStart(12, "0")}`;
  const region = overrides.region ?? "wnam";
  const repo = {
    id,
    region,
    bucket_id: overrides.bucket_id ?? BUCKET_ID,
    root:
      overrides.root ??
      `rustic/rootfs-images/${region}/shard-${String(repos.length + 1).padStart(4, "0")}-${id}`,
    secret: overrides.secret ?? "repo-secret",
    status: overrides.status ?? "active",
    created:
      overrides.created ??
      new Date(`2026-05-25T00:00:${String(repos.length).padStart(2, "0")}Z`),
    updated: overrides.updated ?? new Date("2026-05-25T00:00:00Z"),
  };
  repos.push(repo);
  return repo;
}

function seedAssignments(repo: RepoRow, count: number): void {
  for (let i = 0; i < count; i++) {
    releases.push({
      release_id: `${repo.id}-${i}`,
      runtime_image: `cocalc.local/rootfs/${repo.id}-${i}`,
      repo_id: repo.id,
      artifact_bytes: 1024,
      created: new Date(`2026-05-25T00:${String(i % 60).padStart(2, "0")}:00Z`),
      updated: new Date(`2026-05-25T00:${String(i % 60).padStart(2, "0")}:00Z`),
    });
  }
}

function reposForRegion(region: string, statuses?: string[]): RepoRow[] {
  return repos
    .filter((repo) => repo.region === region)
    .filter((repo) => !statuses?.length || statuses.includes(repo.status))
    .map(repoWithCount)
    .sort((a, b) => {
      const count = a.assigned_artifact_count - b.assigned_artifact_count;
      if (count !== 0) return count;
      const created = a.created.getTime() - b.created.getTime();
      if (created !== 0) return created;
      return a.id.localeCompare(b.id);
    });
}

function installQueryMock(): void {
  queryMock = jest.fn(async (sql: string, params?: any[]) => {
    if (
      sql.includes("CREATE TABLE IF NOT EXISTS rootfs_rustic_repos") ||
      sql.includes("ALTER TABLE rootfs_") ||
      sql.includes("CREATE INDEX IF NOT EXISTS rootfs_") ||
      sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS rootfs_") ||
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.includes("pg_advisory_xact_lock")
    ) {
      return { rows: [] };
    }
    if (sql.includes("SELECT region, metadata FROM project_hosts")) {
      return {
        rows: [{ region: "wnam", metadata: { machine: { cloud: "gcp" } } }],
      };
    }
    if (sql.includes("FROM buckets") && sql.includes("WHERE id=$1")) {
      return { rows: [bucketRow()] };
    }
    if (
      sql.includes("FROM rootfs_rustic_repos r") &&
      sql.includes("WHERE r.id=$1")
    ) {
      const repo = repos.find((row) => row.id === params?.[0]);
      return { rows: repo ? [repoWithCount(repo)] : [] };
    }
    if (sql.includes("FROM rootfs_rustic_repos r")) {
      return { rows: reposForRegion(params?.[0] ?? "wnam", params?.[1] ?? []) };
    }
    if (
      sql.startsWith(
        "SELECT COUNT(*)::INTEGER AS count FROM rootfs_rustic_repos",
      )
    ) {
      return {
        rows: [
          {
            count: repos.filter((repo) => repo.region === params?.[0]).length,
          },
        ],
      };
    }
    if (sql.startsWith("INSERT INTO rootfs_rustic_repos")) {
      const repo = seedRepo({
        id: params?.[0],
        region: params?.[1],
        bucket_id: params?.[2],
        root: params?.[3],
        secret: params?.[4],
        status: params?.[5],
      });
      return { rows: [repo] };
    }
    if (sql.includes("UPDATE rootfs_rustic_repos")) {
      const ids = new Set(params?.[0] ?? []);
      for (const repo of repos) {
        if (ids.has(repo.id)) {
          repo.status = params?.[1] ?? repo.status;
        }
      }
      return { rows: [] };
    }
    if (sql.includes("SELECT rel.repo_id")) {
      const region = params?.[0];
      const candidates = releases
        .filter((release) => {
          const repo = repos.find((row) => row.id === release.repo_id);
          return (
            repo?.region === region &&
            repo.status === "active" &&
            release.gc_status !== "deleted" &&
            (release.release_id === params?.[1] ||
              release.runtime_image === params?.[1] ||
              release.release_id === params?.[2] ||
              release.runtime_image === params?.[2])
          );
        })
        .sort(
          (a, b) =>
            (b.updated?.getTime() ?? 0) - (a.updated?.getTime() ?? 0) ||
            (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0),
        );
      return {
        rows: candidates[0]?.repo_id
          ? [{ repo_id: candidates[0].repo_id }]
          : [],
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
}

describe("RootFS rustic repo sharding", () => {
  beforeEach(() => {
    jest.resetModules();
    uuidCounter = 0;
    repos = [];
    releases = [];
    artifacts = [];
    readFileMock = jest.fn(async () => "shared-secret");
    writeFileMock = jest.fn(async () => undefined);
    installQueryMock();
  });

  it("creates four active shards for a region before assigning a new artifact", async () => {
    const { issueRootfsReleaseArtifactUpload } = await import("./releases");

    const target = await issueRootfsReleaseArtifactUpload({ host_id: HOST_ID });

    expect(repos).toHaveLength(4);
    expect(repos.map((repo) => repo.status)).toEqual([
      "active",
      "active",
      "active",
      "active",
    ]);
    expect(target.repo_id).toBe(repos[0].id);
    expect(target.repo_selector).toBe(`r2:rootfs-images:wnam:${repos[0].id}`);
    expect(target.repo_root).toContain("rustic/rootfs-images/wnam/shard-0001");
  });

  it("chooses the least-filled active shard", async () => {
    const repo1 = seedRepo();
    const repo2 = seedRepo();
    const repo3 = seedRepo();
    const repo4 = seedRepo();
    seedAssignments(repo1, 3);
    seedAssignments(repo2, 1);
    seedAssignments(repo4, 2);
    const { issueRootfsReleaseArtifactUpload } = await import("./releases");

    const target = await issueRootfsReleaseArtifactUpload({ host_id: HOST_ID });

    expect(target.repo_id).toBe(repo3.id);
  });

  it("prefers an active same-lineage shard when it has capacity", async () => {
    const repo1 = seedRepo();
    const repo2 = seedRepo();
    seedRepo();
    seedRepo();
    seedAssignments(repo1, 1);
    releases.push({
      release_id: "parent-release",
      runtime_image: "cocalc.local/rootfs/base:20260525",
      repo_id: repo2.id,
      artifact_bytes: 2048,
      updated: new Date("2026-05-25T01:00:00Z"),
      created: new Date("2026-05-25T01:00:00Z"),
    });
    const { issueRootfsReleaseArtifactUpload } = await import("./releases");

    const target = await issueRootfsReleaseArtifactUpload({
      host_id: HOST_ID,
      parent_release_id: "parent-release",
    });

    expect(target.repo_id).toBe(repo2.id);
  });

  it("seals full active shards and creates replacement shards", async () => {
    const original = [seedRepo(), seedRepo(), seedRepo(), seedRepo()];
    for (const repo of original) {
      seedAssignments(repo, 1000);
    }
    const { issueRootfsReleaseArtifactUpload } = await import("./releases");

    const target = await issueRootfsReleaseArtifactUpload({ host_id: HOST_ID });

    expect(original.map((repo) => repo.status)).toEqual([
      "sealed",
      "sealed",
      "sealed",
      "sealed",
    ]);
    const active = repos.filter((repo) => repo.status === "active");
    expect(active).toHaveLength(4);
    expect(active.map((repo) => repo.id)).toContain(target.repo_id);
  });
});
