import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "crypto";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { secrets } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { isValidUUID } from "@cocalc/util/misc";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  parseR2Region,
} from "@cocalc/util/consts";
import { createBucket, deleteObject, listBuckets, R2BucketInfo } from "./r2";
import { ensureCopySchema } from "@cocalc/server/projects/copy-db";
import type {
  HostMachine,
  ProjectBackupConfig,
  ProjectBackupIndexRecord,
  ProjectBackupIndexStoreConfig,
} from "@cocalc/conat/hub/api/hosts";
import { buildLaunchpadRestRusticRepoConfig } from "@cocalc/server/launchpad/rest-repo";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterConfig } from "@cocalc/server/cluster-config";

const DEFAULT_BACKUP_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const DEFAULT_BACKUP_ROOT = "rustic";
const DEFAULT_SHARED_REPO_ROOT_PREFIX = `${DEFAULT_BACKUP_ROOT}/shared`;
const BUCKET_PROVIDER = "r2";
const BUCKET_PURPOSE = "project-backups";
const BUCKET_LIST_CACHE_MS = 30 * 1000;
const BUCKET_VERIFY_TTL_MS = 10 * 60 * 1000;
const PROJECT_BACKUP_REPO_STATUS_ACTIVE = "active";
const PROJECT_BACKUP_REPO_STATUS_SEALED = "sealed";
const PROJECT_BACKUP_REPO_STATUS_DRAINING = "draining";
const PROJECT_BACKUP_REPO_STATUS_DISABLED = "disabled";
const PROJECT_BACKUP_ACTIVE_SHARDS_PER_REGION = 4;
const PROJECT_BACKUP_PROJECTS_PER_SHARD = 500;
const PROJECT_BACKUP_INDEX_STATUS_COMPLETE = "complete";
const PROJECT_BACKUP_INDEX_STATUS_FAILED = "failed";
const PROJECT_BACKUP_INDEX_STORAGE_BACKEND = "r2-object-store";
const PROJECT_BACKUP_INDEX_COMPRESSION = "gzip";
const PROJECT_BACKUP_INDEX_KEY_PREFIX = "project-backup-index/v1";

const logger = getLogger("server:project-backup");
const bucketListCache = new Map<
  string,
  { expires: number; names: Set<string> }
>();
const bucketVerifyCache = new Map<string, number>();

function normalizeLocation(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function pool() {
  return getPool();
}

type PoolClient = {
  query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }>;
  release: () => void;
};

async function getSiteSetting(name: string): Promise<string | undefined> {
  const settings = await getServerSettings();
  const value = (settings as any)[name];
  if (value == null || value === "") {
    return undefined;
  }
  return typeof value === "string" ? value : String(value);
}

async function getR2Settings(): Promise<{
  accountId?: string;
  apiToken?: string;
  accessKey?: string;
  secretKey?: string;
  bucketPrefix?: string;
}> {
  return {
    accountId: await getSiteSetting("r2_account_id"),
    apiToken: await getSiteSetting("r2_api_token"),
    accessKey: await getSiteSetting("r2_access_key_id"),
    secretKey: await getSiteSetting("r2_secret_access_key"),
    bucketPrefix: await getSiteSetting("r2_bucket_prefix"),
  };
}

function asIso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

type BucketRow = {
  id: string;
  name: string;
  provider: string | null;
  purpose: string | null;
  region: string | null;
  location: string | null;
  account_id: string | null;
  access_key_id: string | null;
  secret_access_key: string | null;
  endpoint: string | null;
  status: string | null;
};

type ProjectBackupRepoRow = {
  id: string;
  region: string | null;
  bucket_id: string | null;
  root: string | null;
  secret: string | null;
  status: string | null;
  created: Date | null;
  updated: Date | null;
  assigned_project_count?: number | null;
};

type ProjectBackupRepoAssignmentRow = {
  project_id: string;
  region: string;
  backup_repo_id: string;
  created: Date | null;
  updated: Date | null;
};

type ProjectBackupIndexRow = {
  id: string;
  project_id: string;
  backup_id: string;
  backup_time: Date | null;
  status: string | null;
  storage_backend: string | null;
  bucket_id: string | null;
  object_key: string | null;
  compression: string | null;
  sqlite_bytes: number | null;
  object_bytes: number | null;
  sha256: string | null;
  error: string | null;
  host_id: string | null;
  created: Date | null;
  updated: Date | null;
};

export interface ProjectBackupInfrastructureStatus {
  r2: {
    configured: boolean;
    account_id_configured: boolean;
    access_key_configured: boolean;
    secret_key_configured: boolean;
    bucket_prefix: string | null;
    total_buckets: number;
    active_buckets: number;
    buckets: Array<{
      id: string;
      name: string;
      region: string | null;
      location: string | null;
      status: string | null;
    }>;
  };
  repos: {
    total_repos: number;
    active_repos: number;
    assigned_projects: number;
    repos: Array<{
      id: string;
      region: string | null;
      bucket_id: string | null;
      bucket_name: string | null;
      root: string | null;
      status: string | null;
      assigned_project_count: number;
      created: string | null;
      updated: string | null;
    }>;
  };
  projects: {
    total_projects: number;
    host_assigned_projects: number;
    provisioned_projects: number;
    running_projects: number;
    repo_assigned_projects: number;
    repo_unassigned_projects: number;
    provisioned_up_to_date: number;
    provisioned_needs_backup: number;
    never_backed_up: number;
    latest_last_backup_at: string | null;
  };
}

export interface ProjectBackupShardAdminRepoInfo {
  id: string;
  region: string | null;
  bucket_id: string | null;
  bucket_name: string | null;
  root: string | null;
  status: string | null;
  assigned_project_count: number;
  project_cap: number;
  available_project_slots: number;
  created: string | null;
  updated: string | null;
}

export interface ProjectBackupShardAdminRegionInfo {
  region: string;
  total_repos: number;
  active_repos: number;
  sealed_repos: number;
  draining_repos: number;
  disabled_repos: number;
  assigned_projects: number;
  active_capacity_projects: number;
  active_available_project_slots: number;
}

export interface ProjectBackupShardAdminStatus {
  checked_at: string;
  active_shards_per_region: number;
  projects_per_shard: number;
  authoritative_bay_id: string;
  regions: ProjectBackupShardAdminRegionInfo[];
  repos: ProjectBackupShardAdminRepoInfo[];
}

let projectBackupRepoSchemaReady: Promise<void> | undefined;
let projectBackupIndexSchemaReady: Promise<void> | undefined;

async function ensureProjectBackupRepoSchema(): Promise<void> {
  if (!projectBackupRepoSchemaReady) {
    projectBackupRepoSchemaReady = (async () => {
      await pool().query(`
        CREATE TABLE IF NOT EXISTS project_backup_repos (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          region TEXT NOT NULL,
          bucket_id UUID NOT NULL,
          root TEXT NOT NULL,
          secret TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '${PROJECT_BACKUP_REPO_STATUS_ACTIVE}',
          created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool().query(`
        CREATE TABLE IF NOT EXISTS project_backup_repo_assignments (
          project_id UUID PRIMARY KEY,
          region TEXT NOT NULL,
          backup_repo_id UUID NOT NULL,
          created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool().query(
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS backup_repo_id UUID",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_backup_repos_region_idx ON project_backup_repos(region)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_backup_repos_status_idx ON project_backup_repos(status)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_backup_repos_bucket_idx ON project_backup_repos(bucket_id)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_backup_repo_assignments_region_idx ON project_backup_repo_assignments(region)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_backup_repo_assignments_repo_idx ON project_backup_repo_assignments(backup_repo_id)",
      );
      await pool().query(
        "CREATE UNIQUE INDEX IF NOT EXISTS project_backup_repos_bucket_root_idx ON project_backup_repos(bucket_id, root)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS projects_backup_repo_id_idx ON projects(backup_repo_id)",
      );
    })().catch((err) => {
      projectBackupRepoSchemaReady = undefined;
      throw err;
    });
  }
  await projectBackupRepoSchemaReady;
}

async function ensureProjectBackupIndexSchema(): Promise<void> {
  if (!projectBackupIndexSchemaReady) {
    projectBackupIndexSchemaReady = (async () => {
      await pool().query(`
        CREATE TABLE IF NOT EXISTS project_backup_indexes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID NOT NULL,
          backup_id TEXT NOT NULL,
          backup_time TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL,
          storage_backend TEXT NOT NULL DEFAULT '${PROJECT_BACKUP_INDEX_STORAGE_BACKEND}',
          bucket_id UUID,
          object_key TEXT,
          compression TEXT,
          sqlite_bytes BIGINT,
          object_bytes BIGINT,
          sha256 TEXT,
          error TEXT,
          host_id UUID,
          created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_backup_indexes_project_id_idx ON project_backup_indexes(project_id)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_backup_indexes_status_idx ON project_backup_indexes(status)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_backup_indexes_bucket_id_idx ON project_backup_indexes(bucket_id)",
      );
      await pool().query(
        "CREATE INDEX IF NOT EXISTS project_backup_indexes_host_id_idx ON project_backup_indexes(host_id)",
      );
      await pool().query(
        "CREATE UNIQUE INDEX IF NOT EXISTS project_backup_indexes_project_backup_idx ON project_backup_indexes(project_id, backup_id)",
      );
    })().catch((err) => {
      projectBackupIndexSchemaReady = undefined;
      throw err;
    });
  }
  await projectBackupIndexSchemaReady;
}

async function loadBucketById(id: string): Promise<BucketRow | null> {
  const { rows } = await pool().query<BucketRow>(
    "SELECT id, name, provider, purpose, region, location, account_id, access_key_id, secret_access_key, endpoint, status FROM buckets WHERE id=$1",
    [id],
  );
  return rows[0] ?? null;
}

async function loadBucketByName(name: string): Promise<BucketRow | null> {
  const { rows } = await pool().query<BucketRow>(
    "SELECT id, name, provider, purpose, region, location, account_id, access_key_id, secret_access_key, endpoint, status FROM buckets WHERE name=$1 ORDER BY created DESC LIMIT 1",
    [name],
  );
  return rows[0] ?? null;
}

async function loadProjectBackupRepoById(
  id: string,
): Promise<ProjectBackupRepoRow | null> {
  await ensureProjectBackupRepoSchema();
  const { rows } = await pool().query<ProjectBackupRepoRow>(
    `SELECT
      id,
      region,
      bucket_id,
      root,
      secret,
      status,
      created,
      updated
    FROM project_backup_repos
    WHERE id=$1
    LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

function normalizeBackupRegion(region?: string | null): string {
  return (
    parseR2Region(region) ??
    mapCloudRegionToR2Region(region ?? DEFAULT_R2_REGION)
  );
}

function nextSharedRepoRoot({
  region,
  existingCount,
  repoId,
}: {
  region: string;
  existingCount: number;
  repoId: string;
}): string {
  const serial = String(existingCount + 1).padStart(4, "0");
  // Include the repo id so a rebuilt DB never reuses an old object-store repo.
  return `${DEFAULT_SHARED_REPO_ROOT_PREFIX}-${region}-${serial}-${repoId}`;
}

async function loadProjectBackupRepoAssignmentTx(
  client: PoolClient,
  project_id: string,
): Promise<ProjectBackupRepoAssignmentRow | null> {
  const { rows } = await client.query<ProjectBackupRepoAssignmentRow>(
    `SELECT project_id, region, backup_repo_id, created, updated
     FROM project_backup_repo_assignments
     WHERE project_id=$1
     LIMIT 1`,
    [project_id],
  );
  return rows[0] ?? null;
}

async function listProjectBackupReposForRegionTx(
  client: PoolClient,
  region: string,
  statuses?: string[],
): Promise<ProjectBackupRepoRow[]> {
  const filters: string[] = ["r.region=$1"];
  const params: any[] = [region];
  if (statuses?.length) {
    params.push(statuses);
    filters.push(
      `COALESCE(r.status, '${PROJECT_BACKUP_REPO_STATUS_ACTIVE}') = ANY($${params.length}::text[])`,
    );
  }
  const { rows } = await client.query<ProjectBackupRepoRow>(
    `SELECT
      r.id,
      r.region,
      r.bucket_id,
      r.root,
      r.secret,
      r.status,
      r.created,
      r.updated,
      COUNT(a.project_id)::INTEGER AS assigned_project_count
    FROM project_backup_repos r
    LEFT JOIN project_backup_repo_assignments a
      ON a.backup_repo_id = r.id
    WHERE ${filters.join(" AND ")}
    GROUP BY
      r.id,
      r.region,
      r.bucket_id,
      r.root,
      r.secret,
      r.status,
      r.created,
      r.updated
    ORDER BY COUNT(a.project_id) ASC, r.created ASC, r.id ASC`,
    params,
  );
  return rows;
}

async function loadProjectBackupRepoByIdTx(
  client: PoolClient,
  id: string,
): Promise<ProjectBackupRepoRow | null> {
  const { rows } = await client.query<ProjectBackupRepoRow>(
    `SELECT
      r.id,
      r.region,
      r.bucket_id,
      r.root,
      r.secret,
      r.status,
      r.created,
      r.updated,
      COUNT(a.project_id)::INTEGER AS assigned_project_count
    FROM project_backup_repos r
    LEFT JOIN project_backup_repo_assignments a
      ON a.backup_repo_id = r.id
    WHERE r.id=$1
    GROUP BY
      r.id,
      r.region,
      r.bucket_id,
      r.root,
      r.secret,
      r.status,
      r.created,
      r.updated
    LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function createProjectBackupRepoTx({
  client,
  region,
  bucket,
}: {
  client: PoolClient;
  region: string;
  bucket: BucketRow;
}): Promise<ProjectBackupRepoRow> {
  const masterKey = await getBackupMasterKey();
  const sharedSecret = randomBytes(32).toString("base64url");
  const encryptedSecret = encryptBackupSecret(sharedSecret, masterKey);
  const repoId = randomUUID();
  const { rows: existing } = await client.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM project_backup_repos WHERE region=$1",
    [region],
  );
  const root = nextSharedRepoRoot({
    region,
    existingCount: existing[0]?.count ?? 0,
    repoId,
  });
  const { rows } = await client.query<ProjectBackupRepoRow>(
    `INSERT INTO project_backup_repos
      (id, region, bucket_id, root, secret, status, created, updated)
    VALUES
      ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    RETURNING
      id,
      region,
      bucket_id,
      root,
      secret,
      status,
      created,
      updated`,
    [
      repoId,
      region,
      bucket.id,
      root,
      encryptedSecret,
      PROJECT_BACKUP_REPO_STATUS_ACTIVE,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("failed to create shared project backup repository");
  }
  return row;
}

async function withProjectBackupRegionAssignmentLock<T>(
  region: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await ensureProjectBackupRepoSchema();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `project-backup-shards:${region}`,
    ]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function ensureActiveProjectBackupReposForRegionTx({
  client,
  region,
  bucket,
}: {
  client: PoolClient;
  region: string;
  bucket: BucketRow;
}): Promise<ProjectBackupRepoRow[]> {
  let active = await listProjectBackupReposForRegionTx(client, region, [
    PROJECT_BACKUP_REPO_STATUS_ACTIVE,
  ]);
  while (active.length < PROJECT_BACKUP_ACTIVE_SHARDS_PER_REGION) {
    await createProjectBackupRepoTx({ client, region, bucket });
    active = await listProjectBackupReposForRegionTx(client, region, [
      PROJECT_BACKUP_REPO_STATUS_ACTIVE,
    ]);
  }
  return active;
}

async function sealProjectBackupReposTx(
  client: PoolClient,
  repo_ids: string[],
): Promise<void> {
  const ids = (repo_ids ?? []).filter(Boolean);
  if (!ids.length) return;
  await client.query(
    `UPDATE project_backup_repos
     SET status=$2, updated=NOW()
     WHERE id = ANY($1::uuid[])`,
    [ids, PROJECT_BACKUP_REPO_STATUS_SEALED],
  );
}

function projectBackupRepoHasCapacity(repo: ProjectBackupRepoRow): boolean {
  return (
    Number(repo.assigned_project_count ?? 0) < PROJECT_BACKUP_PROJECTS_PER_SHARD
  );
}

function projectBackupRepoCanAcceptExistingAssignment(
  repo: ProjectBackupRepoRow,
): boolean {
  return repo.status !== PROJECT_BACKUP_REPO_STATUS_DISABLED;
}

async function selectProjectBackupRepoForAssignmentLocal({
  project_id,
  project_region,
  backup_repo_id,
  preferred_backup_repo_id,
}: {
  project_id: string;
  project_region: string;
  backup_repo_id?: string | null;
  preferred_backup_repo_id?: string | null;
}): Promise<{ repo: ProjectBackupRepoRow; bucket: BucketRow } | null> {
  const region = normalizeBackupRegion(project_region);
  const bucket = await getOrCreateBucketForRegion(region);
  if (!bucket) return null;
  await ensureExistingBucketRowIsUsable({
    bucket,
    fallbackRegion: region,
  });
  return await withProjectBackupRegionAssignmentLock(region, async (client) => {
    const existingAssignment = await loadProjectBackupRepoAssignmentTx(
      client,
      project_id,
    );
    if (
      existingAssignment?.backup_repo_id &&
      existingAssignment.region === region
    ) {
      const existingRepo = await loadProjectBackupRepoByIdTx(
        client,
        existingAssignment.backup_repo_id,
      );
      if (
        existingRepo &&
        projectBackupRepoCanAcceptExistingAssignment(existingRepo)
      ) {
        return { repo: existingRepo, bucket };
      }
    }

    if (backup_repo_id) {
      const existingRepo = await loadProjectBackupRepoByIdTx(
        client,
        backup_repo_id,
      );
      if (
        existingRepo &&
        normalizeBackupRegion(existingRepo.region) === region &&
        projectBackupRepoCanAcceptExistingAssignment(existingRepo)
      ) {
        return { repo: existingRepo, bucket };
      }
    }

    let active = await ensureActiveProjectBackupReposForRegionTx({
      client,
      region,
      bucket,
    });
    let activeWithCapacity = active.filter(projectBackupRepoHasCapacity);
    if (!activeWithCapacity.length) {
      await sealProjectBackupReposTx(
        client,
        active
          .filter((repo) => !projectBackupRepoHasCapacity(repo))
          .map((repo) => repo.id),
      );
      active = await ensureActiveProjectBackupReposForRegionTx({
        client,
        region,
        bucket,
      });
      activeWithCapacity = active.filter(projectBackupRepoHasCapacity);
    }

    if (preferred_backup_repo_id) {
      const preferred = activeWithCapacity.find(
        (repo) => repo.id === preferred_backup_repo_id,
      );
      if (preferred) {
        return { repo: preferred, bucket };
      }
    }

    const candidate = activeWithCapacity[0];
    if (!candidate) {
      return null;
    }
    return { repo: candidate, bucket };
  });
}

async function listBucketsCached(
  accountId: string,
  apiToken: string,
  force = false,
): Promise<Set<string>> {
  const now = Date.now();
  if (!force) {
    const cached = bucketListCache.get(accountId);
    if (cached && cached.expires > now) {
      return cached.names;
    }
  }
  const names = new Set(await listBuckets(apiToken, accountId));
  bucketListCache.set(accountId, {
    names,
    expires: now + BUCKET_LIST_CACHE_MS,
  });
  return names;
}

function inferBucketRegion(name: string): string | undefined {
  const i = name.lastIndexOf("-");
  if (i <= 0) return undefined;
  return parseR2Region(name.slice(i + 1)) ?? undefined;
}

function isAlreadyExistsError(err: string): boolean {
  const lower = err.toLowerCase();
  return (
    lower.includes("409 conflict") ||
    lower.includes("status code 409") ||
    lower.includes("http 409") ||
    lower.includes("conflict") ||
    lower.includes("already exists") ||
    lower.includes("already in use") ||
    lower.includes("bucketexists")
  );
}

async function ensureBucketExistsInR2({
  accountId,
  apiToken,
  name,
  region,
}: {
  accountId: string;
  apiToken: string;
  name: string;
  region: string;
}) {
  const verifyKey = `${accountId}:${name}`;
  const now = Date.now();
  if ((bucketVerifyCache.get(verifyKey) ?? 0) + BUCKET_VERIFY_TTL_MS > now) {
    return;
  }
  let names = await listBucketsCached(accountId, apiToken);
  if (!names.has(name)) {
    let createdNow = false;
    let alreadyExisted = false;
    try {
      await createBucket(apiToken, accountId, name, region);
      createdNow = true;
      logger.info("r2 bucket created", { name, region });
    } catch (err) {
      if (!isAlreadyExistsError(`${err}`)) {
        throw err;
      }
      alreadyExisted = true;
    }
    names = await listBucketsCached(accountId, apiToken, true);
    if (!names.has(name)) {
      if (createdNow || alreadyExisted) {
        if (alreadyExisted) {
          logger.warn(
            "r2 bucket verify list omitted bucket after already-exists conflict; assuming bucket is usable",
            { account_id: accountId, name, region },
          );
        }
        names.add(name);
        bucketListCache.set(accountId, {
          names,
          expires: now + BUCKET_LIST_CACHE_MS,
        });
      } else {
        throw new Error(
          `bucket '${name}' is not present in account '${accountId}' after ensure`,
        );
      }
    }
  }
  bucketVerifyCache.set(verifyKey, now);
}

async function findBucketForRegion(region: string): Promise<BucketRow | null> {
  const { rows } = await pool().query<BucketRow>(
    "SELECT id, name, provider, purpose, region, location, account_id, access_key_id, secret_access_key, endpoint, status FROM buckets WHERE provider=$1 AND purpose=$2 AND region=$3 AND (status IS NULL OR status != 'disabled') ORDER BY created DESC LIMIT 1",
    [BUCKET_PROVIDER, BUCKET_PURPOSE, region],
  );
  const row = rows[0];
  if (!row) return null;
  const normalizedLocation = normalizeLocation(row.location ?? null);
  const normalizedRegion = normalizeLocation(row.region ?? null);
  const desiredStatus =
    normalizedLocation &&
    normalizedRegion &&
    normalizedLocation !== normalizedRegion
      ? "mismatch"
      : normalizedLocation
        ? "active"
        : "unknown";
  if (
    normalizedLocation !== row.location ||
    (row.status ?? "unknown") !== desiredStatus
  ) {
    await pool().query(
      "UPDATE buckets SET location=$2, status=$3, updated=NOW() WHERE id=$1",
      [row.id, normalizedLocation, desiredStatus],
    );
    return { ...row, location: normalizedLocation, status: desiredStatus };
  }
  return row;
}

async function insertBucketRecord({
  accountId,
  accessKey,
  secretKey,
  bucketPrefix,
  region,
  created,
}: {
  accountId: string;
  accessKey: string;
  secretKey: string;
  bucketPrefix: string;
  region: string;
  created?: R2BucketInfo;
}): Promise<BucketRow> {
  const name = `${bucketPrefix}-${region}`;
  const location = normalizeLocation(created?.location ?? null);
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const status =
    location && location !== region
      ? "mismatch"
      : location
        ? "active"
        : "unknown";
  await pool().query(
    "INSERT INTO buckets (id, provider, purpose, region, location, name, account_id, access_key_id, secret_access_key, endpoint, status, created, updated) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW()) ON CONFLICT (name) DO NOTHING",
    [
      BUCKET_PROVIDER,
      BUCKET_PURPOSE,
      region,
      location,
      name,
      accountId,
      accessKey,
      secretKey,
      endpoint,
      status,
    ],
  );
  const row = await loadBucketByName(name);
  const rows = row ? [row] : [];
  if (!rows[0]) {
    throw new Error(`failed to record bucket ${name}`);
  }
  return rows[0];
}

async function getOrCreateBucketForRegion(
  region: string,
): Promise<BucketRow | null> {
  const existing = await findBucketForRegion(region);
  const { accountId, apiToken, accessKey, secretKey, bucketPrefix } =
    await getR2Settings();

  if (!accountId || !accessKey || !secretKey || !bucketPrefix) {
    return existing;
  }

  const desiredName = `${bucketPrefix}-${region}`;
  let desired = await loadBucketByName(desiredName);
  if (!desired && existing?.name === desiredName) {
    desired = existing;
  }

  if (!apiToken) {
    logger.warn("r2_api_token is missing; cannot verify/create bucket", {
      region,
      bucket: desiredName,
    });
    return desired ?? existing;
  }

  let created: R2BucketInfo | undefined;
  await ensureBucketExistsInR2({
    accountId,
    apiToken,
    name: desiredName,
    region,
  });

  if (!desired) {
    created = {
      name: desiredName,
      location: region,
    };
  }

  return await insertBucketRecord({
    accountId,
    accessKey,
    secretKey,
    bucketPrefix,
    region,
    created,
  });
}

export async function ensureProjectBackupBucketForRegion(
  region: string,
): Promise<{
  id: string;
  name: string;
  purpose: string | null;
  region: string | null;
  endpoint: string | null;
  access_key_id: string | null;
  secret_access_key: string | null;
  status: string | null;
} | null> {
  const normalized = parseR2Region(region) ?? mapCloudRegionToR2Region(region);
  return await getOrCreateBucketForRegion(normalized);
}

async function ensureExistingBucketRowIsUsable({
  bucket,
  fallbackRegion,
}: {
  bucket: BucketRow;
  fallbackRegion: string;
}): Promise<void> {
  const { accountId, apiToken } = await getR2Settings();
  if (!accountId || !apiToken) {
    return;
  }
  const region =
    parseR2Region(bucket.region) ??
    inferBucketRegion(bucket.name) ??
    fallbackRegion;
  await ensureBucketExistsInR2({
    accountId,
    apiToken,
    name: bucket.name,
    region,
  });
}

async function getProjectBackupAssignment(project_id: string): Promise<{
  backup_repo_id: string | null;
}> {
  await ensureProjectBackupRepoSchema();
  const { rows } = await pool().query<{ backup_repo_id: string | null }>(
    "SELECT backup_repo_id FROM projects WHERE project_id=$1",
    [project_id],
  );
  return {
    backup_repo_id: rows[0]?.backup_repo_id ?? null,
  };
}

export async function getProjectBackupAssignmentState(
  project_id: string,
): Promise<{
  backup_repo_id: string | null;
  host_id: string | null;
  region: string;
}> {
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  const { rows } = await pool().query<{
    backup_repo_id: string | null;
    host_id: string | null;
    region: string | null;
  }>(
    "SELECT backup_repo_id, host_id, region FROM projects WHERE project_id=$1",
    [project_id],
  );
  if (!rows[0]) {
    throw new Error("project not found");
  }
  return {
    backup_repo_id: rows[0].backup_repo_id ?? null,
    host_id: rows[0].host_id ?? null,
    region:
      parseR2Region(rows[0].region) ??
      mapCloudRegionToR2Region(rows[0].region ?? DEFAULT_R2_REGION),
  };
}

async function assignProjectBackupRepo({
  project_id,
  region,
  repo,
}: {
  project_id: string;
  region: string;
  repo: ProjectBackupRepoRow;
}): Promise<void> {
  await ensureProjectBackupRepoSchema();
  const normalizedRegion = normalizeBackupRegion(region);
  await pool().query(
    `INSERT INTO project_backup_repo_assignments
      (project_id, region, backup_repo_id, created, updated)
     VALUES ($1,$2,$3,NOW(),NOW())
     ON CONFLICT (project_id) DO UPDATE SET
       region = EXCLUDED.region,
       backup_repo_id = EXCLUDED.backup_repo_id,
       updated = NOW()`,
    [project_id, normalizedRegion, repo.id],
  );
  await pool().query(
    "UPDATE projects SET backup_repo_id=$2 WHERE project_id=$1",
    [project_id, repo.id],
  );
}

async function releaseProjectBackupRepoAssignmentLocal({
  project_id,
  clear_local_backup_repo_id = false,
}: {
  project_id: string;
  clear_local_backup_repo_id?: boolean;
}): Promise<void> {
  await ensureProjectBackupRepoSchema();
  await pool().query(
    "DELETE FROM project_backup_repo_assignments WHERE project_id=$1",
    [project_id],
  );
  if (clear_local_backup_repo_id) {
    await pool().query(
      "UPDATE projects SET backup_repo_id=NULL WHERE project_id=$1",
      [project_id],
    );
  }
}

export async function setProjectBackupRepoId({
  project_id,
  backup_repo_id,
}: {
  project_id: string;
  backup_repo_id: string | null;
}): Promise<void> {
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  if (backup_repo_id && !isValidUUID(backup_repo_id)) {
    throw new Error("invalid backup_repo_id");
  }
  await ensureProjectBackupRepoSchema();
  if (backup_repo_id) {
    const repo = await loadProjectBackupRepoById(backup_repo_id);
    if (repo) {
      await pool().query(
        `INSERT INTO project_backup_repo_assignments
          (project_id, region, backup_repo_id, created, updated)
         VALUES ($1,$2,$3,NOW(),NOW())
         ON CONFLICT (project_id) DO UPDATE SET
           region = EXCLUDED.region,
           backup_repo_id = EXCLUDED.backup_repo_id,
           updated = NOW()`,
        [project_id, normalizeBackupRegion(repo.region), backup_repo_id],
      );
    }
  } else {
    await pool().query(
      "DELETE FROM project_backup_repo_assignments WHERE project_id=$1",
      [project_id],
    );
  }
  await pool().query(
    "UPDATE projects SET backup_repo_id=$2 WHERE project_id=$1",
    [project_id, backup_repo_id],
  );
}

export async function resolveProjectBackupRepoAssignment({
  project_id,
  project_region,
  backup_repo_id,
  preferred_backup_repo_id,
}: {
  project_id: string;
  project_region?: string | null;
  backup_repo_id?: string | null;
  preferred_backup_repo_id?: string | null;
}): Promise<{ backup_repo_id: string | null }> {
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  if (backup_repo_id && !isValidUUID(backup_repo_id)) {
    throw new Error("invalid backup_repo_id");
  }
  if (preferred_backup_repo_id && !isValidUUID(preferred_backup_repo_id)) {
    throw new Error("invalid preferred_backup_repo_id");
  }
  const region = normalizeBackupRegion(project_region);
  if (shouldUseSeedManagedProjectBackups()) {
    const cluster = getClusterConfig();
    const { getInterBayBridge } =
      await import("@cocalc/server/inter-bay/bridge");
    const result = await getInterBayBridge()
      .hostConnection(cluster.seed_bay_id, { timeout_ms: 30_000 })
      .resolveSeedBackupRepoAssignment({
        project_id,
        project_region: region,
        backup_repo_id,
        preferred_backup_repo_id,
      });
    await pool().query(
      "UPDATE projects SET backup_repo_id=$2 WHERE project_id=$1 AND backup_repo_id IS DISTINCT FROM $2",
      [project_id, result.backup_repo_id],
    );
    return result;
  }
  const assigned = await selectProjectBackupRepoForAssignmentLocal({
    project_id,
    project_region: region,
    backup_repo_id,
    preferred_backup_repo_id,
  });
  if (!assigned?.repo) {
    return { backup_repo_id: null };
  }
  await assignProjectBackupRepo({
    project_id,
    region,
    repo: assigned.repo,
  });
  return {
    backup_repo_id: assigned.repo.id,
  };
}

export async function releaseProjectBackupRepoAssignment({
  project_id,
  clear_local_backup_repo_id = false,
}: {
  project_id: string;
  clear_local_backup_repo_id?: boolean;
}): Promise<void> {
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  if (shouldUseSeedManagedProjectBackups()) {
    const cluster = getClusterConfig();
    const { getInterBayBridge } =
      await import("@cocalc/server/inter-bay/bridge");
    await getInterBayBridge()
      .hostConnection(cluster.seed_bay_id, { timeout_ms: 30_000 })
      .releaseSeedBackupRepoAssignment({
        project_id,
      });
    if (clear_local_backup_repo_id) {
      await pool().query(
        "UPDATE projects SET backup_repo_id=NULL WHERE project_id=$1",
        [project_id],
      );
    }
    return;
  }
  await releaseProjectBackupRepoAssignmentLocal({
    project_id,
    clear_local_backup_repo_id,
  });
}

export async function ensureProjectBackupRepoForRegion({
  region,
}: {
  region: string;
}): Promise<{ backup_repo_id: string | null }> {
  const normalized = normalizeBackupRegion(region);
  const bucket = await getOrCreateBucketForRegion(normalized);
  if (!bucket) {
    return { backup_repo_id: null };
  }
  const assigned = await withProjectBackupRegionAssignmentLock(
    normalized,
    async (client) => {
      const active = await ensureActiveProjectBackupReposForRegionTx({
        client,
        region: normalized,
        bucket,
      });
      return active[0] ?? null;
    },
  );
  return {
    backup_repo_id: assigned?.id ?? null,
  };
}

export async function setProjectBackupRegion({
  project_id,
  region,
}: {
  project_id: string;
  region: string;
}): Promise<void> {
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  const normalized =
    parseR2Region(region) ??
    mapCloudRegionToR2Region(region ?? DEFAULT_R2_REGION);
  await pool().query("UPDATE projects SET region=$2 WHERE project_id=$1", [
    project_id,
    normalized,
  ]);
}

async function resolveProjectRegion(
  project_id: string,
  hostRegion?: string | null,
): Promise<string> {
  const { rows } = await pool().query<{ region: string | null }>(
    "SELECT region FROM projects WHERE project_id=$1",
    [project_id],
  );
  if (!rows[0]) {
    throw new Error("project not found");
  }
  const stored = rows[0].region ?? null;
  const parsed = parseR2Region(stored);
  if (parsed) return parsed;

  const mapped = mapCloudRegionToR2Region(hostRegion ?? DEFAULT_R2_REGION);
  await pool().query("UPDATE projects SET region=$2 WHERE project_id=$1", [
    project_id,
    mapped,
  ]);
  return mapped;
}

async function getProjectBackupRepoSecret(
  repo: Pick<ProjectBackupRepoRow, "secret" | "id">,
): Promise<string> {
  if (!repo.secret) {
    throw new Error(`project backup repo ${repo.id} has no secret`);
  }
  return decryptBackupSecret(repo.secret, await getBackupMasterKey());
}

export async function getProjectBackupConfigForRepo({
  backup_repo_id,
  region,
}: {
  backup_repo_id?: string | null;
  region?: string | null;
}): Promise<{ toml: string }> {
  if (backup_repo_id && !isValidUUID(backup_repo_id)) {
    throw new Error("invalid backup_repo_id");
  }
  if (!backup_repo_id) {
    return { toml: "" };
  }
  const repo = await loadProjectBackupRepoById(backup_repo_id);
  if (!repo) {
    return { toml: "" };
  }
  const config = await buildBackupConfigFromRepo({
    repo,
    fallbackRegion:
      parseR2Region(region) ??
      parseR2Region(repo.region) ??
      mapCloudRegionToR2Region(region ?? repo.region ?? DEFAULT_R2_REGION),
  });
  return { toml: config.toml };
}

const backupMasterKeyPath = join(secrets, "backup-master-key");
const backupSharedSecretPath = join(secrets, "backup-shared-secret");
let backupMasterKey: Buffer | undefined;
let backupSharedSecret: string | undefined;

async function getBackupMasterKey(): Promise<Buffer> {
  if (backupMasterKey) return backupMasterKey;
  let encoded = "";
  try {
    encoded = (await readFile(backupMasterKeyPath, "utf8")).trim();
  } catch {}
  if (!encoded) {
    encoded = randomBytes(32).toString("base64");
    try {
      await writeFile(backupMasterKeyPath, encoded, { mode: 0o600 });
    } catch (err) {
      throw new Error(`failed to write backup master key: ${err}`);
    }
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("invalid backup master key length");
  }
  backupMasterKey = key;
  return key;
}

async function getSharedBackupSecret(): Promise<string> {
  if (backupSharedSecret) return backupSharedSecret;
  let encoded = "";
  try {
    encoded = (await readFile(backupSharedSecretPath, "utf8")).trim();
  } catch {}
  if (!encoded) {
    encoded = randomBytes(32).toString("base64url");
    try {
      await writeFile(backupSharedSecretPath, encoded, { mode: 0o600 });
    } catch (err) {
      throw new Error(`failed to write backup shared secret: ${err}`);
    }
  }
  backupSharedSecret = encoded;
  return encoded;
}

function encryptBackupSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptBackupSecret(encoded: string, key: Buffer): string {
  if (!encoded.startsWith("v1:")) return encoded;
  const [, ivB64, tagB64, dataB64] = encoded.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("invalid backup secret format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

export async function recordProjectBackup({
  host_id,
  project_id,
  time,
}: {
  host_id?: string;
  project_id: string;
  time?: Date | string;
}): Promise<void> {
  if (!host_id || !isValidUUID(host_id)) {
    throw new Error("invalid host_id");
  }
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  await assertHostProjectAccess(host_id, project_id);

  let recordedAt = time ? new Date(time) : new Date();
  if (Number.isNaN(recordedAt.getTime())) {
    recordedAt = new Date();
  }
  await pool().query("UPDATE projects SET last_backup=$2 WHERE project_id=$1", [
    project_id,
    recordedAt,
  ]);
}

function mapProjectBackupIndexRow(
  row: ProjectBackupIndexRow,
): ProjectBackupIndexRecord {
  return {
    backup_id: row.backup_id,
    backup_time: asIso(row.backup_time) ?? new Date(0).toISOString(),
    status:
      row.status === PROJECT_BACKUP_INDEX_STATUS_FAILED
        ? "failed"
        : PROJECT_BACKUP_INDEX_STATUS_COMPLETE,
    storage_backend: "r2-object-store",
    bucket_id: row.bucket_id,
    object_key: row.object_key,
    compression: row.compression,
    sqlite_bytes:
      row.sqlite_bytes == null ? null : Number(row.sqlite_bytes ?? null),
    object_bytes:
      row.object_bytes == null ? null : Number(row.object_bytes ?? null),
    sha256: row.sha256,
    error: row.error,
    host_id: row.host_id,
    created: asIso(row.created),
    updated: asIso(row.updated),
  };
}

async function getProjectBackupIndexBucket({
  project_id,
}: {
  project_id: string;
}): Promise<BucketRow | null> {
  const assignment = await getProjectBackupAssignment(project_id);
  let repo: ProjectBackupRepoRow | null = null;
  if (assignment.backup_repo_id) {
    repo = await loadProjectBackupRepoById(assignment.backup_repo_id);
  }
  if (!repo) {
    const projectRegion = await resolveProjectRegion(project_id, null);
    const resolved = await resolveProjectBackupRepoAssignment({
      project_id,
      project_region: projectRegion,
      backup_repo_id: assignment.backup_repo_id,
    });
    if (!resolved.backup_repo_id) {
      return null;
    }
    repo = await loadProjectBackupRepoById(resolved.backup_repo_id);
  }
  if (!repo || !repo.bucket_id) {
    return null;
  }
  return await loadBucketById(repo.bucket_id);
}

async function deleteProjectBackupIndexObject(
  row: ProjectBackupIndexRow,
): Promise<void> {
  if (!row.bucket_id || !row.object_key) {
    return;
  }
  const bucket = await loadBucketById(row.bucket_id);
  if (!bucket?.name) {
    return;
  }
  const accountId =
    (await getSiteSetting("r2_account_id")) ?? bucket.account_id;
  const accessKey =
    (await getSiteSetting("r2_access_key_id")) ?? bucket.access_key_id;
  const secretKey =
    (await getSiteSetting("r2_secret_access_key")) ?? bucket.secret_access_key;
  const endpoint =
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined) ??
    bucket.endpoint;
  if (!accessKey || !secretKey || !endpoint) {
    logger.warn("backup index object delete skipped: missing bucket config", {
      bucket_id: row.bucket_id,
      backup_id: row.backup_id,
      object_key: row.object_key,
    });
    return;
  }
  await deleteObject({
    endpoint,
    accessKey,
    secretKey,
    bucket: bucket.name,
    key: row.object_key,
  });
}

export async function recordProjectBackupIndex({
  host_id,
  project_id,
  backup_id,
  backup_time,
  status,
  storage_backend = "r2-object-store",
  object_key,
  compression,
  sqlite_bytes,
  object_bytes,
  sha256,
  error,
}: {
  host_id?: string;
  project_id: string;
  backup_id: string;
  backup_time: Date | string;
  status: "complete" | "failed";
  storage_backend?: "r2-object-store";
  object_key?: string | null;
  compression?: string | null;
  sqlite_bytes?: number | null;
  object_bytes?: number | null;
  sha256?: string | null;
  error?: string | null;
}): Promise<void> {
  if (!host_id || !isValidUUID(host_id)) {
    throw new Error("invalid host_id");
  }
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  if (!backup_id) {
    throw new Error("backup_id must be specified");
  }
  await assertHostProjectAccess(host_id, project_id);
  await ensureProjectBackupIndexSchema();
  const bucket = await getProjectBackupIndexBucket({ project_id });
  let recordedAt = backup_time ? new Date(backup_time) : new Date();
  if (Number.isNaN(recordedAt.getTime())) {
    recordedAt = new Date();
  }
  await pool().query(
    `INSERT INTO project_backup_indexes (
      project_id, backup_id, backup_time, status, storage_backend, bucket_id,
      object_key, compression, sqlite_bytes, object_bytes, sha256, error, host_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (project_id, backup_id) DO UPDATE SET
      backup_time = EXCLUDED.backup_time,
      status = EXCLUDED.status,
      storage_backend = EXCLUDED.storage_backend,
      bucket_id = EXCLUDED.bucket_id,
      object_key = EXCLUDED.object_key,
      compression = EXCLUDED.compression,
      sqlite_bytes = EXCLUDED.sqlite_bytes,
      object_bytes = EXCLUDED.object_bytes,
      sha256 = EXCLUDED.sha256,
      error = EXCLUDED.error,
      host_id = EXCLUDED.host_id,
      updated = NOW()`,
    [
      project_id,
      backup_id,
      recordedAt,
      status === "failed"
        ? PROJECT_BACKUP_INDEX_STATUS_FAILED
        : PROJECT_BACKUP_INDEX_STATUS_COMPLETE,
      storage_backend,
      bucket?.id ?? null,
      object_key ?? null,
      compression ?? null,
      sqlite_bytes ?? null,
      object_bytes ?? null,
      sha256 ?? null,
      error ?? null,
      host_id,
    ],
  );
}

export async function getProjectBackupIndexes({
  host_id,
  project_id,
}: {
  host_id?: string;
  project_id: string;
}): Promise<ProjectBackupIndexRecord[]> {
  if (!host_id || !isValidUUID(host_id)) {
    throw new Error("invalid host_id");
  }
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  await assertHostProjectAccess(host_id, project_id);
  await ensureProjectBackupIndexSchema();
  const { rows } = await pool().query<ProjectBackupIndexRow>(
    `SELECT
      id, project_id, backup_id, backup_time, status, storage_backend, bucket_id,
      object_key, compression, sqlite_bytes, object_bytes, sha256, error, host_id,
      created, updated
    FROM project_backup_indexes
    WHERE project_id=$1
    ORDER BY backup_time ASC, created ASC`,
    [project_id],
  );
  return rows.map(mapProjectBackupIndexRow);
}

export async function syncProjectBackupIndexes({
  host_id,
  project_id,
  backup_ids,
}: {
  host_id?: string;
  project_id: string;
  backup_ids: string[];
}): Promise<void> {
  if (!host_id || !isValidUUID(host_id)) {
    throw new Error("invalid host_id");
  }
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  await assertHostProjectAccess(host_id, project_id);
  await ensureProjectBackupIndexSchema();
  const keep = new Set((backup_ids ?? []).filter(Boolean));
  const { rows } = await pool().query<ProjectBackupIndexRow>(
    `SELECT
      id, project_id, backup_id, backup_time, status, storage_backend, bucket_id,
      object_key, compression, sqlite_bytes, object_bytes, sha256, error, host_id,
      created, updated
    FROM project_backup_indexes
    WHERE project_id=$1`,
    [project_id],
  );
  for (const row of rows) {
    if (keep.has(row.backup_id)) {
      continue;
    }
    try {
      await deleteProjectBackupIndexObject(row);
    } catch (err) {
      logger.warn("backup index object cleanup failed during sync", {
        project_id,
        backup_id: row.backup_id,
        err: `${err}`,
      });
    }
  }
  if (keep.size === 0) {
    await pool().query(
      "DELETE FROM project_backup_indexes WHERE project_id=$1",
      [project_id],
    );
    return;
  }
  await pool().query(
    "DELETE FROM project_backup_indexes WHERE project_id=$1 AND NOT (backup_id = ANY($2::text[]))",
    [project_id, Array.from(keep)],
  );
}

export async function deleteProjectBackupIndex({
  host_id,
  project_id,
  backup_id,
}: {
  host_id?: string;
  project_id: string;
  backup_id: string;
}): Promise<void> {
  if (!host_id || !isValidUUID(host_id)) {
    throw new Error("invalid host_id");
  }
  if (!isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  if (!backup_id) {
    throw new Error("backup_id must be specified");
  }
  await assertHostProjectAccess(host_id, project_id);
  await ensureProjectBackupIndexSchema();
  const { rows } = await pool().query<ProjectBackupIndexRow>(
    `SELECT
      id, project_id, backup_id, backup_time, status, storage_backend, bucket_id,
      object_key, compression, sqlite_bytes, object_bytes, sha256, error, host_id,
      created, updated
    FROM project_backup_indexes
    WHERE project_id=$1 AND backup_id=$2
    LIMIT 1`,
    [project_id, backup_id],
  );
  const row = rows[0];
  if (row) {
    try {
      await deleteProjectBackupIndexObject(row);
    } catch (err) {
      logger.warn("backup index object delete failed", {
        project_id,
        backup_id,
        err: `${err}`,
      });
    }
  }
  await pool().query(
    "DELETE FROM project_backup_indexes WHERE project_id=$1 AND backup_id=$2",
    [project_id, backup_id],
  );
}

function isSelfHostLocalMachine(machine: HostMachine): boolean {
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  return machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
}

async function buildSelfHostLocalBackupConfig(): Promise<{
  toml: string;
  ttl_seconds: number;
  index_store?: ProjectBackupIndexStoreConfig | null;
}> {
  const repo = await buildLaunchpadRestRusticRepoConfig({
    root: DEFAULT_BACKUP_ROOT,
    password: await getSharedBackupSecret(),
  });
  if (!repo) {
    return { toml: "", ttl_seconds: 0 };
  }
  return { toml: repo.repo_toml, ttl_seconds: DEFAULT_BACKUP_TTL_SECONDS };
}

function buildS3ProjectBackupToml({
  endpoint,
  bucket,
  accessKey,
  secretKey,
  password,
  root,
}: {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  password: string;
  root: string;
}): string {
  return [
    "[repository]",
    'repository = "opendal:s3"',
    `password = \"${password}\"`,
    "",
    "[repository.options]",
    `endpoint = \"${endpoint}\"`,
    'region = "auto"',
    `bucket = \"${bucket}\"`,
    `root = \"${root}\"`,
    `access_key_id = \"${accessKey}\"`,
    `secret_access_key = \"${secretKey}\"`,
    "",
  ].join("\n");
}

async function buildTomlForBucket({
  bucket,
  password,
  root,
}: {
  bucket: BucketRow;
  password: string;
  root: string;
}): Promise<string> {
  const accountId =
    (await getSiteSetting("r2_account_id")) ?? bucket.account_id;
  const accessKey =
    (await getSiteSetting("r2_access_key_id")) ?? bucket.access_key_id;
  const secretKey =
    (await getSiteSetting("r2_secret_access_key")) ?? bucket.secret_access_key;
  const endpoint =
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined) ??
    bucket.endpoint;
  if (!accountId || !accessKey || !secretKey || !endpoint) {
    return "";
  }
  return buildS3ProjectBackupToml({
    endpoint,
    bucket: bucket.name,
    accessKey,
    secretKey,
    password,
    root,
  });
}

async function buildBackupIndexStoreConfigForBucket({
  bucket,
}: {
  bucket: BucketRow;
}): Promise<ProjectBackupIndexStoreConfig | null> {
  const accountId =
    (await getSiteSetting("r2_account_id")) ?? bucket.account_id;
  const accessKey =
    (await getSiteSetting("r2_access_key_id")) ?? bucket.access_key_id;
  const secretKey =
    (await getSiteSetting("r2_secret_access_key")) ?? bucket.secret_access_key;
  const endpoint =
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined) ??
    bucket.endpoint;
  if (!accessKey || !secretKey || !endpoint || !bucket.name) {
    return null;
  }
  return {
    kind: "r2-object-store",
    endpoint,
    bucket: bucket.name,
    access_key_id: accessKey,
    secret_access_key: secretKey,
    key_prefix: PROJECT_BACKUP_INDEX_KEY_PREFIX,
    compression: PROJECT_BACKUP_INDEX_COMPRESSION,
  };
}

async function buildBackupConfigFromRepo({
  repo,
  fallbackRegion,
}: {
  repo: ProjectBackupRepoRow;
  fallbackRegion: string;
}): Promise<{
  toml: string;
  ttl_seconds: number;
  backup_repo_id: string;
  index_store?: ProjectBackupIndexStoreConfig | null;
}> {
  if (!repo.bucket_id || !repo.root) {
    return { toml: "", ttl_seconds: 0, backup_repo_id: repo.id };
  }
  const bucket = await loadBucketById(repo.bucket_id);
  if (!bucket) {
    return { toml: "", ttl_seconds: 0, backup_repo_id: repo.id };
  }
  await ensureExistingBucketRowIsUsable({
    bucket,
    fallbackRegion,
  });
  const toml = await buildTomlForBucket({
    bucket,
    password: await getProjectBackupRepoSecret(repo),
    root: repo.root,
  });
  const index_store = await buildBackupIndexStoreConfigForBucket({ bucket });
  return {
    toml,
    ttl_seconds: toml ? DEFAULT_BACKUP_TTL_SECONDS : 0,
    backup_repo_id: repo.id,
    index_store,
  };
}

function shouldUseSeedManagedProjectBackups(): boolean {
  const cluster = getClusterConfig();
  return (
    cluster.role === "attached" &&
    !!cluster.seed_bay_id &&
    cluster.seed_bay_id !== getConfiguredBayId()
  );
}

async function getSeedManagedProjectBackupConfig({
  project_id,
  project_region,
  backup_repo_id,
  preferred_backup_repo_id,
}: {
  project_id: string;
  project_region: string;
  backup_repo_id?: string | null;
  preferred_backup_repo_id?: string | null;
}): Promise<{
  toml: string;
  ttl_seconds: number;
  backup_repo_id: string | null;
  index_store?: ProjectBackupIndexStoreConfig | null;
}> {
  const cluster = getClusterConfig();
  const { getInterBayBridge } = await import("@cocalc/server/inter-bay/bridge");
  const config = await getInterBayBridge()
    .hostConnection(cluster.seed_bay_id, { timeout_ms: 30_000 })
    .getSeedBackupConfig({
      project_id,
      project_region,
      backup_repo_id,
      preferred_backup_repo_id,
    });
  if (config.backup_repo_id && config.toml) {
    await pool().query(
      "UPDATE projects SET backup_repo_id=$2 WHERE project_id=$1 AND backup_repo_id IS DISTINCT FROM $2",
      [project_id, config.backup_repo_id],
    );
  }
  return config;
}

export async function getSeedProjectBackupConfig({
  project_id,
  project_region,
  backup_repo_id,
  preferred_backup_repo_id,
}: {
  project_id: string;
  project_region?: string | null;
  backup_repo_id?: string | null;
  preferred_backup_repo_id?: string | null;
}): Promise<{
  toml: string;
  ttl_seconds: number;
  backup_repo_id: string | null;
  index_store?: ProjectBackupIndexStoreConfig | null;
}> {
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  if (backup_repo_id && !isValidUUID(backup_repo_id)) {
    throw new Error("invalid backup_repo_id");
  }
  const region = normalizeBackupRegion(project_region);
  const resolved = await resolveProjectBackupRepoAssignment({
    project_id,
    project_region: region,
    backup_repo_id,
    preferred_backup_repo_id,
  });
  if (!resolved.backup_repo_id) {
    return { toml: "", ttl_seconds: 0, backup_repo_id: null };
  }
  const repo = await loadProjectBackupRepoById(resolved.backup_repo_id);
  if (!repo) {
    return { toml: "", ttl_seconds: 0, backup_repo_id: null };
  }
  return await buildBackupConfigFromRepo({
    repo,
    fallbackRegion: region,
  });
}

export async function getBackupConfig({
  host_id,
  project_id,
  host_region,
  host_machine,
}: {
  host_id?: string;
  project_id?: string;
  host_region?: string | null;
  host_machine?: HostMachine | null;
}): Promise<ProjectBackupConfig> {
  if (!host_id || !isValidUUID(host_id)) {
    throw new Error("invalid host_id");
  }
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  const { rows } = await pool().query<{
    region: string | null;
    metadata: any;
  }>(
    "SELECT region, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  const hostRow = rows[0];
  if (!hostRow && host_region == null && host_machine == null) {
    throw new Error("host not found");
  }

  await assertHostProjectAccess(host_id, project_id);

  const rowMetadata = hostRow?.metadata ?? {};
  const machine: HostMachine = (rowMetadata?.machine ??
    host_machine ??
    {}) as HostMachine;
  if (isSelfHostLocalMachine(machine)) {
    return await buildSelfHostLocalBackupConfig();
  }

  const hostRegion = hostRow?.region ?? host_region ?? null;
  const hostR2Region = mapCloudRegionToR2Region(
    hostRegion ?? DEFAULT_R2_REGION,
  );
  const projectR2Region = project_id
    ? await resolveProjectRegion(project_id, hostRegion)
    : hostR2Region;
  const assignment = await getProjectBackupAssignment(project_id);
  if (shouldUseSeedManagedProjectBackups()) {
    const config = await getSeedManagedProjectBackupConfig({
      project_id,
      project_region: projectR2Region,
      backup_repo_id: assignment.backup_repo_id,
    });
    return {
      toml: config.toml,
      ttl_seconds: config.ttl_seconds,
      index_store: config.index_store,
    };
  }

  if (assignment.backup_repo_id) {
    const repo = await loadProjectBackupRepoById(assignment.backup_repo_id);
    if (repo && projectBackupRepoCanAcceptExistingAssignment(repo)) {
      const config = await buildBackupConfigFromRepo({
        repo,
        fallbackRegion: projectR2Region,
      });
      return {
        toml: config.toml,
        ttl_seconds: config.ttl_seconds,
        index_store: config.index_store,
      };
    }
  }

  const resolved = await resolveProjectBackupRepoAssignment({
    project_id,
    project_region: projectR2Region,
    backup_repo_id: assignment.backup_repo_id,
  });
  if (!resolved.backup_repo_id) {
    return { toml: "", ttl_seconds: 0 };
  }
  const repo = await loadProjectBackupRepoById(resolved.backup_repo_id);
  if (!repo) {
    return { toml: "", ttl_seconds: 0 };
  }
  const config = await buildBackupConfigFromRepo({
    repo,
    fallbackRegion: projectR2Region,
  });
  return {
    toml: config.toml,
    ttl_seconds: config.ttl_seconds,
    index_store: config.index_store,
  };
}

export async function getProjectBackupConfigForDeletion({
  project_id,
}: {
  project_id: string;
}): Promise<{ toml: string }> {
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }
  const { rows } = await pool().query<{
    host_id: string | null;
    backup_repo_id: string | null;
  }>("SELECT host_id, backup_repo_id FROM projects WHERE project_id=$1", [
    project_id,
  ]);
  const row = rows[0];
  if (!row) {
    throw new Error("project not found");
  }
  return await getDeletedProjectBackupConfigForDeletion({
    project_id,
    host_id: row.host_id,
    backup_repo_id: row.backup_repo_id ?? null,
  });
}

export async function getDeletedProjectBackupConfigForDeletion({
  project_id,
  host_id,
  backup_repo_id,
}: {
  project_id: string;
  host_id?: string | null;
  backup_repo_id?: string | null;
}): Promise<{ toml: string }> {
  if (!project_id || !isValidUUID(project_id)) {
    throw new Error("invalid project_id");
  }

  if (host_id) {
    const { rows } = await pool().query<{ metadata: any }>(
      "SELECT metadata FROM project_hosts WHERE id=$1 LIMIT 1",
      [host_id],
    );
    const machine: HostMachine = rows[0]?.metadata?.machine ?? {};
    if (isSelfHostLocalMachine(machine)) {
      const config = await buildSelfHostLocalBackupConfig();
      if (config.toml.trim()) {
        return { toml: config.toml };
      }
    }
  }

  if (!backup_repo_id) {
    return { toml: "" };
  }
  const repo = await loadProjectBackupRepoById(backup_repo_id);
  if (!repo?.bucket_id || !repo.root) {
    return { toml: "" };
  }
  const bucket = await loadBucketById(repo.bucket_id);
  if (!bucket) {
    return { toml: "" };
  }
  const accountId =
    (await getSiteSetting("r2_account_id")) ?? bucket.account_id;
  const accessKey =
    (await getSiteSetting("r2_access_key_id")) ?? bucket.access_key_id;
  const secretKey =
    (await getSiteSetting("r2_secret_access_key")) ?? bucket.secret_access_key;
  const endpoint =
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined) ??
    bucket.endpoint;
  if (!accountId || !accessKey || !secretKey || !endpoint) {
    return { toml: "" };
  }
  return {
    toml: buildS3ProjectBackupToml({
      endpoint,
      bucket: bucket.name,
      accessKey,
      secretKey,
      password: await getProjectBackupRepoSecret(repo),
      root: repo.root,
    }),
  };
}

export async function getProjectBackupInfrastructureStatus({
  bay_id,
}: {
  bay_id: string;
}): Promise<ProjectBackupInfrastructureStatus> {
  await ensureProjectBackupRepoSchema();
  const r2Settings = await getR2Settings();
  const [bucketResult, repoResult, projectResult] = await Promise.all([
    pool().query<{
      id: string;
      name: string;
      region: string | null;
      location: string | null;
      status: string | null;
    }>(
      `
        SELECT id, name, region, location, status
        FROM buckets
        WHERE provider = $1
          AND purpose = $2
        ORDER BY region ASC NULLS LAST, name ASC
      `,
      [BUCKET_PROVIDER, BUCKET_PURPOSE],
    ),
    pool().query<{
      id: string;
      region: string | null;
      bucket_id: string | null;
      bucket_name: string | null;
      root: string | null;
      status: string | null;
      assigned_project_count: number | string | null;
      created: Date | null;
      updated: Date | null;
    }>(
      `
        SELECT
          r.id,
          r.region,
          r.bucket_id,
          b.name AS bucket_name,
          r.root,
          r.status,
          COUNT(a.project_id)::INTEGER AS assigned_project_count,
          r.created,
          r.updated
        FROM project_backup_repos r
        LEFT JOIN buckets b
          ON b.id = r.bucket_id
        LEFT JOIN project_backup_repo_assignments a
          ON a.backup_repo_id = r.id
        GROUP BY
          r.id,
          r.region,
          r.bucket_id,
          b.name,
          r.root,
          r.status,
          r.created,
          r.updated
        ORDER BY r.region ASC NULLS LAST, r.created ASC, r.id ASC
      `,
    ),
    pool().query<{
      total_projects: number | string | null;
      host_assigned_projects: number | string | null;
      provisioned_projects: number | string | null;
      running_projects: number | string | null;
      repo_assigned_projects: number | string | null;
      repo_unassigned_projects: number | string | null;
      provisioned_up_to_date: number | string | null;
      provisioned_needs_backup: number | string | null;
      never_backed_up: number | string | null;
      latest_last_backup_at: Date | null;
    }>(
      `
        SELECT
          COUNT(*)::INTEGER AS total_projects,
          COUNT(*) FILTER (
            WHERE host_id IS NOT NULL
          )::INTEGER AS host_assigned_projects,
          COUNT(*) FILTER (
            WHERE provisioned IS TRUE
          )::INTEGER AS provisioned_projects,
          COUNT(*) FILTER (
            WHERE COALESCE(state->>'state', '') IN ('running', 'starting')
          )::INTEGER AS running_projects,
          COUNT(*) FILTER (
            WHERE backup_repo_id IS NOT NULL
          )::INTEGER AS repo_assigned_projects,
          COUNT(*) FILTER (
            WHERE host_id IS NOT NULL
              AND backup_repo_id IS NULL
          )::INTEGER AS repo_unassigned_projects,
          COUNT(*) FILTER (
            WHERE provisioned IS TRUE
              AND COALESCE(state->>'state', '') NOT IN ('running', 'starting')
              AND last_backup IS NOT NULL
              AND (last_edited IS NULL OR last_edited <= last_backup)
          )::INTEGER AS provisioned_up_to_date,
          COUNT(*) FILTER (
            WHERE provisioned IS TRUE
              AND COALESCE(state->>'state', '') NOT IN ('running', 'starting')
              AND (
                last_backup IS NULL
                OR (last_edited IS NOT NULL AND last_edited > last_backup)
              )
          )::INTEGER AS provisioned_needs_backup,
          COUNT(*) FILTER (
            WHERE last_backup IS NULL
          )::INTEGER AS never_backed_up,
          MAX(last_backup) AS latest_last_backup_at
        FROM projects
        WHERE deleted IS NOT true
          AND COALESCE(owning_bay_id, $1) = $1
      `,
      [bay_id],
    ),
  ]);
  const buckets = bucketResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    region: row.region ?? null,
    location: row.location ?? null,
    status: row.status ?? null,
  }));
  const repos = repoResult.rows.map((row) => ({
    id: row.id,
    region: row.region ?? null,
    bucket_id: row.bucket_id ?? null,
    bucket_name: row.bucket_name ?? null,
    root: row.root ?? null,
    status: row.status ?? null,
    assigned_project_count: Math.max(
      0,
      Number(row.assigned_project_count ?? 0) || 0,
    ),
    created: asIso(row.created),
    updated: asIso(row.updated),
  }));
  const projectRow = projectResult.rows[0];
  return {
    r2: {
      configured: !!(
        r2Settings.accountId &&
        r2Settings.accessKey &&
        r2Settings.secretKey
      ),
      account_id_configured: !!r2Settings.accountId,
      access_key_configured: !!r2Settings.accessKey,
      secret_key_configured: !!r2Settings.secretKey,
      bucket_prefix: r2Settings.bucketPrefix ?? null,
      total_buckets: buckets.length,
      active_buckets: buckets.filter(
        (bucket) => !bucket.status || bucket.status === "active",
      ).length,
      buckets,
    },
    repos: {
      total_repos: repos.length,
      active_repos: repos.filter(
        (repo) => !repo.status || repo.status === "active",
      ).length,
      assigned_projects: repos.reduce(
        (sum, repo) => sum + repo.assigned_project_count,
        0,
      ),
      repos,
    },
    projects: {
      total_projects: Math.max(0, Number(projectRow?.total_projects ?? 0) || 0),
      host_assigned_projects: Math.max(
        0,
        Number(projectRow?.host_assigned_projects ?? 0) || 0,
      ),
      provisioned_projects: Math.max(
        0,
        Number(projectRow?.provisioned_projects ?? 0) || 0,
      ),
      running_projects: Math.max(
        0,
        Number(projectRow?.running_projects ?? 0) || 0,
      ),
      repo_assigned_projects: Math.max(
        0,
        Number(projectRow?.repo_assigned_projects ?? 0) || 0,
      ),
      repo_unassigned_projects: Math.max(
        0,
        Number(projectRow?.repo_unassigned_projects ?? 0) || 0,
      ),
      provisioned_up_to_date: Math.max(
        0,
        Number(projectRow?.provisioned_up_to_date ?? 0) || 0,
      ),
      provisioned_needs_backup: Math.max(
        0,
        Number(projectRow?.provisioned_needs_backup ?? 0) || 0,
      ),
      never_backed_up: Math.max(
        0,
        Number(projectRow?.never_backed_up ?? 0) || 0,
      ),
      latest_last_backup_at: asIso(projectRow?.latest_last_backup_at),
    },
  };
}

export async function getProjectBackupShardAdminStatus({
  region,
}: {
  region?: string | null;
} = {}): Promise<ProjectBackupShardAdminStatus> {
  await ensureProjectBackupRepoSchema();
  const normalizedRegion = region ? normalizeBackupRegion(region) : null;
  const { rows } = await pool().query<{
    id: string;
    region: string | null;
    bucket_id: string | null;
    bucket_name: string | null;
    root: string | null;
    status: string | null;
    assigned_project_count: number | string | null;
    created: Date | null;
    updated: Date | null;
  }>(
    `
      SELECT
        r.id,
        r.region,
        r.bucket_id,
        b.name AS bucket_name,
        r.root,
        r.status,
        COUNT(a.project_id)::INTEGER AS assigned_project_count,
        r.created,
        r.updated
      FROM project_backup_repos r
      LEFT JOIN buckets b
        ON b.id = r.bucket_id
      LEFT JOIN project_backup_repo_assignments a
        ON a.backup_repo_id = r.id
      WHERE ($1::text IS NULL OR r.region = $1)
      GROUP BY
        r.id,
        r.region,
        r.bucket_id,
        b.name,
        r.root,
        r.status,
        r.created,
        r.updated
      ORDER BY r.region ASC NULLS LAST, r.created ASC, r.id ASC
    `,
    [normalizedRegion],
  );
  const repos: ProjectBackupShardAdminRepoInfo[] = rows.map((row) => {
    const assigned_project_count = Math.max(
      0,
      Number(row.assigned_project_count ?? 0) || 0,
    );
    return {
      id: row.id,
      region: row.region ?? null,
      bucket_id: row.bucket_id ?? null,
      bucket_name: row.bucket_name ?? null,
      root: row.root ?? null,
      status: row.status ?? null,
      assigned_project_count,
      project_cap: PROJECT_BACKUP_PROJECTS_PER_SHARD,
      available_project_slots: Math.max(
        0,
        PROJECT_BACKUP_PROJECTS_PER_SHARD - assigned_project_count,
      ),
      created: asIso(row.created),
      updated: asIso(row.updated),
    };
  });
  const byRegion = new Map<string, ProjectBackupShardAdminRegionInfo>();
  for (const repo of repos) {
    const regionKey = repo.region ?? "unknown";
    let summary = byRegion.get(regionKey);
    if (!summary) {
      summary = {
        region: regionKey,
        total_repos: 0,
        active_repos: 0,
        sealed_repos: 0,
        draining_repos: 0,
        disabled_repos: 0,
        assigned_projects: 0,
        active_capacity_projects: 0,
        active_available_project_slots: 0,
      };
      byRegion.set(regionKey, summary);
    }
    summary.total_repos += 1;
    summary.assigned_projects += repo.assigned_project_count;
    if (!repo.status || repo.status === PROJECT_BACKUP_REPO_STATUS_ACTIVE) {
      summary.active_repos += 1;
      summary.active_capacity_projects += PROJECT_BACKUP_PROJECTS_PER_SHARD;
      summary.active_available_project_slots += repo.available_project_slots;
    } else if (repo.status === PROJECT_BACKUP_REPO_STATUS_SEALED) {
      summary.sealed_repos += 1;
    } else if (repo.status === PROJECT_BACKUP_REPO_STATUS_DRAINING) {
      summary.draining_repos += 1;
    } else if (repo.status === PROJECT_BACKUP_REPO_STATUS_DISABLED) {
      summary.disabled_repos += 1;
    }
  }
  return {
    checked_at: new Date().toISOString(),
    active_shards_per_region: PROJECT_BACKUP_ACTIVE_SHARDS_PER_REGION,
    projects_per_shard: PROJECT_BACKUP_PROJECTS_PER_SHARD,
    authoritative_bay_id: getConfiguredBayId(),
    regions: Array.from(byRegion.values()).sort((a, b) =>
      a.region.localeCompare(b.region),
    ),
    repos,
  };
}

async function assertHostProjectAccess(host_id: string, project_id: string) {
  await ensureProjectMovesSchema();
  const { rows } = await pool().query<{
    host_id: string | null;
    project_owning_bay_id: string | null;
    host_bay_id: string | null;
  }>(
    `
      SELECT
        projects.host_id,
        COALESCE(projects.owning_bay_id, $2) AS project_owning_bay_id,
        COALESCE(project_hosts.bay_id, $2) AS host_bay_id
      FROM projects
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
      WHERE project_id=$1
      LIMIT 1
    `,
    [project_id, getConfiguredBayId()],
  );
  const row = rows[0];
  const currentHost = row?.host_id ?? null;
  if (!currentHost) {
    throw new Error("project not assigned to host");
  }
  if (currentHost === host_id) {
    // Backup management is now host-local even when the project owning bay
    // differs from the host bay. The authenticated host is authorized as long
    // as it is the project's current assigned host.
    return;
  }

  const { rows: moveRows } = await pool().query<{
    source_host_id: string | null;
    dest_host_id: string | null;
  }>(
    "SELECT source_host_id, dest_host_id FROM project_moves WHERE project_id=$1",
    [project_id],
  );
  const move = moveRows[0];
  if (
    move &&
    (move.source_host_id === host_id || move.dest_host_id === host_id)
  ) {
    return;
  }
  await ensureCopySchema();
  const { rows: copyRows } = await pool().query(
    `
      SELECT 1
      FROM project_copies pc
      JOIN projects p ON p.project_id = pc.dest_project_id
      WHERE pc.src_project_id=$1
        AND p.host_id=$2
        AND pc.status = ANY($3::text[])
      LIMIT 1
    `,
    [project_id, host_id, ["queued", "applying", "failed"]],
  );
  if (copyRows.length) {
    return;
  }
  throw new Error("project not assigned to host");
}

let projectMovesSchemaReady: Promise<void> | null = null;

async function ensureProjectMovesSchema() {
  if (projectMovesSchemaReady) {
    return projectMovesSchemaReady;
  }
  projectMovesSchemaReady = (async () => {
    await pool().query(
      `
      CREATE TABLE IF NOT EXISTS project_moves (
        project_id UUID PRIMARY KEY,
        source_host_id UUID,
        dest_host_id UUID,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `,
    );
  })();
  return projectMovesSchemaReady;
}
