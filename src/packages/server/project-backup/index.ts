import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
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
import { createBucket, listBuckets, R2BucketInfo } from "./r2";
import { ensureCopySchema } from "@cocalc/server/projects/copy-db";
import type { HostMachine } from "@cocalc/conat/hub/api/hosts";
import { buildLaunchpadRestRusticRepoConfig } from "@cocalc/server/launchpad/rest-repo";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

const DEFAULT_BACKUP_TTL_SECONDS = 60 * 60 * 12; // 12 hours
const DEFAULT_BACKUP_ROOT = "rustic";
const DEFAULT_SHARED_REPO_ROOT_PREFIX = `${DEFAULT_BACKUP_ROOT}/shared`;
const BUCKET_PROVIDER = "r2";
const BUCKET_PURPOSE = "project-backups";
const BUCKET_LIST_CACHE_MS = 30 * 1000;
const BUCKET_VERIFY_TTL_MS = 10 * 60 * 1000;
const PROJECT_BACKUP_REPO_STATUS_ACTIVE = "active";

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

let projectBackupRepoSchemaReady: Promise<void> | undefined;

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

async function selectActiveProjectBackupRepoForRegion(
  region: string,
): Promise<ProjectBackupRepoRow | null> {
  await ensureProjectBackupRepoSchema();
  const { rows } = await pool().query<ProjectBackupRepoRow>(
    `SELECT
      r.id,
      r.region,
      r.bucket_id,
      r.root,
      r.secret,
      r.status,
      r.created,
      r.updated,
      COUNT(p.project_id)::INTEGER AS assigned_project_count
    FROM project_backup_repos r
    LEFT JOIN projects p ON p.backup_repo_id = r.id
    WHERE r.region=$1
      AND COALESCE(r.status, $2) = $2
    GROUP BY
      r.id,
      r.region,
      r.bucket_id,
      r.root,
      r.secret,
      r.status,
      r.created,
      r.updated
    ORDER BY COUNT(p.project_id) ASC, r.created ASC, r.id ASC
    LIMIT 1`,
    [region, PROJECT_BACKUP_REPO_STATUS_ACTIVE],
  );
  return rows[0] ?? null;
}

function nextSharedRepoRoot(region: string, existingCount: number): string {
  const serial = String(existingCount + 1).padStart(4, "0");
  return `${DEFAULT_SHARED_REPO_ROOT_PREFIX}-${region}-${serial}`;
}

async function createProjectBackupRepo({
  region,
  bucket,
}: {
  region: string;
  bucket: BucketRow;
}): Promise<ProjectBackupRepoRow> {
  await ensureProjectBackupRepoSchema();
  const masterKey = await getBackupMasterKey();
  const sharedSecret = randomBytes(32).toString("base64url");
  const encryptedSecret = encryptBackupSecret(sharedSecret, masterKey);
  const { rows: existing } = await pool().query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM project_backup_repos WHERE region=$1",
    [region],
  );
  const root = nextSharedRepoRoot(region, existing[0]?.count ?? 0);
  const { rows } = await pool().query<ProjectBackupRepoRow>(
    `INSERT INTO project_backup_repos
      (id, region, bucket_id, root, secret, status, created, updated)
    VALUES
      (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
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

async function getOrCreateProjectBackupRepoForRegion(
  region: string,
): Promise<{ repo: ProjectBackupRepoRow; bucket: BucketRow } | null> {
  const existing = await selectActiveProjectBackupRepoForRegion(region);
  if (existing?.bucket_id) {
    const bucket = await loadBucketById(existing.bucket_id);
    if (bucket) {
      await ensureExistingBucketRowIsUsable({
        bucket,
        fallbackRegion: region,
      });
      return { repo: existing, bucket };
    }
  }
  const bucket = await getOrCreateBucketForRegion(region);
  if (!bucket) return null;
  const repo = await createProjectBackupRepo({ region, bucket });
  return { repo, bucket };
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

async function assignProjectBackupRepo({
  project_id,
  repo,
}: {
  project_id: string;
  repo: ProjectBackupRepoRow;
}): Promise<void> {
  await ensureProjectBackupRepoSchema();
  await pool().query(
    "UPDATE projects SET backup_repo_id=$2 WHERE project_id=$1",
    [project_id, repo.id],
  );
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

function isSelfHostLocalMachine(machine: HostMachine): boolean {
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  return machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
}

async function buildSelfHostLocalBackupConfig(): Promise<{
  toml: string;
  ttl_seconds: number;
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
}): Promise<{ toml: string; ttl_seconds: number }> {
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
  const buildTomlForBucket = async ({
    bucket,
    password,
    root,
  }: {
    bucket: BucketRow;
    password: string;
    root: string;
  }): Promise<string> => {
    const accountId =
      (await getSiteSetting("r2_account_id")) ?? bucket.account_id;
    const accessKey =
      (await getSiteSetting("r2_access_key_id")) ?? bucket.access_key_id;
    const secretKey =
      (await getSiteSetting("r2_secret_access_key")) ??
      bucket.secret_access_key;
    const endpoint =
      (accountId
        ? `https://${accountId}.r2.cloudflarestorage.com`
        : undefined) ?? bucket.endpoint;
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
  };

  const assignment = await getProjectBackupAssignment(project_id);
  if (assignment.backup_repo_id) {
    const repo = await loadProjectBackupRepoById(assignment.backup_repo_id);
    if (repo?.bucket_id && repo.root) {
      const bucket = await loadBucketById(repo.bucket_id);
      if (bucket) {
        await ensureExistingBucketRowIsUsable({
          bucket,
          fallbackRegion: projectR2Region,
        });
        const toml = await buildTomlForBucket({
          bucket,
          password: await getProjectBackupRepoSecret(repo),
          root: repo.root,
        });
        return { toml, ttl_seconds: toml ? DEFAULT_BACKUP_TTL_SECONDS : 0 };
      }
    }
  }

  const assigned = await getOrCreateProjectBackupRepoForRegion(projectR2Region);
  if (!assigned?.bucket || !assigned.repo.root) {
    return { toml: "", ttl_seconds: 0 };
  }
  await assignProjectBackupRepo({ project_id, repo: assigned.repo });
  const toml = await buildTomlForBucket({
    bucket: assigned.bucket,
    password: await getProjectBackupRepoSecret(assigned.repo),
    root: assigned.repo.root,
  });
  return { toml, ttl_seconds: toml ? DEFAULT_BACKUP_TTL_SECONDS : 0 };
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
          COUNT(p.project_id)::INTEGER AS assigned_project_count,
          r.created,
          r.updated
        FROM project_backup_repos r
        LEFT JOIN buckets b
          ON b.id = r.bucket_id
        LEFT JOIN projects p
          ON p.backup_repo_id = r.id
         AND p.deleted IS NOT true
         AND COALESCE(p.owning_bay_id, $1) = $1
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
      [bay_id],
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
