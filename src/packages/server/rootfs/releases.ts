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
import { appendRootfsImageEventForReleaseImages } from "@cocalc/server/rootfs/events";
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
  artifact_sha256: string;
  artifact_bytes: number;
  status: string;
  replicated_from_artifact_id: string | null;
  error: string | null;
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
};

function encodeRusticArtifactPath({
  artifact_backend,
  snapshot_id,
  region,
}: RootfsRusticArtifactPath): string {
  const backend = `${artifact_backend ?? ""}`.trim();
  const snapshot = `${snapshot_id ?? ""}`.trim();
  if (!backend || !snapshot) {
    throw new Error("invalid rustic RootFS artifact path");
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
}: {
  host_id: string;
  artifact_kind?: RootfsReleaseArtifactKind;
}): Promise<RootfsArtifactTransferTarget> {
  if (artifact_kind !== "full") {
    throw new Error(
      "managed RootFS releases are always stored as full rustic snapshots",
    );
  }
  const repo = await buildRootfsRusticRepoConfigForHost(host_id);
  return {
    backend: "rustic",
    repo_toml: repo.repo_toml,
    repo_selector: repo.repo_selector,
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
    WHERE provider='r2'
      AND purpose='project-backups'
      AND region=$1
      AND (status IS NULL OR status != 'disabled')
    ORDER BY created DESC
    LIMIT 1`,
    [region],
  );
  return rows[0] ?? null;
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

function buildRootfsRusticS3Toml({
  endpoint,
  bucket,
  accessKey,
  secretKey,
  password,
}: {
  endpoint: string;
  bucket: string;
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
    `root = "${ROOTFS_RUSTIC_REPO_ROOT}"`,
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
): Promise<RootfsRusticRepoConfig> {
  const bucket = await loadR2BucketForRegion(region);
  if (!bucket?.name) {
    throw new Error(`no usable R2 bucket configured for region '${region}'`);
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
      accessKey,
      secretKey,
      password: await getRootfsRusticSharedSecret(),
    }),
    repo_selector: `r2:rootfs-images:${region}`,
    artifact_backend: "r2",
    region,
    bucket,
  };
}

async function buildRootfsRusticRepoConfigForHost(
  host_id: string,
): Promise<RootfsRusticRepoConfig> {
  const { region, machine } = await loadHostStorageContext(host_id);
  if (isSelfHostLocalMachine(machine)) {
    return await buildSelfHostRootfsRusticRepoConfig();
  }
  const mappedRegion = mapCloudRegionToR2Region(region ?? DEFAULT_R2_REGION);
  return await buildHostedRootfsRusticRepoConfig(mappedRegion);
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
  return await buildHostedRootfsRusticRepoConfig(
    info.region ?? DEFAULT_R2_REGION,
  );
}

async function buildRootfsRusticRepoConfigForReplica(
  replica: RootfsReleaseArtifactReplicaRow,
): Promise<RootfsRusticRepoConfig> {
  if (replica.backend === "rest") {
    return await buildSelfHostRootfsRusticRepoConfig();
  }
  return await buildHostedRootfsRusticRepoConfig(
    replica.region ?? DEFAULT_R2_REGION,
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
  artifact_sha256: string;
  artifact_bytes: number;
  status: string;
  error?: string | null;
}): Promise<RootfsReleaseArtifactReplicaRow> {
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
        artifact_sha256,
        artifact_bytes,
        status,
        replicated_from_artifact_id,
        error,
        created,
        updated
      )
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, $15, NOW(), NOW())
      ON CONFLICT (artifact_id) DO UPDATE SET
        bucket_id = EXCLUDED.bucket_id,
        bucket_name = EXCLUDED.bucket_name,
        bucket_purpose = EXCLUDED.bucket_purpose,
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
  });
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
        $9, $10, $11, $12, $13, $14, 'active', false, 'unknown', NULL, NULL, NULL, $15::JSONB, NOW(), NOW()
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
  }> = [
    {
      artifact_backend: primaryInfo.artifact_backend,
      artifact_path: release.artifact_path,
      artifact_sha256: release.artifact_sha256,
      artifact_bytes: release.artifact_bytes,
      snapshot_id: primaryInfo.snapshot_id,
      region: primaryInfo.region,
      repo: await buildRootfsRusticRepoConfigForRelease(release),
      distance: hostRegion
        ? rankR2RegionDistance(hostRegion, parseR2Region(primaryInfo.region))
        : 0,
    },
  ];

  for (const replica of await listReadyRusticReleaseArtifactReplicas(
    release.release_id,
  )) {
    const info = decodeRusticArtifactPath(replica.artifact_path);
    if (!info) {
      continue;
    }
    candidates.push({
      artifact_backend: info.artifact_backend,
      artifact_path: replica.artifact_path,
      artifact_sha256: replica.artifact_sha256,
      artifact_bytes: replica.artifact_bytes,
      snapshot_id: info.snapshot_id,
      region: info.region ?? replica.region ?? undefined,
      repo: await buildRootfsRusticRepoConfigForReplica(replica),
      distance: hostRegion
        ? rankR2RegionDistance(
            hostRegion,
            parseR2Region(info.region ?? replica.region),
          )
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
    const target = await buildHostedRootfsRusticRepoConfig(hostRegion);
    regional_replication_target = {
      backend: "rustic",
      repo_toml: target.repo_toml,
      repo_selector: target.repo_selector,
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
    }),
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
