/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { secrets } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import rustic from "@cocalc/backend/sandbox/rustic";
import type { HostMachine } from "@cocalc/conat/hub/api/hosts";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { buildLaunchpadRestRusticRepoConfig } from "@cocalc/server/launchpad/rest-repo";
import { ensureProjectBackupBucketForRegion } from "@cocalc/server/project-backup";
import { appendRootfsImageEventForReleaseImages } from "@cocalc/server/rootfs/events";
import {
  ensureRootfsRusticRepoSchema,
  ROOTFS_RUSTIC_ACTIVE_SHARDS_PER_REGION,
  ROOTFS_RUSTIC_RELEASES_PER_SHARD,
  ROOTFS_RUSTIC_REPO_STATUS_ACTIVE,
  ROOTFS_RUSTIC_REPO_STATUS_DISABLED,
  ROOTFS_RUSTIC_REPO_STATUS_SEALED,
  ROOTFS_RUSTIC_SHARED_REPO_ROOT_PREFIX,
} from "@cocalc/server/rootfs/rustic-repo-schema";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  parseR2Region,
  rankR2RegionDistance,
} from "@cocalc/util/consts";
import type {
  PublishProjectRootfsArtifact,
  RootfsArtifactTransferTarget,
  RootfsDeleteBlockers,
  RootfsReleaseArtifactAccess,
  RootfsReleaseArtifactBackend,
  RootfsReleaseArtifactFormat,
  RootfsReleaseArtifactKind,
  RootfsReleaseGcItem,
  RootfsReleaseGcRunResult,
  RootfsUploadedArtifactResult,
} from "@cocalc/util/rootfs-images";
import { v4 as uuid } from "uuid";

const ROOTFS_RUSTIC_SHARED_SECRET_PATH = join(
  secrets,
  "rootfs-rustic-shared-secret",
);
const ROOTFS_RUSTIC_REPO_ROOT = "rootfs-images";
const logger = getLogger("server:rootfs:releases");

type RootfsReleaseRow = {
  release_id: string;
  content_key: string;
  runtime_image: string;
  source_image: string | null;
  parent_release_id: string | null;
  depth: number | null;
  arch: string | null;
  size_bytes: number | null;
  artifact_kind: RootfsReleaseArtifactKind;
  artifact_format: RootfsReleaseArtifactFormat;
  artifact_backend: RootfsReleaseArtifactBackend;
  artifact_path: string;
  repo_id: string | null;
  artifact_sha256: string;
  artifact_bytes: number;
  inspect_json: Record<string, any> | null;
};

type BucketRow = {
  id: string;
  name: string;
  purpose: string | null;
  region: string | null;
  endpoint: string | null;
  access_key_id: string | null;
  secret_access_key: string | null;
  status: string | null;
};

type RootfsReleaseArtifactReplicaRow = {
  artifact_id: string;
  release_id: string;
  content_key: string;
  backend: RootfsReleaseArtifactBackend;
  region: string | null;
  bucket_id: string | null;
  bucket_name: string | null;
  bucket_purpose: string | null;
  artifact_kind: RootfsReleaseArtifactKind;
  artifact_format: RootfsReleaseArtifactFormat;
  artifact_path: string;
  repo_id: string | null;
  artifact_sha256: string;
  artifact_bytes: number;
  status: string;
  replicated_from_artifact_id: string | null;
  error: string | null;
};

type RootfsRusticRepoRow = {
  id: string;
  region: string | null;
  bucket_id: string | null;
  root: string | null;
  secret: string | null;
  status: string | null;
  created: Date | null;
  updated: Date | null;
  assigned_artifact_count?: number | null;
};

type PoolClient = {
  query: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }>;
  release: () => void;
};

function normalizeContentKey(content_key?: string | null): string {
  const value = `${content_key ?? ""}`.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid RootFS content key");
  }
  return value;
}

type RootfsRusticArtifactPath = {
  artifact_backend: RootfsReleaseArtifactBackend;
  snapshot_id: string;
  region?: string;
  repo_id?: string;
};

function encodeRusticArtifactPath({
  artifact_backend,
  snapshot_id,
  region,
  repo_id,
}: RootfsRusticArtifactPath): string {
  const backend = `${artifact_backend ?? ""}`.trim();
  const snapshot = `${snapshot_id ?? ""}`.trim();
  if (!backend || !snapshot) {
    throw new Error("invalid rustic RootFS artifact path");
  }
  const repoId = `${repo_id ?? ""}`.trim();
  if (repoId) {
    return [
      "rustic",
      "v2",
      encodeURIComponent(repoId),
      encodeURIComponent(snapshot),
    ].join("/");
  }
  const safeRegion = `${region ?? ""}`.trim() || "site";
  return [
    "rustic",
    encodeURIComponent(backend),
    encodeURIComponent(safeRegion),
    encodeURIComponent(snapshot),
  ].join("/");
}

function decodeRusticArtifactPath(
  artifact_path?: string | null,
): RootfsRusticArtifactPath | null {
  const parts = `${artifact_path ?? ""}`.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (parts.length !== 4 || parts[0] !== "rustic") {
    return null;
  }
  const [_, artifact_backend, region, snapshot_id] = parts;
  if (artifact_backend === "v2") {
    if (!region || !snapshot_id) return null;
    return {
      artifact_backend: "r2",
      repo_id: region,
      snapshot_id,
    };
  }
  if (!artifact_backend || !snapshot_id) {
    return null;
  }
  return {
    artifact_backend: artifact_backend as RootfsReleaseArtifactBackend,
    region: region === "site" ? undefined : region,
    snapshot_id,
  };
}

export async function issueRootfsReleaseArtifactUpload({
  host_id,
  artifact_kind = "full",
  preferred_repo_id,
  source_image,
  parent_release_id,
}: {
  host_id: string;
  artifact_kind?: RootfsReleaseArtifactKind;
  preferred_repo_id?: string | null;
  source_image?: string | null;
  parent_release_id?: string | null;
}): Promise<RootfsArtifactTransferTarget> {
  if (artifact_kind !== "full") {
    throw new Error(
      "managed RootFS releases are always stored as full rustic snapshots",
    );
  }
  const repo = await buildRootfsRusticRepoConfigForHost(host_id, {
    preferred_repo_id,
    source_image,
    parent_release_id,
  });
  return {
    backend: "rustic",
    repo_toml: repo.repo_toml,
    repo_selector: repo.repo_selector,
    repo_id: repo.repo_id,
    repo_root: repo.repo_root,
    artifact_backend: repo.artifact_backend,
    region: repo.region,
    bucket_id: repo.bucket?.id,
    bucket_name: repo.bucket?.name,
    bucket_purpose: repo.bucket?.purpose ?? null,
  };
}

async function loadRootfsReleaseRowByContentKey(
  content_key: string,
): Promise<RootfsReleaseRow | null> {
  await ensureRootfsRusticRepoSchema();
  const pool = getPool("medium");
  const { rows } = await pool.query<RootfsReleaseRow>(
    `SELECT
      release_id,
      content_key,
      runtime_image,
      source_image,
      parent_release_id,
      depth,
      arch,
      size_bytes,
      artifact_kind,
      artifact_format,
      artifact_backend,
      artifact_path,
      repo_id,
      artifact_sha256,
      artifact_bytes,
      inspect_json
    FROM rootfs_releases
    WHERE content_key=$1`,
    [normalizeContentKey(content_key)],
  );
  return rows[0] ?? null;
}

async function loadR2BucketForRegion(
  region: string,
): Promise<BucketRow | null> {
  return (await ensureProjectBackupBucketForRegion(region)) as BucketRow | null;
}

async function loadR2BucketById(bucket_id: string): Promise<BucketRow | null> {
  const { rows } = await getPool("medium").query<BucketRow>(
    `SELECT
      id,
      name,
      purpose,
      region,
      endpoint,
      access_key_id,
      secret_access_key,
      status
    FROM buckets
    WHERE id=$1
      AND provider='r2'
      AND purpose='project-backups'
      AND (status IS NULL OR status != 'disabled')
    LIMIT 1`,
    [bucket_id],
  );
  return rows[0] ?? null;
}

async function loadR2BucketByName(name: string): Promise<BucketRow | null> {
  const { rows } = await getPool("medium").query<BucketRow>(
    `SELECT
      id,
      name,
      purpose,
      region,
      endpoint,
      access_key_id,
      secret_access_key,
      status
    FROM buckets
    WHERE name=$1
      AND provider='r2'
      AND purpose='project-backups'
      AND (status IS NULL OR status != 'disabled')
    ORDER BY created DESC
    LIMIT 1`,
    [name],
  );
  return rows[0] ?? null;
}

let rootfsRusticSharedSecret: string | undefined;

async function getRootfsRusticSharedSecret(): Promise<string> {
  if (rootfsRusticSharedSecret) {
    return rootfsRusticSharedSecret;
  }
  let encoded = "";
  try {
    encoded = (await readFile(ROOTFS_RUSTIC_SHARED_SECRET_PATH, "utf8")).trim();
  } catch {}
  if (!encoded) {
    encoded = randomBytes(32).toString("base64url");
    await mkdir(secrets, { recursive: true });
    await writeFile(ROOTFS_RUSTIC_SHARED_SECRET_PATH, encoded, { mode: 0o600 });
  }
  rootfsRusticSharedSecret = encoded;
  return encoded;
}

function normalizeRootfsRusticRegion(region?: string | null): string {
  return (
    parseR2Region(region) ??
    mapCloudRegionToR2Region(region ?? DEFAULT_R2_REGION)
  );
}

function nextRootfsRusticRepoRoot({
  region,
  existingCount,
  repoId,
}: {
  region: string;
  existingCount: number;
  repoId: string;
}): string {
  const serial = String(existingCount + 1).padStart(4, "0");
  return `${ROOTFS_RUSTIC_SHARED_REPO_ROOT_PREFIX}/${region}/shard-${serial}-${repoId}`;
}

async function listRootfsRusticReposForRegionTx(
  client: PoolClient,
  region: string,
  statuses?: string[],
): Promise<RootfsRusticRepoRow[]> {
  const filters = ["r.region=$1"];
  const params: any[] = [region];
  if (statuses?.length) {
    params.push(statuses);
    filters.push(
      `COALESCE(r.status, '${ROOTFS_RUSTIC_REPO_STATUS_ACTIVE}') = ANY($${params.length}::text[])`,
    );
  }
  const { rows } = await client.query<RootfsRusticRepoRow>(
    `WITH assignments AS (
       SELECT repo_id, release_id::text AS artifact_key
       FROM rootfs_releases
       WHERE repo_id IS NOT NULL
         AND COALESCE(gc_status, 'active') <> 'deleted'
       UNION
       SELECT repo_id, artifact_id::text AS artifact_key
       FROM rootfs_release_artifacts
       WHERE repo_id IS NOT NULL
         AND COALESCE(status, 'ready') <> 'deleted'
     )
     SELECT
       r.id,
       r.region,
       r.bucket_id,
       r.root,
       r.secret,
       r.status,
       r.created,
       r.updated,
       COUNT(a.artifact_key)::INTEGER AS assigned_artifact_count
     FROM rootfs_rustic_repos r
     LEFT JOIN assignments a ON a.repo_id = r.id
     WHERE ${filters.join(" AND ")}
     GROUP BY r.id, r.region, r.bucket_id, r.root, r.secret, r.status, r.created, r.updated
     ORDER BY COUNT(a.artifact_key) ASC, r.created ASC, r.id ASC`,
    params,
  );
  return rows;
}

async function loadRootfsRusticRepoByIdTx(
  client: PoolClient,
  id: string,
): Promise<RootfsRusticRepoRow | null> {
  const { rows } = await client.query<RootfsRusticRepoRow>(
    `WITH assignments AS (
       SELECT repo_id, release_id::text AS artifact_key
       FROM rootfs_releases
       WHERE repo_id IS NOT NULL
         AND COALESCE(gc_status, 'active') <> 'deleted'
       UNION
       SELECT repo_id, artifact_id::text AS artifact_key
       FROM rootfs_release_artifacts
       WHERE repo_id IS NOT NULL
         AND COALESCE(status, 'ready') <> 'deleted'
     )
     SELECT
       r.id,
       r.region,
       r.bucket_id,
       r.root,
       r.secret,
       r.status,
       r.created,
       r.updated,
       COUNT(a.artifact_key)::INTEGER AS assigned_artifact_count
     FROM rootfs_rustic_repos r
     LEFT JOIN assignments a ON a.repo_id = r.id
     WHERE r.id=$1
     GROUP BY r.id, r.region, r.bucket_id, r.root, r.secret, r.status, r.created, r.updated
     LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadRootfsRusticRepoById(
  id?: string | null,
): Promise<RootfsRusticRepoRow | null> {
  const repoId = `${id ?? ""}`.trim();
  if (!repoId) return null;
  await ensureRootfsRusticRepoSchema();
  const { rows } = await getPool("medium").query<RootfsRusticRepoRow>(
    `SELECT id, region, bucket_id, root, secret, status, created, updated
     FROM rootfs_rustic_repos
     WHERE id=$1
     LIMIT 1`,
    [repoId],
  );
  return rows[0] ?? null;
}

async function createRootfsRusticRepoTx({
  client,
  region,
  bucket,
}: {
  client: PoolClient;
  region: string;
  bucket: BucketRow;
}): Promise<RootfsRusticRepoRow> {
  const repoId = uuid();
  const { rows: existing } = await client.query<{ count: number }>(
    "SELECT COUNT(*)::INTEGER AS count FROM rootfs_rustic_repos WHERE region=$1",
    [region],
  );
  const root = nextRootfsRusticRepoRoot({
    region,
    existingCount: existing[0]?.count ?? 0,
    repoId,
  });
  const { rows } = await client.query<RootfsRusticRepoRow>(
    `INSERT INTO rootfs_rustic_repos
      (id, region, bucket_id, root, secret, status, created, updated)
     VALUES
      ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING id, region, bucket_id, root, secret, status, created, updated`,
    [
      repoId,
      region,
      bucket.id,
      root,
      await getRootfsRusticSharedSecret(),
      ROOTFS_RUSTIC_REPO_STATUS_ACTIVE,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("failed to create RootFS rustic repository shard");
  }
  return row;
}

async function withRootfsRusticRegionAssignmentLock<T>(
  region: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  await ensureRootfsRusticRepoSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `rootfs-rustic-shards:${region}`,
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

async function ensureActiveRootfsRusticReposForRegionTx({
  client,
  region,
  bucket,
}: {
  client: PoolClient;
  region: string;
  bucket: BucketRow;
}): Promise<RootfsRusticRepoRow[]> {
  let active = await listRootfsRusticReposForRegionTx(client, region, [
    ROOTFS_RUSTIC_REPO_STATUS_ACTIVE,
  ]);
  while (active.length < ROOTFS_RUSTIC_ACTIVE_SHARDS_PER_REGION) {
    await createRootfsRusticRepoTx({ client, region, bucket });
    active = await listRootfsRusticReposForRegionTx(client, region, [
      ROOTFS_RUSTIC_REPO_STATUS_ACTIVE,
    ]);
  }
  return active;
}

async function sealRootfsRusticReposTx(
  client: PoolClient,
  repoIds: string[],
): Promise<void> {
  const ids = repoIds.filter(Boolean);
  if (!ids.length) return;
  await client.query(
    `UPDATE rootfs_rustic_repos
     SET status=$2, updated=NOW()
     WHERE id = ANY($1::uuid[])`,
    [ids, ROOTFS_RUSTIC_REPO_STATUS_SEALED],
  );
}

function rootfsRusticRepoHasCapacity(repo: RootfsRusticRepoRow): boolean {
  return (
    Number(repo.assigned_artifact_count ?? 0) < ROOTFS_RUSTIC_RELEASES_PER_SHARD
  );
}

function rootfsRusticRepoCanAcceptExistingAssignment(
  repo: RootfsRusticRepoRow,
): boolean {
  return repo.status !== ROOTFS_RUSTIC_REPO_STATUS_DISABLED;
}

async function findPreferredRootfsRusticRepoId({
  region,
  source_image,
  parent_release_id,
}: {
  region: string;
  source_image?: string | null;
  parent_release_id?: string | null;
}): Promise<string | null> {
  await ensureRootfsRusticRepoSchema();
  const filters: string[] = [];
  const params: any[] = [region];
  const parent = `${parent_release_id ?? ""}`.trim();
  if (parent) {
    params.push(parent);
    filters.push(`rel.release_id=$${params.length}`);
  }
  const sourceImage = `${source_image ?? ""}`.trim();
  if (sourceImage) {
    params.push(sourceImage);
    filters.push(`rel.runtime_image=$${params.length}`);
  }
  if (!filters.length) return null;
  const { rows } = await getPool("medium").query<{ repo_id: string }>(
    `SELECT rel.repo_id
     FROM rootfs_releases rel
     JOIN rootfs_rustic_repos repo ON repo.id = rel.repo_id
     WHERE repo.region=$1
       AND rel.repo_id IS NOT NULL
       AND COALESCE(repo.status, '${ROOTFS_RUSTIC_REPO_STATUS_ACTIVE}') = '${ROOTFS_RUSTIC_REPO_STATUS_ACTIVE}'
       AND COALESCE(rel.gc_status, 'active') <> 'deleted'
       AND (${filters.join(" OR ")})
     ORDER BY rel.updated DESC NULLS LAST, rel.created DESC NULLS LAST
     LIMIT 1`,
    params,
  );
  return rows[0]?.repo_id ?? null;
}

async function selectRootfsRusticRepoForArtifact({
  region: regionRaw,
  preferred_repo_id,
  source_image,
  parent_release_id,
}: {
  region: string;
  preferred_repo_id?: string | null;
  source_image?: string | null;
  parent_release_id?: string | null;
}): Promise<{ repo: RootfsRusticRepoRow; bucket: BucketRow }> {
  const region = normalizeRootfsRusticRegion(regionRaw);
  const bucket = await loadR2BucketForRegion(region);
  if (!bucket?.id) {
    throw new Error(`no usable R2 bucket configured for region '${region}'`);
  }
  const lineageRepoId =
    `${preferred_repo_id ?? ""}`.trim() ||
    (await findPreferredRootfsRusticRepoId({
      region,
      source_image,
      parent_release_id,
    }));
  return await withRootfsRusticRegionAssignmentLock(region, async (client) => {
    let active = await ensureActiveRootfsRusticReposForRegionTx({
      client,
      region,
      bucket,
    });
    let activeWithCapacity = active.filter(rootfsRusticRepoHasCapacity);
    if (!activeWithCapacity.length) {
      await sealRootfsRusticReposTx(
        client,
        active
          .filter((repo) => !rootfsRusticRepoHasCapacity(repo))
          .map((repo) => repo.id),
      );
      active = await ensureActiveRootfsRusticReposForRegionTx({
        client,
        region,
        bucket,
      });
      activeWithCapacity = active.filter(rootfsRusticRepoHasCapacity);
    }

    if (lineageRepoId) {
      const preferred = await loadRootfsRusticRepoByIdTx(client, lineageRepoId);
      if (
        preferred &&
        normalizeRootfsRusticRegion(preferred.region) === region &&
        rootfsRusticRepoCanAcceptExistingAssignment(preferred) &&
        rootfsRusticRepoHasCapacity(preferred)
      ) {
        return { repo: preferred, bucket };
      }
    }

    const candidate = activeWithCapacity[0];
    if (!candidate) {
      throw new Error(`no RootFS rustic repo shard available in ${region}`);
    }
    return { repo: candidate, bucket };
  });
}

function buildRootfsRusticS3Toml({
  endpoint,
  bucket,
  root,
  accessKey,
  secretKey,
  password,
}: {
  endpoint: string;
  bucket: string;
  root: string;
  accessKey: string;
  secretKey: string;
  password: string;
}): string {
  return [
    "[repository]",
    'repository = "opendal:s3"',
    `password = "${password}"`,
    "",
    "[repository.options]",
    `endpoint = "${endpoint}"`,
    'region = "auto"',
    `bucket = "${bucket}"`,
    `root = "${root}"`,
    `access_key_id = "${accessKey}"`,
    `secret_access_key = "${secretKey}"`,
    "",
  ].join("\n");
}

function isSelfHostLocalMachine(machine: HostMachine): boolean {
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  return machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
}

async function loadHostStorageContext(host_id: string): Promise<{
  region: string | null;
  machine: HostMachine;
}> {
  const { rows } = await getPool("medium").query<{
    region: string | null;
    metadata: any;
  }>("SELECT region, metadata FROM project_hosts WHERE id=$1", [host_id]);
  if (!rows[0]) {
    throw new Error(`host '${host_id}' not found`);
  }
  return {
    region: rows[0].region ?? null,
    machine: (rows[0].metadata?.machine ?? {}) as HostMachine,
  };
}

type RootfsRusticRepoConfig = {
  repo_toml: string;
  repo_selector: string;
  repo_id?: string;
  repo_root?: string;
  artifact_backend: RootfsReleaseArtifactBackend;
  region?: string;
  bucket?: BucketRow | null;
};

async function buildSelfHostRootfsRusticRepoConfig(): Promise<RootfsRusticRepoConfig> {
  const repo = await buildLaunchpadRestRusticRepoConfig({
    root: ROOTFS_RUSTIC_REPO_ROOT,
    password: await getRootfsRusticSharedSecret(),
  });
  if (!repo) {
    throw new Error("self-host local rest-server is not configured");
  }
  return {
    repo_toml: repo.repo_toml,
    repo_selector: repo.repo_selector,
    artifact_backend: "rest",
  };
}

async function buildHostedRootfsRusticRepoConfig(
  region: string,
  repo?: RootfsRusticRepoRow | null,
): Promise<RootfsRusticRepoConfig> {
  const normalizedRegion = normalizeRootfsRusticRegion(region);
  const selected =
    repo ??
    (
      await selectRootfsRusticRepoForArtifact({
        region: normalizedRegion,
      })
    ).repo;
  const bucket = selected.bucket_id
    ? await loadR2BucketById(selected.bucket_id)
    : await loadR2BucketForRegion(normalizedRegion);
  if (!bucket?.name) {
    throw new Error(
      `no usable R2 bucket configured for region '${normalizedRegion}'`,
    );
  }
  const root = `${selected.root ?? ""}`.trim();
  if (!root) {
    throw new Error(`RootFS rustic repo '${selected.id}' is missing root`);
  }
  const settings = await getServerSettings();
  const accountId = `${settings.r2_account_id ?? ""}`.trim() || undefined;
  const accessKey =
    `${settings.r2_access_key_id ?? ""}`.trim() ||
    bucket.access_key_id ||
    undefined;
  const secretKey =
    `${settings.r2_secret_access_key ?? ""}`.trim() ||
    bucket.secret_access_key ||
    undefined;
  const endpoint =
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined) ??
    bucket.endpoint ??
    undefined;
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error(`missing R2 credentials for region '${region}'`);
  }
  return {
    repo_toml: buildRootfsRusticS3Toml({
      endpoint,
      bucket: bucket.name,
      root,
      accessKey,
      secretKey,
      password:
        `${selected.secret ?? ""}`.trim() ||
        (await getRootfsRusticSharedSecret()),
    }),
    repo_selector: `r2:rootfs-images:${normalizedRegion}:${selected.id}`,
    repo_id: selected.id,
    repo_root: root,
    artifact_backend: "r2",
    region: normalizedRegion,
    bucket,
  };
}

async function buildLegacyHostedRootfsRusticRepoConfig(
  region: string,
): Promise<RootfsRusticRepoConfig> {
  const normalizedRegion = normalizeRootfsRusticRegion(region);
  const bucket = await loadR2BucketForRegion(normalizedRegion);
  if (!bucket?.name) {
    throw new Error(
      `no usable R2 bucket configured for region '${normalizedRegion}'`,
    );
  }
  const settings = await getServerSettings();
  const accountId = `${settings.r2_account_id ?? ""}`.trim() || undefined;
  const accessKey =
    `${settings.r2_access_key_id ?? ""}`.trim() ||
    bucket.access_key_id ||
    undefined;
  const secretKey =
    `${settings.r2_secret_access_key ?? ""}`.trim() ||
    bucket.secret_access_key ||
    undefined;
  const endpoint =
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined) ??
    bucket.endpoint ??
    undefined;
  if (!endpoint || !accessKey || !secretKey) {
    throw new Error(`missing R2 credentials for region '${normalizedRegion}'`);
  }
  return {
    repo_toml: buildRootfsRusticS3Toml({
      endpoint,
      bucket: bucket.name,
      root: ROOTFS_RUSTIC_REPO_ROOT,
      accessKey,
      secretKey,
      password: await getRootfsRusticSharedSecret(),
    }),
    repo_selector: `r2:rootfs-images:${normalizedRegion}`,
    repo_root: ROOTFS_RUSTIC_REPO_ROOT,
    artifact_backend: "r2",
    region: normalizedRegion,
    bucket,
  };
}

async function buildRootfsRusticRepoConfigForHost(
  host_id: string,
  opts?: {
    preferred_repo_id?: string | null;
    source_image?: string | null;
    parent_release_id?: string | null;
  },
): Promise<RootfsRusticRepoConfig> {
  const { region, machine } = await loadHostStorageContext(host_id);
  if (isSelfHostLocalMachine(machine)) {
    return await buildSelfHostRootfsRusticRepoConfig();
  }
  const mappedRegion = mapCloudRegionToR2Region(region ?? DEFAULT_R2_REGION);
  const { repo } = await selectRootfsRusticRepoForArtifact({
    region: mappedRegion,
    preferred_repo_id: opts?.preferred_repo_id,
    source_image: opts?.source_image,
    parent_release_id: opts?.parent_release_id,
  });
  return await buildHostedRootfsRusticRepoConfig(mappedRegion, repo);
}

async function buildRootfsRusticRepoConfigForRelease(
  release: RootfsReleaseRow,
): Promise<RootfsRusticRepoConfig> {
  const info = decodeRusticArtifactPath(release.artifact_path);
  if (!info) {
    throw new Error(
      `release '${release.release_id}' is missing rustic artifact metadata`,
    );
  }
  if (info.artifact_backend === "rest") {
    return await buildSelfHostRootfsRusticRepoConfig();
  }
  const repo = await loadRootfsRusticRepoById(release.repo_id ?? info.repo_id);
  if (repo) {
    return await buildHostedRootfsRusticRepoConfig(
      repo.region ?? info.region ?? DEFAULT_R2_REGION,
      repo,
    );
  }
  return await buildLegacyHostedRootfsRusticRepoConfig(
    info.region ?? DEFAULT_R2_REGION,
  );
}

async function buildRootfsRusticRepoConfigForReplica(
  replica: RootfsReleaseArtifactReplicaRow,
): Promise<RootfsRusticRepoConfig> {
  if (replica.backend === "rest") {
    return await buildSelfHostRootfsRusticRepoConfig();
  }
  const info = decodeRusticArtifactPath(replica.artifact_path);
  const repo = await loadRootfsRusticRepoById(replica.repo_id ?? info?.repo_id);
  if (repo) {
    return await buildHostedRootfsRusticRepoConfig(
      repo.region ?? replica.region ?? DEFAULT_R2_REGION,
      repo,
    );
  }
  return await buildLegacyHostedRootfsRusticRepoConfig(
    replica.region ?? info?.region ?? DEFAULT_R2_REGION,
  );
}

async function ensureRootfsRusticRepoProfile({
  repo_selector,
  repo_toml,
}: RootfsRusticRepoConfig): Promise<string> {
  const digest = createHash("sha256")
    .update(`${repo_selector}\0${repo_toml}`)
    .digest("hex");
  const dir = join(secrets, "rustic", "rootfs-images");
  const path = join(dir, `${digest}.toml`);
  try {
    if ((await readFile(path, "utf8")) === repo_toml) {
      return path;
    }
  } catch {
    // write below
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, repo_toml, { mode: 0o600 });
  return path;
}

async function listReadyRusticReleaseArtifactReplicas(
  release_id: string,
): Promise<RootfsReleaseArtifactReplicaRow[]> {
  await ensureRootfsRusticRepoSchema();
  const { rows } = await getPool(
    "medium",
  ).query<RootfsReleaseArtifactReplicaRow>(
    `SELECT
      artifact_id,
      release_id,
      content_key,
      backend,
      region,
      bucket_id,
      bucket_name,
      bucket_purpose,
      artifact_kind,
      artifact_format,
      artifact_path,
      repo_id,
      artifact_sha256,
      artifact_bytes,
      status,
      replicated_from_artifact_id,
      error
    FROM rootfs_release_artifacts
    WHERE release_id=$1
      AND artifact_format='rustic'
      AND status='ready'
    ORDER BY updated DESC NULLS LAST, created DESC`,
    [release_id],
  );
  return rows;
}

async function listReleaseArtifactReplicas(
  release_id: string,
): Promise<RootfsReleaseArtifactReplicaRow[]> {
  await ensureRootfsRusticRepoSchema();
  const { rows } = await getPool(
    "medium",
  ).query<RootfsReleaseArtifactReplicaRow>(
    `SELECT
      artifact_id,
      release_id,
      content_key,
      backend,
      region,
      bucket_id,
      bucket_name,
      bucket_purpose,
      artifact_kind,
      artifact_format,
      artifact_path,
      repo_id,
      artifact_sha256,
      artifact_bytes,
      status,
      replicated_from_artifact_id,
      error
    FROM rootfs_release_artifacts
    WHERE release_id=$1
    ORDER BY updated DESC NULLS LAST, created DESC`,
    [release_id],
  );
  return rows;
}

async function resolveReplicaBucket(
  replica: RootfsReleaseArtifactReplicaRow,
): Promise<BucketRow | null> {
  if (replica.bucket_id) {
    const byId = await loadR2BucketById(replica.bucket_id);
    if (byId) return byId;
  }
  if (replica.bucket_name) {
    const byName = await loadR2BucketByName(replica.bucket_name);
    if (byName) return byName;
  }
  if (replica.region) {
    return await loadR2BucketForRegion(replica.region);
  }
  return null;
}

export async function upsertReleaseArtifactReplica({
  artifact_id,
  release_id,
  content_key,
  backend,
  region,
  bucket,
  artifact_kind,
  artifact_format,
  artifact_path,
  repo_id,
  artifact_sha256,
  artifact_bytes,
  status,
  error,
}: {
  artifact_id?: string;
  release_id: string;
  content_key: string;
  backend: RootfsReleaseArtifactBackend;
  region?: string | null;
  bucket?: BucketRow | null;
  artifact_kind: RootfsReleaseArtifactKind;
  artifact_format: RootfsReleaseArtifactFormat;
  artifact_path: string;
  repo_id?: string | null;
  artifact_sha256: string;
  artifact_bytes: number;
  status: string;
  error?: string | null;
}): Promise<RootfsReleaseArtifactReplicaRow> {
  await ensureRootfsRusticRepoSchema();
  const id = artifact_id ?? uuid();
  const { rows } = await getPool(
    "medium",
  ).query<RootfsReleaseArtifactReplicaRow>(
    `INSERT INTO rootfs_release_artifacts
      (
        artifact_id,
        release_id,
        content_key,
        backend,
        region,
        bucket_id,
        bucket_name,
        bucket_purpose,
        artifact_kind,
        artifact_format,
        artifact_path,
        repo_id,
        artifact_sha256,
        artifact_bytes,
        status,
        replicated_from_artifact_id,
        error,
        created,
        updated
      )
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NULL, $16, NOW(), NOW())
      ON CONFLICT (artifact_id) DO UPDATE SET
        bucket_id = EXCLUDED.bucket_id,
        bucket_name = EXCLUDED.bucket_name,
        bucket_purpose = EXCLUDED.bucket_purpose,
        repo_id = EXCLUDED.repo_id,
        artifact_sha256 = EXCLUDED.artifact_sha256,
        artifact_bytes = EXCLUDED.artifact_bytes,
        status = EXCLUDED.status,
        error = EXCLUDED.error,
        updated = NOW()
      RETURNING
        artifact_id,
        release_id,
        content_key,
        backend,
        region,
        bucket_id,
        bucket_name,
        bucket_purpose,
        artifact_kind,
        artifact_format,
        artifact_path,
        repo_id,
        artifact_sha256,
        artifact_bytes,
        status,
        replicated_from_artifact_id,
        error`,
    [
      id,
      release_id,
      content_key,
      backend,
      region ?? null,
      bucket?.id ?? null,
      bucket?.name ?? null,
      bucket?.purpose ?? null,
      artifact_kind,
      artifact_format,
      artifact_path,
      repo_id ?? null,
      artifact_sha256,
      artifact_bytes,
      status,
      error ?? null,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `failed to upsert RootFS artifact replica for ${content_key}`,
    );
  }
  return row;
}

export async function loadRootfsReleaseByImage(
  image: string,
): Promise<RootfsReleaseRow | null> {
  await ensureRootfsRusticRepoSchema();
  const runtime_image = `${image ?? ""}`.trim();
  if (!runtime_image) {
    return null;
  }
  const { rows } = await getPool("medium").query<RootfsReleaseRow>(
    `SELECT
      release_id,
      content_key,
      runtime_image,
      source_image,
      parent_release_id,
      depth,
      arch,
      size_bytes,
      artifact_kind,
      artifact_format,
      artifact_backend,
      artifact_path,
      repo_id,
      artifact_sha256,
      artifact_bytes,
      inspect_json
    FROM rootfs_releases
    WHERE runtime_image=$1`,
    [runtime_image],
  );
  return rows[0] ?? null;
}

async function loadRootfsReleaseById(
  release_id?: string | null,
): Promise<RootfsReleaseRow | null> {
  await ensureRootfsRusticRepoSchema();
  const value = `${release_id ?? ""}`.trim();
  if (!value) {
    return null;
  }
  const { rows } = await getPool("medium").query<RootfsReleaseRow>(
    `SELECT
      release_id,
      content_key,
      runtime_image,
      source_image,
      parent_release_id,
      depth,
      arch,
      size_bytes,
      artifact_kind,
      artifact_format,
      artifact_backend,
      artifact_path,
      repo_id,
      artifact_sha256,
      artifact_bytes,
      inspect_json
    FROM rootfs_releases
    WHERE release_id=$1`,
    [value],
  );
  return rows[0] ?? null;
}

async function getReleaseDeleteBlockers(
  release: RootfsReleaseRow,
): Promise<RootfsDeleteBlockers> {
  const pool = getPool("medium");
  const [projects, catalogEntries, prepullEntries, childReleases] =
    await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(DISTINCT project_id)::TEXT AS count
         FROM (
           SELECT project_id
           FROM project_rootfs_states
           WHERE release_id=$1 OR runtime_image=$2
           UNION
           SELECT project_id
           FROM projects
           WHERE rootfs_image=$2
         ) AS retained_projects`,
        [release.release_id, release.runtime_image],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM rootfs_images
         WHERE release_id=$1 AND COALESCE(deleted, false)=false`,
        [release.release_id],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM rootfs_images
         WHERE release_id=$1 AND prepull=true AND COALESCE(deleted, false)=false`,
        [release.release_id],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::TEXT AS count
         FROM rootfs_releases
         WHERE parent_release_id=$1 AND COALESCE(gc_status, 'active') <> 'deleted'`,
        [release.release_id],
      ),
    ]);
  const projects_using_release = Number(projects.rows[0]?.count ?? 0);
  const catalog_entries_using_release = Number(
    catalogEntries.rows[0]?.count ?? 0,
  );
  const prepull_entries_using_release = Number(
    prepullEntries.rows[0]?.count ?? 0,
  );
  const child_releases = Number(childReleases.rows[0]?.count ?? 0);
  return {
    projects_using_release,
    catalog_entries_using_release,
    prepull_entries_using_release,
    child_releases,
    total:
      projects_using_release +
      catalog_entries_using_release +
      prepull_entries_using_release +
      child_releases,
  };
}

export async function upsertPublishedRootfsRelease({
  artifact,
  upload,
}: {
  artifact: PublishProjectRootfsArtifact;
  upload?: RootfsUploadedArtifactResult;
}): Promise<RootfsReleaseRow> {
  await ensureRootfsRusticRepoSchema();
  const content_key = normalizeContentKey(artifact.content_key);
  if (!upload) {
    throw new Error(
      `rustic RootFS upload metadata missing for content key ${content_key}`,
    );
  }
  const artifactKind: RootfsReleaseArtifactKind = "full";
  const artifactFormat: RootfsReleaseArtifactFormat = "rustic";
  const resolvedArtifactBackend = upload.artifact_backend;
  const resolvedArtifactPath = encodeRusticArtifactPath({
    artifact_backend: upload.artifact_backend,
    snapshot_id: upload.snapshot_id,
    region: upload.region,
    repo_id: upload.repo_id,
  });
  const resolvedRepoId = upload.repo_id ?? null;
  const artifactSha256 = upload.artifact_sha256 || content_key;
  const artifactBytes = upload.artifact_bytes;
  const depth = 0;
  const pool = getPool("medium");
  const existing = await loadRootfsReleaseRowByContentKey(content_key);
  const release_id = existing?.release_id ?? uuid();
  const { rows } = await pool.query<RootfsReleaseRow>(
    `INSERT INTO rootfs_releases
      (
        release_id,
        content_key,
        runtime_image,
        source_image,
        parent_release_id,
        depth,
        arch,
        size_bytes,
        artifact_kind,
        artifact_format,
        artifact_backend,
        artifact_path,
        repo_id,
        artifact_sha256,
        artifact_bytes,
        gc_status,
        blocked,
        scan_status,
        scan_tool,
        scanned_at,
        scan_summary,
        inspect_json,
        created,
        updated
      )
      VALUES
      (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, 'active', false, 'unknown', NULL, NULL, NULL, $16::JSONB, NOW(), NOW()
      )
      ON CONFLICT (content_key) DO UPDATE SET
        runtime_image = EXCLUDED.runtime_image,
        source_image = EXCLUDED.source_image,
        parent_release_id = EXCLUDED.parent_release_id,
        depth = EXCLUDED.depth,
        arch = EXCLUDED.arch,
        size_bytes = COALESCE(EXCLUDED.size_bytes, rootfs_releases.size_bytes),
        artifact_kind = EXCLUDED.artifact_kind,
        artifact_format = EXCLUDED.artifact_format,
        artifact_backend = EXCLUDED.artifact_backend,
        artifact_path = EXCLUDED.artifact_path,
        repo_id = EXCLUDED.repo_id,
        artifact_sha256 = EXCLUDED.artifact_sha256,
        artifact_bytes = EXCLUDED.artifact_bytes,
        gc_status = COALESCE(rootfs_releases.gc_status, EXCLUDED.gc_status),
        blocked = COALESCE(rootfs_releases.blocked, EXCLUDED.blocked),
        scan_status = COALESCE(rootfs_releases.scan_status, EXCLUDED.scan_status),
        scan_tool = COALESCE(rootfs_releases.scan_tool, EXCLUDED.scan_tool),
        scanned_at = COALESCE(rootfs_releases.scanned_at, EXCLUDED.scanned_at),
        scan_summary = COALESCE(rootfs_releases.scan_summary, EXCLUDED.scan_summary),
        inspect_json = COALESCE(EXCLUDED.inspect_json, rootfs_releases.inspect_json),
        updated = NOW()
      RETURNING
        release_id,
        content_key,
        runtime_image,
        source_image,
        parent_release_id,
        depth,
        arch,
        size_bytes,
        artifact_kind,
        artifact_format,
        artifact_backend,
        artifact_path,
        repo_id,
        artifact_sha256,
        artifact_bytes,
        inspect_json`,
    [
      release_id,
      content_key,
      artifact.image,
      artifact.source_image ?? null,
      null,
      depth,
      artifact.arch ?? null,
      artifact.size_bytes ?? null,
      artifactKind,
      artifactFormat,
      resolvedArtifactBackend,
      resolvedArtifactPath,
      resolvedRepoId,
      artifactSha256,
      artifactBytes,
      artifact.inspect_data ? JSON.stringify(artifact.inspect_data) : null,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`failed to upsert RootFS release for ${content_key}`);
  }
  return row;
}

async function resolveRootfsRusticAccess({
  host_id,
  release,
}: {
  host_id: string;
  release: RootfsReleaseRow;
}): Promise<
  Extract<RootfsReleaseArtifactAccess, { artifact_format: "rustic" }>
> {
  const primaryInfo = decodeRusticArtifactPath(release.artifact_path);
  if (!primaryInfo) {
    throw new Error(
      `rustic RootFS release '${release.release_id}' is missing snapshot metadata`,
    );
  }
  const { region: hostRegionRaw, machine } =
    await loadHostStorageContext(host_id);
  const hostIsSelfHostLocal = isSelfHostLocalMachine(machine);
  const hostRegion = hostIsSelfHostLocal
    ? undefined
    : mapCloudRegionToR2Region(hostRegionRaw ?? DEFAULT_R2_REGION);
  const candidates: Array<{
    artifact_backend: RootfsReleaseArtifactBackend;
    artifact_path: string;
    artifact_sha256: string;
    artifact_bytes: number;
    snapshot_id: string;
    region?: string;
    repo: RootfsRusticRepoConfig;
    distance: number;
  }> = [];
  const primaryRepo = await buildRootfsRusticRepoConfigForRelease(release);
  const primaryRegion = primaryInfo.region ?? primaryRepo.region;
  candidates.push({
    artifact_backend: primaryInfo.artifact_backend,
    artifact_path: release.artifact_path,
    artifact_sha256: release.artifact_sha256,
    artifact_bytes: release.artifact_bytes,
    snapshot_id: primaryInfo.snapshot_id,
    region: primaryRegion,
    repo: primaryRepo,
    distance: hostRegion
      ? rankR2RegionDistance(hostRegion, parseR2Region(primaryRegion))
      : 0,
  });

  for (const replica of await listReadyRusticReleaseArtifactReplicas(
    release.release_id,
  )) {
    const info = decodeRusticArtifactPath(replica.artifact_path);
    if (!info) {
      continue;
    }
    const repo = await buildRootfsRusticRepoConfigForReplica(replica);
    const region = info.region ?? replica.region ?? repo.region ?? undefined;
    candidates.push({
      artifact_backend: info.artifact_backend,
      artifact_path: replica.artifact_path,
      artifact_sha256: replica.artifact_sha256,
      artifact_bytes: replica.artifact_bytes,
      snapshot_id: info.snapshot_id,
      region,
      repo,
      distance: hostRegion
        ? rankR2RegionDistance(hostRegion, parseR2Region(region))
        : 0,
    });
  }

  candidates.sort((a, b) => a.distance - b.distance);
  const best = candidates[0];
  if (!best) {
    throw new Error(
      `rustic RootFS release '${release.release_id}' has no usable artifact access`,
    );
  }

  let regional_replication_target:
    | Extract<RootfsArtifactTransferTarget, { backend: "rustic" }>
    | undefined;
  if (
    hostRegion &&
    best.artifact_backend === "r2" &&
    best.distance > 0 &&
    !candidates.some((candidate) => candidate.distance === 0)
  ) {
    const { repo: targetRepo } = await selectRootfsRusticRepoForArtifact({
      region: hostRegion,
      source_image: release.runtime_image,
      parent_release_id: release.parent_release_id,
    });
    const target = await buildHostedRootfsRusticRepoConfig(
      hostRegion,
      targetRepo,
    );
    regional_replication_target = {
      backend: "rustic",
      repo_toml: target.repo_toml,
      repo_selector: target.repo_selector,
      repo_id: target.repo_id,
      repo_root: target.repo_root,
      artifact_backend: target.artifact_backend,
      region: target.region,
      bucket_id: target.bucket?.id,
      bucket_name: target.bucket?.name,
      bucket_purpose: target.bucket?.purpose ?? null,
    };
    logger.info("RootFS rustic release falling back to cross-region replica", {
      host_id,
      release_id: release.release_id,
      content_key: release.content_key,
      host_region: hostRegion,
      source_region: best.region,
      replicate_to_region: target.region,
    });
  }

  return {
    release_id: release.release_id,
    image: release.runtime_image,
    content_key: release.content_key,
    size_bytes: release.size_bytes ?? undefined,
    artifact_kind: "full",
    artifact_format: "rustic",
    artifact_backend: best.artifact_backend,
    artifact_sha256: best.artifact_sha256,
    artifact_bytes: best.artifact_bytes,
    artifact_path: best.artifact_path,
    snapshot_id: best.snapshot_id,
    repo_selector: best.repo.repo_selector,
    repo_toml: best.repo.repo_toml,
    repo_id: best.repo.repo_id,
    repo_root: best.repo.repo_root,
    region: best.region,
    regional_replication_target,
    inspect_data: release.inspect_json ?? undefined,
  };
}

export async function issueRootfsReleaseArtifactAccess({
  host_id,
  image,
}: {
  host_id: string;
  image: string;
}): Promise<RootfsReleaseArtifactAccess> {
  const release = await loadRootfsReleaseByImage(image);
  if (!release) {
    throw new Error(`RootFS release not found for image '${image}'`);
  }
  return await resolveRootfsRusticAccess({ host_id, release });
}

export async function recordManagedRootfsRusticReplica({
  image,
  upload,
}: {
  image: string;
  upload: Extract<RootfsUploadedArtifactResult, { backend: "rustic" }>;
}): Promise<RootfsReleaseArtifactReplicaRow> {
  const release = await loadRootfsReleaseByImage(image);
  if (!release) {
    throw new Error(`RootFS release not found for image '${image}'`);
  }
  if (release.artifact_format !== "rustic") {
    throw new Error(`RootFS release '${image}' is not rustic-backed`);
  }
  const artifact_backend = upload.artifact_backend;
  const region =
    artifact_backend === "r2"
      ? `${upload.region ?? ""}`.trim() || DEFAULT_R2_REGION
      : undefined;
  const bucket =
    artifact_backend === "r2"
      ? await resolveReplicaBucket({
          artifact_id: "",
          release_id: release.release_id,
          content_key: release.content_key,
          backend: artifact_backend,
          region: region ?? null,
          bucket_id: upload.bucket_id ?? null,
          bucket_name: upload.bucket_name ?? null,
          bucket_purpose: upload.bucket_purpose ?? null,
          artifact_kind: "full",
          artifact_format: "rustic",
          artifact_path: "",
          repo_id: upload.repo_id ?? null,
          artifact_sha256: upload.artifact_sha256,
          artifact_bytes: upload.artifact_bytes,
          status: "ready",
          replicated_from_artifact_id: null,
          error: null,
        })
      : null;
  return await upsertReleaseArtifactReplica({
    release_id: release.release_id,
    content_key: release.content_key,
    backend: artifact_backend,
    region,
    bucket,
    artifact_kind: "full",
    artifact_format: "rustic",
    artifact_path: encodeRusticArtifactPath({
      artifact_backend,
      snapshot_id: upload.snapshot_id,
      region,
      repo_id: upload.repo_id,
    }),
    repo_id: upload.repo_id ?? null,
    artifact_sha256: upload.artifact_sha256,
    artifact_bytes: upload.artifact_bytes,
    status: "ready",
    error: null,
  });
}

async function forgetRootfsRusticReplica(
  replica: RootfsReleaseArtifactReplicaRow,
): Promise<void> {
  const info = decodeRusticArtifactPath(replica.artifact_path);
  if (!info) {
    throw new Error(
      `replica '${replica.artifact_id}' is missing rustic snapshot metadata`,
    );
  }
  const repo = await buildRootfsRusticRepoConfigForReplica(replica);
  const repoProfile = await ensureRootfsRusticRepoProfile(repo);
  await rustic(["forget", info.snapshot_id], {
    repo: repoProfile,
    host: replica.release_id,
    timeout: 10 * 60 * 1000,
  });
}

async function deleteReplicaObject(
  replica: RootfsReleaseArtifactReplicaRow,
): Promise<void> {
  await forgetRootfsRusticReplica(replica);
}

async function markReleaseArtifactReplica({
  artifact_id,
  status,
  error,
}: {
  artifact_id: string;
  status: string;
  error?: string | null;
}): Promise<void> {
  await getPool("medium").query(
    `UPDATE rootfs_release_artifacts
     SET status=$2,
         error=$3,
         updated=NOW()
     WHERE artifact_id=$1`,
    [artifact_id, status, error ?? null],
  );
}

async function forgetRootfsRusticRelease(
  release: RootfsReleaseRow,
): Promise<void> {
  const info = decodeRusticArtifactPath(release.artifact_path);
  if (!info) {
    throw new Error(
      `release '${release.release_id}' is missing rustic snapshot metadata`,
    );
  }
  const repo = await buildRootfsRusticRepoConfigForRelease(release);
  const repoProfile = await ensureRootfsRusticRepoProfile(repo);
  await rustic(["forget", info.snapshot_id], {
    repo: repoProfile,
    host: release.runtime_image,
    timeout: 10 * 60 * 1000,
  });
}

export async function gcRootfsRelease({
  release_id,
}: {
  release_id: string;
}): Promise<RootfsReleaseGcItem> {
  const release = await loadRootfsReleaseById(release_id);
  if (!release) {
    return {
      release_id,
      content_key: "",
      image: "",
      status: "skipped",
      error: "release not found",
    };
  }
  const blockers = await getReleaseDeleteBlockers(release);
  if (blockers.total > 0) {
    await getPool("medium").query(
      `UPDATE rootfs_releases
       SET gc_status='blocked',
           updated=NOW()
       WHERE release_id=$1`,
      [release_id],
    );
    return {
      release_id: release.release_id,
      content_key: release.content_key,
      image: release.runtime_image,
      status: "blocked",
      blockers,
    };
  }

  const replicas = await listReleaseArtifactReplicas(release.release_id);
  let deletedReplicas = 0;
  try {
    await forgetRootfsRusticRelease(release);
    for (const replica of replicas) {
      if (replica.status === "deleted") continue;
      await deleteReplicaObject(replica);
      await markReleaseArtifactReplica({
        artifact_id: replica.artifact_id,
        status: "deleted",
      });
      deletedReplicas += 1;
    }
    await getPool("medium").query(
      `UPDATE rootfs_releases
       SET gc_status='deleted',
           updated=NOW()
       WHERE release_id=$1`,
      [release.release_id],
    );
    await appendRootfsImageEventForReleaseImages({
      release_id: release.release_id,
      event_type: "release_gc_deleted",
      payload: {
        deleted_replicas: deletedReplicas,
      },
    });
    return {
      release_id: release.release_id,
      content_key: release.content_key,
      image: release.runtime_image,
      status: "deleted",
      deleted_replicas: deletedReplicas,
      blockers,
    };
  } catch (err) {
    await getPool("medium").query(
      `UPDATE rootfs_releases
       SET gc_status='blocked',
           updated=NOW()
       WHERE release_id=$1`,
      [release.release_id],
    );
    await appendRootfsImageEventForReleaseImages({
      release_id: release.release_id,
      event_type: "release_gc_failed",
      payload: {
        deleted_replicas: deletedReplicas,
        error: `${err}`,
      },
    });
    return {
      release_id: release.release_id,
      content_key: release.content_key,
      image: release.runtime_image,
      status: "failed",
      blockers,
      deleted_replicas: deletedReplicas,
      error: `${err}`,
    };
  }
}

export async function runPendingRootfsReleaseGc({
  limit = 10,
}: {
  limit?: number;
} = {}): Promise<RootfsReleaseGcRunResult> {
  const { rows } = await getPool("medium").query<{ release_id: string }>(
    `SELECT release_id
     FROM rootfs_releases
     WHERE gc_status='pending_delete'
     ORDER BY delete_requested_at ASC NULLS LAST, updated ASC NULLS LAST, created ASC
     LIMIT $1`,
    [Math.max(1, Math.min(1000, limit))],
  );
  const items: RootfsReleaseGcItem[] = [];
  for (const row of rows) {
    items.push(await gcRootfsRelease({ release_id: row.release_id }));
  }
  return {
    scanned: rows.length,
    deleted: items.filter((item) => item.status === "deleted").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    failed: items.filter((item) => item.status === "failed").length,
    items,
  };
}
