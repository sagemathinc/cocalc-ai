/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import basePath from "@cocalc/backend/base-path";
import { data, secrets } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import rustic from "@cocalc/backend/sandbox/rustic";
import type { HostMachine } from "@cocalc/conat/hub/api/hosts";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { buildLaunchpadRestRusticRepoConfig } from "@cocalc/server/launchpad/rest-repo";
import {
  deleteObject,
  uploadObjectFromBuffer,
  uploadObjectFromFile,
  issueSignedObjectDownload,
} from "@cocalc/server/project-backup/r2";
import { appendRootfsImageEventForReleaseImages } from "@cocalc/server/rootfs/events";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  parseR2Region,
  rankR2RegionDistance,
  type R2Region,
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

export const ROOTFS_RELEASE_ARTIFACT_ROUTE_PREFIX = "/rootfs/releases";
const ROOTFS_RELEASE_ARTIFACT_ROOT = join(data, "rootfs", "releases");
const ROOTFS_RELEASE_R2_PREFIX = "rootfs/releases";
const ROOTFS_RELEASE_TOKEN_SECRET_PATH = join(
  secrets,
  "rootfs-release-artifact-token-key",
);
const ROOTFS_RUSTIC_SHARED_SECRET_PATH = join(
  secrets,
  "rootfs-rustic-shared-secret",
);
const ROOTFS_RELEASE_ARTIFACT_FORMAT: RootfsReleaseArtifactFormat =
  "btrfs-send";
const ROOTFS_RELEASE_ARTIFACT_BACKEND: RootfsReleaseArtifactBackend =
  "hub-local";
const ROOTFS_RELEASE_UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;
const ROOTFS_RELEASE_R2_MULTIPART_PART_BYTES = 64 * 1024 * 1024;
const ROOTFS_RELEASE_R2_MULTIPART_CONCURRENCY = 8;
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

type RootfsStoredArtifactMetadata = {
  artifact_sha256: string;
  artifact_bytes: number;
  uploaded_at: string;
};

type RootfsArtifactTokenPayload = {
  kind: "upload" | "download";
  host_id: string;
  content_key: string;
  exp: number;
};

function normalizeContentKey(content_key?: string | null): string {
  const value = `${content_key ?? ""}`.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid RootFS content key");
  }
  return value;
}

export function configuredRootfsArtifactFormat(): RootfsReleaseArtifactFormat {
  const raw = `${process.env.COCALC_ROOTFS_ARTIFACT_FORMAT ?? ""}`
    .trim()
    .toLowerCase();
  if (raw === "btrfs-send" || raw === "btrfs_stream" || raw === "btrfs") {
    return "btrfs-send";
  }
  return "rustic";
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

function artifactRelativePath(
  content_key: string,
  artifact_kind: RootfsReleaseArtifactKind = "full",
  parent_content_key?: string | null,
): string {
  const key = normalizeContentKey(content_key);
  if (artifact_kind === "delta") {
    const parent = normalizeContentKey(parent_content_key);
    return `${key.slice(0, 2)}/${key}/delta-from-${parent}.btrfs`;
  }
  return `${key.slice(0, 2)}/${key}/full.btrfs`;
}

function r2ArtifactKey(
  content_key: string,
  artifact_kind: RootfsReleaseArtifactKind = "full",
  parent_content_key?: string | null,
): string {
  const key = normalizeContentKey(content_key);
  if (artifact_kind === "delta") {
    const parent = normalizeContentKey(parent_content_key);
    return `${ROOTFS_RELEASE_R2_PREFIX}/${key}/delta-from-${parent}.btrfs`;
  }
  return `${ROOTFS_RELEASE_R2_PREFIX}/${key}/full.btrfs`;
}

function r2ArtifactShaKey(
  content_key: string,
  artifact_kind: RootfsReleaseArtifactKind = "full",
  parent_content_key?: string | null,
): string {
  return `${r2ArtifactKey(content_key, artifact_kind, parent_content_key)}.sha256`;
}

export function rootfsReleaseArtifactLocalPath(content_key: string): string {
  return join(ROOTFS_RELEASE_ARTIFACT_ROOT, artifactRelativePath(content_key));
}

function rootfsReleaseArtifactMetadataPath(content_key: string): string {
  return `${rootfsReleaseArtifactLocalPath(content_key)}.json`;
}

function rootfsReleaseArtifactUploadTempPath(
  content_key: string,
  upload_id: string,
): string {
  const normalizedUploadId = `${upload_id ?? ""}`.trim().toLowerCase();
  if (!/^[0-9a-f-]{16,64}$/.test(normalizedUploadId)) {
    throw new Error("invalid RootFS artifact upload id");
  }
  return `${rootfsReleaseArtifactLocalPath(content_key)}.upload-${normalizedUploadId}.tmp`;
}

function artifactRoute(content_key: string): string {
  return `${ROOTFS_RELEASE_ARTIFACT_ROUTE_PREFIX}/${normalizeContentKey(content_key)}/artifact`;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = normalized.length % 4;
  const padded =
    padLen === 0 ? normalized : normalized + "=".repeat(4 - padLen);
  return Buffer.from(padded, "base64");
}

let tokenSecretCache: Buffer | undefined;

async function getTokenSecret(): Promise<Buffer> {
  if (tokenSecretCache) return tokenSecretCache;
  let encoded = "";
  try {
    encoded = (await readFile(ROOTFS_RELEASE_TOKEN_SECRET_PATH, "utf8")).trim();
  } catch {}
  if (!encoded) {
    encoded = randomBytes(32).toString("base64");
    await mkdir(secrets, { recursive: true });
    await writeFile(ROOTFS_RELEASE_TOKEN_SECRET_PATH, encoded, { mode: 0o600 });
  }
  tokenSecretCache = Buffer.from(encoded, "base64");
  if (tokenSecretCache.length !== 32) {
    throw new Error("invalid RootFS artifact token secret length");
  }
  return tokenSecretCache;
}

async function signToken(payload: RootfsArtifactTokenPayload): Promise<string> {
  const secret = await getTokenSecret();
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest();
  return `${body}.${base64UrlEncode(sig)}`;
}

export async function verifyRootfsArtifactToken({
  token,
  kind,
  content_key,
}: {
  token?: string;
  kind: "upload" | "download";
  content_key: string;
}): Promise<RootfsArtifactTokenPayload> {
  const raw = `${token ?? ""}`.trim();
  if (!raw) {
    throw new Error("missing RootFS artifact token");
  }
  const [body, sig] = raw.split(".");
  if (!body || !sig) {
    throw new Error("invalid RootFS artifact token format");
  }
  const secret = await getTokenSecret();
  const expected = base64UrlEncode(
    createHmac("sha256", secret).update(body).digest(),
  );
  if (expected !== sig) {
    throw new Error("invalid RootFS artifact token signature");
  }
  const payload = JSON.parse(
    base64UrlDecode(body).toString("utf8"),
  ) as RootfsArtifactTokenPayload;
  if (payload.kind !== kind) {
    throw new Error("invalid RootFS artifact token kind");
  }
  if (payload.content_key !== normalizeContentKey(content_key)) {
    throw new Error("invalid RootFS artifact token content key");
  }
  if (!payload.host_id?.trim()) {
    throw new Error("invalid RootFS artifact token host_id");
  }
  if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) {
    throw new Error("expired RootFS artifact token");
  }
  return payload;
}

async function getArtifactBaseUrl(): Promise<string> {
  const { dns } = await getServerSettings();
  let url = `${dns ?? ""}`.trim();
  if (!url) {
    throw new Error("public site URL is not configured");
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  if (basePath?.length) {
    url = `${url.replace(/\/+$/, "")}${basePath.startsWith("/") ? "" : "/"}${basePath}`;
  }
  return url.replace(/\/+$/, "");
}

export async function issueRootfsReleaseArtifactUpload({
  host_id,
  content_key,
  artifact_kind = "full",
  parent_content_key,
  ttl_ms = 15 * 60 * 1000,
}: {
  host_id: string;
  content_key?: string;
  artifact_kind?: RootfsReleaseArtifactKind;
  parent_content_key?: string | null;
  ttl_ms?: number;
}): Promise<RootfsArtifactTransferTarget> {
  if (configuredRootfsArtifactFormat() === "rustic") {
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
  if (!content_key) {
    throw new Error(
      "content_key is required when issuing non-rustic RootFS artifact uploads",
    );
  }
  const key = normalizeContentKey(content_key);
  const artifactPath = r2ArtifactKey(key, artifact_kind, parent_content_key);
  const region = await resolveHostR2Region(host_id);
  const bucket = await loadR2BucketForRegion(region);
  if (
    bucket?.name &&
    bucket.endpoint &&
    bucket.access_key_id &&
    bucket.secret_access_key
  ) {
    return {
      backend: "r2",
      method: "PUT",
      region,
      bucket_id: bucket.id,
      bucket_name: bucket.name,
      bucket_purpose: bucket.purpose,
      artifact_path: artifactPath,
      endpoint: bucket.endpoint,
      access_key_id: bucket.access_key_id,
      secret_access_key: bucket.secret_access_key,
      multipart_part_bytes: ROOTFS_RELEASE_R2_MULTIPART_PART_BYTES,
      multipart_concurrency: ROOTFS_RELEASE_R2_MULTIPART_CONCURRENCY,
    };
  }
  const token = await signToken({
    kind: "upload",
    host_id,
    content_key: key,
    exp: Date.now() + ttl_ms,
  });
  const base = await getArtifactBaseUrl();
  return {
    backend: "hub-local",
    method: "PUT",
    chunk_bytes: ROOTFS_RELEASE_UPLOAD_CHUNK_BYTES,
    url: `${base}${artifactRoute(key)}?token=${encodeURIComponent(token)}`,
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

async function resolveHostR2Region(host_id: string): Promise<R2Region> {
  const { rows } = await getPool("medium").query<{ region: string | null }>(
    `SELECT region FROM project_hosts WHERE id=$1`,
    [host_id],
  );
  const hostRegion = `${rows[0]?.region ?? ""}`.trim();
  const explicit = parseR2Region(hostRegion);
  if (explicit) return explicit;
  return mapCloudRegionToR2Region(hostRegion || DEFAULT_R2_REGION);
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

async function loadReleaseArtifactReplica({
  release_id,
  backend,
  region,
  artifact_path,
}: {
  release_id: string;
  backend: RootfsReleaseArtifactBackend;
  region?: string | null;
  artifact_path: string;
}): Promise<RootfsReleaseArtifactReplicaRow | null> {
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
      AND backend=$2
      AND COALESCE(region, '') = COALESCE($3, '')
      AND artifact_path=$4
    ORDER BY updated DESC NULLS LAST, created DESC
    LIMIT 1`,
    [release_id, backend, region ?? null, artifact_path],
  );
  return rows[0] ?? null;
}

async function listReadyReleaseArtifactReplicas(
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
      AND backend='r2'
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

async function resolveBestR2Replica({
  host_id,
  release,
}: {
  host_id: string;
  release: RootfsReleaseRow;
}): Promise<{
  replica: RootfsReleaseArtifactReplicaRow;
  bucket: BucketRow;
} | null> {
  const hostRegion = await resolveHostR2Region(host_id);
  const replicas = await listReadyReleaseArtifactReplicas(release.release_id);
  const usable: {
    replica: RootfsReleaseArtifactReplicaRow;
    bucket: BucketRow;
    distance: number;
    index: number;
  }[] = [];

  for (const [index, replica] of replicas.entries()) {
    if (
      replica.artifact_sha256 !== release.artifact_sha256 ||
      replica.artifact_bytes !== release.artifact_bytes
    ) {
      continue;
    }
    const bucket = await resolveReplicaBucket(replica);
    if (
      !bucket?.name ||
      !bucket.endpoint ||
      !bucket.access_key_id ||
      !bucket.secret_access_key
    ) {
      continue;
    }
    usable.push({
      replica,
      bucket,
      distance: rankR2RegionDistance(hostRegion, parseR2Region(replica.region)),
      index,
    });
  }

  usable.sort((a, b) => {
    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    return a.index - b.index;
  });

  const best = usable[0];
  if (!best) {
    return null;
  }
  if (best.distance > 0) {
    logger.info("RootFS artifact falling back to non-local R2 replica", {
      host_id,
      release_id: release.release_id,
      content_key: release.content_key,
      host_region: hostRegion,
      replica_region: best.replica.region,
      bucket_name: best.bucket.name,
    });
  }
  return { replica: best.replica, bucket: best.bucket };
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

export async function readStoredRootfsArtifactMetadata(
  content_key: string,
): Promise<RootfsStoredArtifactMetadata | null> {
  const path = rootfsReleaseArtifactMetadataPath(content_key);
  try {
    return JSON.parse(
      await readFile(path, "utf8"),
    ) as RootfsStoredArtifactMetadata;
  } catch {
    return null;
  }
}

export async function hasStoredRootfsArtifact(
  content_key: string,
): Promise<boolean> {
  try {
    await stat(rootfsReleaseArtifactLocalPath(content_key));
    return true;
  } catch {
    return false;
  }
}

export async function storeUploadedRootfsReleaseArtifact({
  content_key,
  input,
}: {
  content_key: string;
  input: NodeJS.ReadableStream;
}): Promise<RootfsStoredArtifactMetadata> {
  const key = normalizeContentKey(content_key);
  const finalPath = rootfsReleaseArtifactLocalPath(key);
  const metaPath = rootfsReleaseArtifactMetadataPath(key);
  const tmpPath = `${finalPath}.upload-${randomUUID()}.tmp`;
  await mkdir(join(ROOTFS_RELEASE_ARTIFACT_ROOT, key.slice(0, 2), key), {
    recursive: true,
  });

  const hash = createHash("sha256");
  let bytes = 0;
  input.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  });

  try {
    await pipeline(input as any, createWriteStream(tmpPath));
    const uploaded: RootfsStoredArtifactMetadata = {
      artifact_sha256: hash.digest("hex"),
      artifact_bytes: bytes,
      uploaded_at: new Date().toISOString(),
    };

    if (await hasStoredRootfsArtifact(key)) {
      const existing = await readStoredRootfsArtifactMetadata(key);
      await rm(tmpPath, { force: true });
      if (
        existing &&
        existing.artifact_sha256 === uploaded.artifact_sha256 &&
        existing.artifact_bytes === uploaded.artifact_bytes
      ) {
        return existing;
      }
      throw new Error(`conflicting RootFS artifact already exists for ${key}`);
    }

    await rename(tmpPath, finalPath);
    await writeFile(metaPath, JSON.stringify(uploaded, null, 2));
    return uploaded;
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function computeStoredArtifactMetadata(
  path: string,
): Promise<RootfsStoredArtifactMetadata> {
  const hash = createHash("sha256");
  let bytes = 0;
  const input = createReadStream(path);
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  }
  return {
    artifact_sha256: hash.digest("hex"),
    artifact_bytes: bytes,
    uploaded_at: new Date().toISOString(),
  };
}

export async function appendUploadedRootfsReleaseArtifactChunk({
  content_key,
  upload_id,
  part,
  parts,
  input,
}: {
  content_key: string;
  upload_id: string;
  part: number;
  parts: number;
  input: NodeJS.ReadableStream;
}): Promise<{ complete: boolean; metadata?: RootfsStoredArtifactMetadata }> {
  const key = normalizeContentKey(content_key);
  if (!Number.isInteger(part) || part < 0) {
    throw new Error("invalid RootFS artifact chunk part");
  }
  if (!Number.isInteger(parts) || parts <= 0 || part >= parts) {
    throw new Error("invalid RootFS artifact chunk count");
  }
  const finalPath = rootfsReleaseArtifactLocalPath(key);
  const metaPath = rootfsReleaseArtifactMetadataPath(key);
  const tmpPath = rootfsReleaseArtifactUploadTempPath(key, upload_id);
  await mkdir(join(ROOTFS_RELEASE_ARTIFACT_ROOT, key.slice(0, 2), key), {
    recursive: true,
  });
  if (part === 0) {
    await rm(tmpPath, { force: true }).catch(() => {});
  } else {
    try {
      await stat(tmpPath);
    } catch {
      throw new Error(
        `RootFS artifact upload chunk ${part + 1}/${parts} is missing its temporary upload state`,
      );
    }
  }
  const writer = createWriteStream(tmpPath, {
    flags: part === 0 ? "w" : "a",
  });
  try {
    await pipeline(input as any, writer);
    if (part < parts - 1) {
      return { complete: false };
    }
    const uploaded = await computeStoredArtifactMetadata(tmpPath);
    if (await hasStoredRootfsArtifact(key)) {
      const existing = await readStoredRootfsArtifactMetadata(key);
      await rm(tmpPath, { force: true }).catch(() => {});
      if (
        existing &&
        existing.artifact_sha256 === uploaded.artifact_sha256 &&
        existing.artifact_bytes === uploaded.artifact_bytes
      ) {
        return { complete: true, metadata: existing };
      }
      throw new Error(`conflicting RootFS artifact already exists for ${key}`);
    }
    await rename(tmpPath, finalPath);
    await writeFile(metaPath, JSON.stringify(uploaded, null, 2));
    return { complete: true, metadata: uploaded };
  } catch (err) {
    writer.destroy();
    if (part === parts - 1) {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
    throw err;
  }
}

export async function upsertPublishedRootfsRelease({
  artifact,
  upload,
  metadata,
  artifact_backend = ROOTFS_RELEASE_ARTIFACT_BACKEND,
  artifact_path,
}: {
  artifact: PublishProjectRootfsArtifact;
  upload?: RootfsUploadedArtifactResult;
  metadata?: RootfsStoredArtifactMetadata;
  artifact_backend?: RootfsReleaseArtifactBackend;
  artifact_path?: string;
}): Promise<RootfsReleaseRow> {
  const content_key = normalizeContentKey(artifact.content_key);
  let artifactKind: RootfsReleaseArtifactKind = "full";
  let artifactFormat: RootfsReleaseArtifactFormat =
    ROOTFS_RELEASE_ARTIFACT_FORMAT;
  let resolvedArtifactBackend = artifact_backend;
  let resolvedArtifactPath = artifact_path;
  let artifactSha256 = content_key;
  let artifactBytes = 0;
  let resolvedParentRelease: RootfsReleaseRow | null = null;
  let depth = 0;

  if (upload?.backend === "rustic") {
    artifactFormat = "rustic";
    resolvedArtifactBackend = upload.artifact_backend;
    resolvedArtifactPath =
      artifact_path ??
      encodeRusticArtifactPath({
        artifact_backend: upload.artifact_backend,
        snapshot_id: upload.snapshot_id,
        region: upload.region,
      });
    artifactSha256 = upload.artifact_sha256 || content_key;
    artifactBytes = upload.artifact_bytes;
  } else {
    const storedMetadata =
      upload?.backend === "r2"
        ? {
            artifact_sha256: upload.artifact_sha256,
            artifact_bytes: upload.artifact_bytes,
            uploaded_at: new Date().toISOString(),
          }
        : (metadata ?? (await readStoredRootfsArtifactMetadata(content_key)));
    if (!storedMetadata) {
      throw new Error(
        `stored RootFS artifact metadata missing for content key ${content_key}`,
      );
    }
    const parentRelease = artifact.parent_image
      ? await loadRootfsReleaseByImage(artifact.parent_image)
      : null;
    resolvedParentRelease =
      parentRelease?.content_key === content_key ? null : parentRelease;
    artifactKind =
      artifact.artifact_kind === "delta" && resolvedParentRelease
        ? "delta"
        : "full";
    depth =
      artifactKind === "delta" ? (resolvedParentRelease?.depth ?? 0) + 1 : 0;
    resolvedArtifactBackend =
      upload?.backend === "r2" ? "r2" : resolvedArtifactBackend;
    resolvedArtifactPath =
      artifact_path ??
      (upload?.backend === "r2"
        ? upload.artifact_path
        : artifactRelativePath(
            content_key,
            artifactKind,
            resolvedParentRelease?.content_key,
          ));
    artifactSha256 = storedMetadata.artifact_sha256;
    artifactBytes = storedMetadata.artifact_bytes;
  }
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
      resolvedParentRelease?.release_id ?? null,
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

export async function issueRootfsReleaseArtifactAccess({
  host_id,
  image,
  ttl_ms = 15 * 60 * 1000,
}: {
  host_id: string;
  image: string;
  ttl_ms?: number;
}): Promise<RootfsReleaseArtifactAccess> {
  const release = await loadRootfsReleaseByImage(image);
  if (!release) {
    throw new Error(`RootFS release not found for image '${image}'`);
  }
  if (release.artifact_format === "rustic") {
    const info = decodeRusticArtifactPath(release.artifact_path);
    if (!info) {
      throw new Error(
        `rustic RootFS release '${release.release_id}' is missing snapshot metadata`,
      );
    }
    const repo = await buildRootfsRusticRepoConfigForRelease(release);
    return {
      release_id: release.release_id,
      image: release.runtime_image,
      content_key: release.content_key,
      artifact_kind: "full",
      artifact_format: "rustic",
      artifact_backend: info.artifact_backend,
      artifact_sha256: release.artifact_sha256,
      artifact_bytes: release.artifact_bytes,
      artifact_path: release.artifact_path,
      snapshot_id: info.snapshot_id,
      repo_selector: repo.repo_selector,
      repo_toml: repo.repo_toml,
      region: info.region,
      inspect_data: release.inspect_json ?? undefined,
    };
  }
  const parentRelease = await loadRootfsReleaseById(release.parent_release_id);
  const bestReplica = await resolveBestR2Replica({ host_id, release });
  if (bestReplica) {
    const download = issueSignedObjectDownload({
      endpoint: bestReplica.bucket.endpoint!,
      accessKey: bestReplica.bucket.access_key_id!,
      secretKey: bestReplica.bucket.secret_access_key!,
      bucket: bestReplica.bucket.name,
      key: bestReplica.replica.artifact_path,
    });
    return {
      release_id: release.release_id,
      image: release.runtime_image,
      content_key: release.content_key,
      artifact_kind: bestReplica.replica.artifact_kind,
      artifact_format: "btrfs-send",
      artifact_backend: "r2",
      artifact_sha256: bestReplica.replica.artifact_sha256,
      artifact_bytes: bestReplica.replica.artifact_bytes,
      parent_release_id: parentRelease?.release_id ?? undefined,
      parent_image: parentRelease?.runtime_image ?? undefined,
      parent_content_key: parentRelease?.content_key ?? undefined,
      download_url: download.url,
      download_headers: download.headers,
      inspect_data: release.inspect_json ?? undefined,
    };
  }
  if (!(await hasStoredRootfsArtifact(release.content_key))) {
    throw new Error(
      `stored RootFS artifact missing for content key '${release.content_key}'`,
    );
  }
  const token = await signToken({
    kind: "download",
    host_id,
    content_key: release.content_key,
    exp: Date.now() + ttl_ms,
  });
  const base = await getArtifactBaseUrl();
  return {
    release_id: release.release_id,
    image: release.runtime_image,
    content_key: release.content_key,
    artifact_kind: release.artifact_kind,
    artifact_format: "btrfs-send",
    artifact_backend: release.artifact_backend,
    artifact_sha256: release.artifact_sha256,
    artifact_bytes: release.artifact_bytes,
    parent_release_id: parentRelease?.release_id ?? undefined,
    parent_image: parentRelease?.runtime_image ?? undefined,
    parent_content_key: parentRelease?.content_key ?? undefined,
    download_url: `${base}${artifactRoute(release.content_key)}?token=${encodeURIComponent(token)}`,
    inspect_data: release.inspect_json ?? undefined,
  };
}

export async function streamStoredRootfsReleaseArtifact(
  content_key: string,
  output: NodeJS.WritableStream,
): Promise<{ bytes: number; sha256?: string }> {
  const key = normalizeContentKey(content_key);
  const path = rootfsReleaseArtifactLocalPath(key);
  const metadata = await readStoredRootfsArtifactMetadata(key);
  await pipeline(createReadStream(path), output as any);
  return {
    bytes: metadata?.artifact_bytes ?? (await stat(path)).size,
    sha256: metadata?.artifact_sha256,
  };
}

export async function deleteStoredRootfsArtifact(
  content_key: string,
): Promise<void> {
  const key = normalizeContentKey(content_key);
  await rm(rootfsReleaseArtifactLocalPath(key), { force: true }).catch(
    () => {},
  );
  await rm(rootfsReleaseArtifactMetadataPath(key), { force: true }).catch(
    () => {},
  );
}

async function deleteReplicaObject(
  replica: RootfsReleaseArtifactReplicaRow,
): Promise<void> {
  if (replica.backend === "hub-local") {
    await deleteStoredRootfsArtifact(replica.content_key);
    return;
  }
  const bucket = await resolveReplicaBucket(replica);
  if (
    !bucket?.name ||
    !bucket.endpoint ||
    !bucket.access_key_id ||
    !bucket.secret_access_key
  ) {
    throw new Error(
      `missing bucket credentials for RootFS replica ${replica.artifact_id}`,
    );
  }
  const release = await loadRootfsReleaseById(replica.release_id);
  const parentRelease = await loadRootfsReleaseById(release?.parent_release_id);
  await deleteObject({
    endpoint: bucket.endpoint,
    accessKey: bucket.access_key_id,
    secretKey: bucket.secret_access_key,
    bucket: bucket.name,
    key: replica.artifact_path,
  });
  await deleteObject({
    endpoint: bucket.endpoint,
    accessKey: bucket.access_key_id,
    secretKey: bucket.secret_access_key,
    bucket: bucket.name,
    key: r2ArtifactShaKey(
      replica.content_key,
      replica.artifact_kind,
      parentRelease?.content_key,
    ),
  });
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
    if (release.artifact_format === "rustic") {
      await forgetRootfsRusticRelease(release);
    }
    for (const replica of replicas) {
      if (replica.status === "deleted") continue;
      await deleteReplicaObject(replica);
      await markReleaseArtifactReplica({
        artifact_id: replica.artifact_id,
        status: "deleted",
      });
      deletedReplicas += 1;
    }
    if (
      release.artifact_format === "btrfs-send" &&
      release.artifact_backend === "hub-local"
    ) {
      await deleteStoredRootfsArtifact(release.content_key);
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

export function rootfsReleaseArtifactContentType(): string {
  return "application/octet-stream";
}

export async function ensureRootfsReleaseR2ReplicaForHost({
  host_id,
  release,
}: {
  host_id: string;
  release: RootfsReleaseRow;
}): Promise<RootfsReleaseArtifactReplicaRow | null> {
  if (release.artifact_format === "rustic") {
    return null;
  }
  const parentRelease = await loadRootfsReleaseById(release.parent_release_id);
  const region = await resolveHostR2Region(host_id);
  const bucket = await loadR2BucketForRegion(region);
  if (
    !bucket?.name ||
    !bucket.endpoint ||
    !bucket.access_key_id ||
    !bucket.secret_access_key
  ) {
    logger.info("RootFS R2 replica skipped; no usable regional bucket", {
      host_id,
      release_id: release.release_id,
      content_key: release.content_key,
      region,
    });
    return null;
  }

  const key = normalizeContentKey(release.content_key);
  const artifactPath = r2ArtifactKey(
    key,
    release.artifact_kind,
    parentRelease?.content_key,
  );
  const existing = await loadReleaseArtifactReplica({
    release_id: release.release_id,
    backend: "r2",
    region,
    artifact_path: artifactPath,
  });
  if (
    existing?.status === "ready" &&
    existing.artifact_sha256 === release.artifact_sha256 &&
    existing.artifact_bytes === release.artifact_bytes
  ) {
    return existing;
  }

  const pending = await upsertReleaseArtifactReplica({
    artifact_id: existing?.artifact_id,
    release_id: release.release_id,
    content_key: key,
    backend: "r2",
    region,
    bucket,
    artifact_kind: release.artifact_kind,
    artifact_format: release.artifact_format,
    artifact_path: artifactPath,
    artifact_sha256: release.artifact_sha256,
    artifact_bytes: release.artifact_bytes,
    status: "pending",
    error: null,
  });

  try {
    await uploadObjectFromFile({
      endpoint: bucket.endpoint,
      accessKey: bucket.access_key_id,
      secretKey: bucket.secret_access_key,
      bucket: bucket.name,
      key: artifactPath,
      filePath: rootfsReleaseArtifactLocalPath(key),
      artifactSha256: release.artifact_sha256,
      artifactBytes: release.artifact_bytes,
      contentType: rootfsReleaseArtifactContentType(),
    });
    await uploadObjectFromBuffer({
      endpoint: bucket.endpoint,
      accessKey: bucket.access_key_id,
      secretKey: bucket.secret_access_key,
      bucket: bucket.name,
      key: r2ArtifactShaKey(
        key,
        release.artifact_kind,
        parentRelease?.content_key,
      ),
      body: `${release.artifact_sha256}\n`,
      contentType: "text/plain; charset=utf-8",
    });
    return await upsertReleaseArtifactReplica({
      artifact_id: pending.artifact_id,
      release_id: release.release_id,
      content_key: key,
      backend: "r2",
      region,
      bucket,
      artifact_kind: release.artifact_kind,
      artifact_format: release.artifact_format,
      artifact_path: artifactPath,
      artifact_sha256: release.artifact_sha256,
      artifact_bytes: release.artifact_bytes,
      status: "ready",
      error: null,
    });
  } catch (err) {
    await upsertReleaseArtifactReplica({
      artifact_id: pending.artifact_id,
      release_id: release.release_id,
      content_key: key,
      backend: "r2",
      region,
      bucket,
      artifact_kind: release.artifact_kind,
      artifact_format: release.artifact_format,
      artifact_path: artifactPath,
      artifact_sha256: release.artifact_sha256,
      artifact_bytes: release.artifact_bytes,
      status: "failed",
      error: `${err}`,
    });
    throw err;
  }
}
