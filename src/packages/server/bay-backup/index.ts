/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFile as execFile0 } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import {
  data,
  pghost,
  pgdatabase,
  pgssl,
  pguser,
  sslConfigToPsqlEnv,
} from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import dbPassword from "@cocalc/database/pool/password";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import type {
  BayBackupArtifactInfo,
  BayBackupRunResult,
  BayRestoreRunResult,
  BayBackupStatus,
  BayBackupsPostgresStatus,
} from "@cocalc/conat/hub/api/system";
import { getSingleBayInfo } from "@cocalc/server/bay-directory";
import { getLaunchpadLocalConfig } from "@cocalc/server/launchpad/mode";
import {
  createBucket,
  issueSignedObjectDownload,
  listBuckets,
  uploadObjectFromBuffer,
  uploadObjectFromFile,
} from "@cocalc/server/project-backup/r2";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  parseR2Region,
} from "@cocalc/util/consts";

const logger = getLogger("server:bay-backup");
const execFile = promisify(execFile0);

type BackupStrategy = "pg_basebackup" | "pg_dumpall";
type StorageBackend = "local" | "r2";

type StoredBayBackupState = {
  bay_id: string;
  current_storage_backend: StorageBackend;
  r2_configured: boolean;
  bucket_name: string | null;
  bucket_region: string | null;
  bucket_endpoint: string | null;
  object_prefix_root: string | null;
  latest_backup_set_id: string | null;
  latest_format: BackupStrategy | null;
  latest_storage_backend: StorageBackend | null;
  latest_local_manifest_path: string | null;
  latest_remote_manifest_key: string | null;
  latest_object_prefix: string | null;
  latest_artifact_count: number;
  latest_artifact_bytes: number;
  last_archived_wal_segment: string | null;
  last_uploaded_wal_segment: string | null;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_successful_backup_at: string | null;
  last_successful_remote_backup_at: string | null;
  last_successful_wal_archive_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  restore_state: string | null;
};

type StoredBayBackupManifest = {
  bay_id: string;
  bay_label: string;
  backup_set_id: string;
  created_at: string;
  finished_at: string;
  format: BackupStrategy;
  current_storage_backend: StorageBackend;
  latest_storage_backend: StorageBackend;
  bucket_name: string | null;
  bucket_region: string | null;
  bucket_endpoint: string | null;
  object_prefix: string | null;
  remote_manifest_key: string | null;
  postgres: BayBackupsPostgresStatus;
  artifacts: BayBackupArtifactInfo[];
};

type R2Target = {
  configured: boolean;
  bucket_name: string | null;
  bucket_region: string | null;
  bucket_endpoint: string | null;
  object_prefix_root: string | null;
  account_id?: string;
  api_token?: string;
  access_key?: string;
  secret_key?: string;
};

type WalArchiveFile = {
  name: string;
  path: string;
  mtime_iso: string | null;
};

type WalArchiveSnapshot = {
  wal_archive_dir: string;
  wal_object_prefix: string | null;
  archived_files: WalArchiveFile[];
  archived_wal_count: number;
  pending_files: WalArchiveFile[];
  pending_wal_count: number;
  last_archived_wal_segment: string | null;
  last_archived_wal_at: string | null;
};

type ResolvedBackupManifest = {
  manifest: StoredBayBackupManifest;
  backup_manifest_path: string | null;
  source_storage_backend: StorageBackend;
};

let runInFlight: Promise<BayBackupRunResult> | null = null;
let walMaintenanceTimer: NodeJS.Timeout | undefined;
let walMaintenanceRunning = false;

const DEFAULT_WAL_ARCHIVE_INTERVAL_MS = 60 * 1000;

function getWalArchiveIntervalMs(): number {
  const n = Number.parseInt(
    `${process.env.COCALC_BAY_WAL_ARCHIVE_INTERVAL_MS ?? ""}`,
    10,
  );
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WAL_ARCHIVE_INTERVAL_MS;
}

function getBackupRoot(): string {
  return getLaunchpadLocalConfig().backup_root ?? join(data, "backup-repo");
}

function getBayBackupPaths(bay_id: string) {
  const backup_root = getBackupRoot();
  const bay_root = join(backup_root, "bay-backups", bay_id);
  const wal_dir = join(bay_root, "wal");
  return {
    backup_root,
    bay_root,
    archives_dir: join(bay_root, "archives"),
    manifests_dir: join(bay_root, "manifests"),
    restores_dir: join(bay_root, "restores"),
    staging_dir: join(bay_root, "staging"),
    wal_dir,
    wal_archive_dir: join(wal_dir, "archive"),
    state_file: join(bay_root, "state.json"),
  };
}

function parsePostgresHost(hostEntry: string): { host?: string; port: number } {
  if (!hostEntry) {
    return { host: undefined, port: 5432 };
  }
  if (hostEntry.includes("/")) {
    return { host: hostEntry, port: 5432 };
  }
  const i = hostEntry.lastIndexOf(":");
  if (i > 0) {
    const host = hostEntry.slice(0, i);
    const port = Number.parseInt(hostEntry.slice(i + 1), 10);
    return {
      host,
      port: Number.isFinite(port) ? port : 5432,
    };
  }
  return { host: hostEntry, port: 5432 };
}

function buildPostgresCliEnv(): NodeJS.ProcessEnv {
  const { host, port } = parsePostgresHost(pghost);
  const password = dbPassword();
  return {
    ...process.env,
    ...(host ? { PGHOST: host } : {}),
    PGPORT: `${port}`,
    PGUSER: pguser,
    PGDATABASE: pgdatabase,
    ...(password ? { PGPASSWORD: password } : {}),
    ...sslConfigToPsqlEnv(pgssl),
  };
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function defaultState({
  bay_id,
  current_storage_backend,
  r2,
}: {
  bay_id: string;
  current_storage_backend: StorageBackend;
  r2: R2Target;
}): StoredBayBackupState {
  return {
    bay_id,
    current_storage_backend,
    r2_configured: r2.configured,
    bucket_name: r2.bucket_name ?? null,
    bucket_region: r2.bucket_region ?? null,
    bucket_endpoint: r2.bucket_endpoint ?? null,
    object_prefix_root: r2.object_prefix_root ?? null,
    latest_backup_set_id: null,
    latest_format: null,
    latest_storage_backend: null,
    latest_local_manifest_path: null,
    latest_remote_manifest_key: null,
    latest_object_prefix: null,
    latest_artifact_count: 0,
    latest_artifact_bytes: 0,
    last_archived_wal_segment: null,
    last_uploaded_wal_segment: null,
    last_started_at: null,
    last_finished_at: null,
    last_successful_backup_at: null,
    last_successful_remote_backup_at: null,
    last_successful_wal_archive_at: null,
    last_error_at: null,
    last_error: null,
    restore_state: null,
  };
}

async function inspectPostgres(): Promise<BayBackupsPostgresStatus> {
  const { host, port } = parsePostgresHost(pghost);
  const { rows } = await getPool().query<{
    current_user: string;
    role_superuser: boolean;
    role_replication: boolean;
    data_directory: string | null;
    config_file: string | null;
    archive_mode: string | null;
    archive_command: string | null;
    archive_timeout: string | null;
    wal_level: string | null;
    max_wal_senders: string | null;
  }>(
    `SELECT
      current_user AS current_user,
      r.rolsuper AS role_superuser,
      r.rolreplication AS role_replication,
      current_setting('data_directory', true) AS data_directory,
      current_setting('config_file', true) AS config_file,
      current_setting('archive_mode', true) AS archive_mode,
      current_setting('archive_command', true) AS archive_command,
      current_setting('archive_timeout', true) AS archive_timeout,
      current_setting('wal_level', true) AS wal_level,
      current_setting('max_wal_senders', true) AS max_wal_senders
    FROM pg_roles r
    WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  const max_wal_senders = Number.parseInt(`${row?.max_wal_senders ?? ""}`, 10);
  const can_basebackup =
    row?.role_superuser === true || row?.role_replication === true || false;
  const preferred_strategy: BackupStrategy =
    can_basebackup &&
    (row?.wal_level ?? "").toLowerCase() !== "minimal" &&
    Number.isFinite(max_wal_senders) &&
    max_wal_senders > 0
      ? "pg_basebackup"
      : "pg_dumpall";
  return {
    host: host ?? null,
    port,
    user: pguser,
    database: pgdatabase,
    current_user: row?.current_user ?? null,
    role_superuser: row?.role_superuser ?? null,
    role_replication: row?.role_replication ?? null,
    data_directory: row?.data_directory ?? null,
    config_file: row?.config_file ?? null,
    archive_mode: row?.archive_mode ?? null,
    archive_command: row?.archive_command ?? null,
    archive_timeout: row?.archive_timeout ?? null,
    wal_level: row?.wal_level ?? null,
    max_wal_senders: Number.isFinite(max_wal_senders) ? max_wal_senders : null,
    can_basebackup,
    preferred_strategy,
  };
}

async function resolveR2Target(bay_id: string): Promise<R2Target> {
  const settings = await getServerSettings();
  const region =
    parseR2Region(getSingleBayInfo().region) ??
    mapCloudRegionToR2Region(getSingleBayInfo().region ?? DEFAULT_R2_REGION);
  const account_id = `${settings.r2_account_id ?? ""}`.trim() || undefined;
  const api_token = `${settings.r2_api_token ?? ""}`.trim() || undefined;
  const access_key = `${settings.r2_access_key_id ?? ""}`.trim() || undefined;
  const secret_key =
    `${settings.r2_secret_access_key ?? ""}`.trim() || undefined;
  const bucket_prefix =
    `${settings.r2_bucket_prefix ?? ""}`.trim() || undefined;
  const configured = !!(
    account_id &&
    access_key &&
    secret_key &&
    bucket_prefix
  );
  return {
    configured,
    bucket_name: configured ? `${bucket_prefix}-${region}` : null,
    bucket_region: configured ? region : null,
    bucket_endpoint: configured
      ? `https://${account_id}.r2.cloudflarestorage.com`
      : null,
    object_prefix_root: configured ? `bay-backups/${bay_id}` : null,
    account_id,
    api_token,
    access_key,
    secret_key,
  };
}

async function ensureR2Bucket(target: R2Target): Promise<void> {
  if (
    !target.configured ||
    !target.bucket_name ||
    !target.bucket_region ||
    !target.account_id
  ) {
    return;
  }
  if (!target.api_token) {
    logger.warn("bay backup R2 api token missing; skipping bucket ensure", {
      bucket: target.bucket_name,
    });
    return;
  }
  const names = new Set(await listBuckets(target.api_token, target.account_id));
  if (names.has(target.bucket_name)) {
    return;
  }
  await createBucket(
    target.api_token,
    target.account_id,
    target.bucket_name,
    target.bucket_region,
  );
}

async function hashFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buf);
    bytes += buf.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function contentTypeForArtifact(name: string): string {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".sql.gz") || name.endsWith(".tar.gz")) {
    return "application/gzip";
  }
  if (name.endsWith(".tar")) return "application/x-tar";
  return "application/octet-stream";
}

async function gzipFile(from: string, to: string): Promise<void> {
  await pipeline(
    createReadStream(from),
    createGzip({ level: 9 }),
    createWriteStream(to),
  );
}

async function gunzipFile(from: string, to: string): Promise<void> {
  await pipeline(createReadStream(from), createGunzip(), createWriteStream(to));
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

function postgresQuote(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}

async function exists(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function extractTarGz({
  archivePath,
  targetDir,
}: {
  archivePath: string;
  targetDir: string;
}): Promise<void> {
  await ensureDir(targetDir);
  await execFile("tar", ["-xzf", archivePath, "-C", targetDir], {
    maxBuffer: 10 * 1024 * 1024,
  });
}

function shouldFallbackToPgDumpall(err: unknown): boolean {
  const message = String(err ?? "");
  return (
    message.includes("no pg_hba.conf entry for replication connection") ||
    message.includes("must be superuser or replication role") ||
    message.includes("replication connection")
  );
}

async function runBackupCommand({
  strategy,
  staging_dir,
}: {
  strategy: BackupStrategy;
  staging_dir: string;
}): Promise<BackupStrategy> {
  const env = buildPostgresCliEnv();
  if (strategy === "pg_basebackup") {
    try {
      await execFile(
        "pg_basebackup",
        ["-D", staging_dir, "-Ft", "-z", "-X", "stream", "--checkpoint=fast"],
        {
          env,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      return "pg_basebackup";
    } catch (err) {
      if (!shouldFallbackToPgDumpall(err)) {
        throw err;
      }
      logger.warn("pg_basebackup failed; falling back to pg_dumpall", {
        err,
      });
      return await runBackupCommand({
        strategy: "pg_dumpall",
        staging_dir,
      });
    }
  }
  const sqlPath = join(staging_dir, "cluster.sql");
  const gzipPath = join(staging_dir, "cluster.sql.gz");
  await execFile("pg_dumpall", ["--clean", "--if-exists", "--file", sqlPath], {
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  await gzipFile(sqlPath, gzipPath);
  await rm(sqlPath, { force: true });
  return "pg_dumpall";
}

async function collectArtifacts(
  archive_dir: string,
): Promise<BayBackupArtifactInfo[]> {
  const entries = await readdir(archive_dir);
  const artifacts: BayBackupArtifactInfo[] = [];
  for (const name of entries.sort()) {
    const path = join(archive_dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    const { sha256, bytes } = await hashFile(path);
    artifacts.push({
      name,
      local_path: path,
      object_key: null,
      bytes,
      sha256,
      content_type: contentTypeForArtifact(name),
    });
  }
  if (artifacts.length === 0) {
    throw new Error("backup command produced no artifacts");
  }
  return artifacts;
}

async function uploadArtifactsToR2({
  target,
  backup_set_id,
  artifacts,
}: {
  target: R2Target;
  backup_set_id: string;
  artifacts: BayBackupArtifactInfo[];
}): Promise<{
  object_prefix: string;
  artifacts: BayBackupArtifactInfo[];
}> {
  if (
    !target.configured ||
    !target.bucket_name ||
    !target.bucket_endpoint ||
    !target.object_prefix_root ||
    !target.access_key ||
    !target.secret_key
  ) {
    throw new Error("R2 target is not configured");
  }
  await ensureR2Bucket(target);
  const object_prefix = `${target.object_prefix_root}/${backup_set_id}`;
  const uploaded: BayBackupArtifactInfo[] = [];
  for (const artifact of artifacts) {
    const object_key = `${object_prefix}/artifacts/${artifact.name}`;
    if (!artifact.local_path) {
      throw new Error(`artifact '${artifact.name}' is missing local_path`);
    }
    await uploadObjectFromFile({
      endpoint: target.bucket_endpoint,
      accessKey: target.access_key,
      secretKey: target.secret_key,
      bucket: target.bucket_name,
      key: object_key,
      filePath: artifact.local_path,
      artifactSha256: artifact.sha256,
      artifactBytes: artifact.bytes,
      contentType: artifact.content_type,
    });
    uploaded.push({
      ...artifact,
      object_key,
    });
  }
  return {
    object_prefix,
    artifacts: uploaded,
  };
}

async function downloadObjectToFileFromR2({
  target,
  key,
  destinationPath,
}: {
  target: R2Target;
  key: string;
  destinationPath: string;
}): Promise<void> {
  if (
    !target.configured ||
    !target.bucket_name ||
    !target.bucket_endpoint ||
    !target.access_key ||
    !target.secret_key
  ) {
    throw new Error("R2 target is not configured");
  }
  const { url, headers } = issueSignedObjectDownload({
    endpoint: target.bucket_endpoint,
    accessKey: target.access_key,
    secretKey: target.secret_key,
    bucket: target.bucket_name,
    key,
  });
  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    throw new Error(
      `R2 GET failed (${response.status}): ${response.statusText || "unknown error"}`,
    );
  }
  await ensureDir(dirname(destinationPath));
  await pipeline(
    Readable.fromWeb(response.body as globalThis.ReadableStream),
    createWriteStream(destinationPath),
  );
}

async function resolveBackupManifest({
  paths,
  bay_id,
  backup_set_id,
  r2,
  download_dir,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  bay_id: string;
  backup_set_id: string;
  r2: R2Target;
  download_dir?: string;
}): Promise<ResolvedBackupManifest> {
  const localManifestPath = join(paths.manifests_dir, `${backup_set_id}.json`);
  const localManifest =
    await readJsonIfExists<StoredBayBackupManifest>(localManifestPath);
  if (localManifest) {
    return {
      manifest: localManifest,
      backup_manifest_path: localManifestPath,
      source_storage_backend: "local",
    };
  }
  if (!download_dir) {
    throw new Error(
      `backup manifest for '${backup_set_id}' is not available locally`,
    );
  }
  const object_prefix = r2.object_prefix_root ?? `bay-backups/${bay_id}`;
  const manifestKey = `${object_prefix}/${backup_set_id}/manifest.json`;
  const downloadPath = join(download_dir, "manifest.json");
  await downloadObjectToFileFromR2({
    target: r2,
    key: manifestKey,
    destinationPath: downloadPath,
  });
  const manifest = JSON.parse(
    await readFile(downloadPath, "utf8"),
  ) as StoredBayBackupManifest;
  return {
    manifest,
    backup_manifest_path: downloadPath,
    source_storage_backend: "r2",
  };
}

async function resolveArtifactPath({
  artifact,
  r2,
  download_dir,
}: {
  artifact: BayBackupArtifactInfo;
  r2: R2Target;
  download_dir?: string;
}): Promise<{
  path: string;
  source_storage_backend: StorageBackend;
}> {
  if (artifact.local_path && (await exists(artifact.local_path))) {
    return {
      path: artifact.local_path,
      source_storage_backend: "local",
    };
  }
  if (!artifact.object_key) {
    throw new Error(`artifact '${artifact.name}' is not available locally`);
  }
  if (!download_dir) {
    throw new Error(
      `artifact '${artifact.name}' requires R2 download but no download dir is available`,
    );
  }
  const destinationPath = join(download_dir, "artifacts", artifact.name);
  await downloadObjectToFileFromR2({
    target: r2,
    key: artifact.object_key,
    destinationPath,
  });
  return {
    path: destinationPath,
    source_storage_backend: "r2",
  };
}

function walObjectPrefix(root: string | null): string | null {
  return root ? `${root}/wal` : null;
}

async function listArchivedWalFiles(
  wal_archive_dir: string,
): Promise<WalArchiveFile[]> {
  try {
    const names = await readdir(wal_archive_dir);
    const files: WalArchiveFile[] = [];
    for (const name of names.sort()) {
      const path = join(wal_archive_dir, name);
      const info = await stat(path);
      if (!info.isFile()) continue;
      files.push({
        name,
        path,
        mtime_iso: new Date(info.mtimeMs).toISOString(),
      });
    }
    return files;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

function isWalPendingUpload({
  name,
  last_uploaded_wal_segment,
}: {
  name: string;
  last_uploaded_wal_segment: string | null;
}): boolean {
  return !last_uploaded_wal_segment || name > last_uploaded_wal_segment;
}

async function getWalArchiveSnapshot({
  paths,
  state,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  state: StoredBayBackupState;
}): Promise<WalArchiveSnapshot> {
  const archived_files = await listArchivedWalFiles(paths.wal_archive_dir);
  const last = archived_files.at(-1);
  const pending_files = archived_files.filter((file) =>
    isWalPendingUpload({
      name: file.name,
      last_uploaded_wal_segment: state.last_uploaded_wal_segment,
    }),
  );
  return {
    wal_archive_dir: paths.wal_archive_dir,
    wal_object_prefix: walObjectPrefix(state.object_prefix_root),
    archived_files,
    archived_wal_count: archived_files.length,
    pending_files,
    pending_wal_count: pending_files.length,
    last_archived_wal_segment: last?.name ?? null,
    last_archived_wal_at: last?.mtime_iso ?? null,
  };
}

async function waitForWalArchiveAdvance({
  paths,
  state,
  previous_last_segment,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  state: StoredBayBackupState;
  previous_last_segment: string | null;
}): Promise<WalArchiveSnapshot> {
  const deadline = Date.now() + 5_000;
  let snapshot = await getWalArchiveSnapshot({ paths, state });
  while (Date.now() < deadline) {
    if (
      snapshot.last_archived_wal_segment &&
      snapshot.last_archived_wal_segment !== previous_last_segment
    ) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await getWalArchiveSnapshot({ paths, state });
  }
  return snapshot;
}

async function syncBayWalArchive({
  bay_id,
  forceSwitch = false,
}: {
  bay_id?: string;
  forceSwitch?: boolean;
} = {}): Promise<{
  state: StoredBayBackupState;
  snapshot: WalArchiveSnapshot;
}> {
  const currentBay = getSingleBayInfo();
  const resolvedBayId =
    `${bay_id ?? currentBay.bay_id}`.trim() || currentBay.bay_id;
  if (resolvedBayId !== currentBay.bay_id) {
    throw new Error(`bay '${resolvedBayId}' not found`);
  }
  const r2 = await resolveR2Target(resolvedBayId);
  const current_storage_backend: StorageBackend = r2.configured
    ? "r2"
    : "local";
  const paths = getBayBackupPaths(resolvedBayId);
  await ensureDir(paths.wal_archive_dir);
  const stored =
    (await readJsonIfExists<StoredBayBackupState>(paths.state_file)) ??
    defaultState({
      bay_id: resolvedBayId,
      current_storage_backend,
      r2,
    });
  let state: StoredBayBackupState = {
    ...stored,
    bay_id: resolvedBayId,
    current_storage_backend,
    r2_configured: r2.configured,
    bucket_name: r2.bucket_name ?? stored.bucket_name ?? null,
    bucket_region: r2.bucket_region ?? stored.bucket_region ?? null,
    bucket_endpoint: r2.bucket_endpoint ?? stored.bucket_endpoint ?? null,
    object_prefix_root:
      r2.object_prefix_root ?? stored.object_prefix_root ?? null,
    last_archived_wal_segment: stored.last_archived_wal_segment ?? null,
    last_uploaded_wal_segment: stored.last_uploaded_wal_segment ?? null,
  };
  let snapshot = await getWalArchiveSnapshot({ paths, state });
  const previous_last_segment = snapshot.last_archived_wal_segment;
  const walErrorPrefix = "wal archive:";
  if (forceSwitch) {
    try {
      await getPool().query("SELECT pg_switch_wal()");
      snapshot = await waitForWalArchiveAdvance({
        paths,
        state,
        previous_last_segment,
      });
    } catch (err) {
      state = {
        ...state,
        last_error_at: new Date().toISOString(),
        last_error: `${walErrorPrefix} forced WAL switch failed: ${String(err)}`,
      };
      await writeJson(paths.state_file, state);
      return { state, snapshot };
    }
  }

  state = {
    ...state,
    last_archived_wal_segment: snapshot.last_archived_wal_segment,
    last_successful_wal_archive_at:
      snapshot.last_archived_wal_at ?? state.last_successful_wal_archive_at,
  };

  try {
    if (
      r2.configured &&
      r2.bucket_name &&
      r2.bucket_endpoint &&
      r2.access_key &&
      r2.secret_key &&
      snapshot.pending_files.length > 0
    ) {
      await ensureR2Bucket(r2);
      const object_prefix = walObjectPrefix(r2.object_prefix_root ?? null);
      if (!object_prefix) {
        throw new Error("missing WAL object prefix");
      }
      let last_uploaded_wal_segment = state.last_uploaded_wal_segment;
      for (const file of snapshot.pending_files) {
        const object_key = `${object_prefix}/${file.name}`;
        const { sha256, bytes } = await hashFile(file.path);
        await uploadObjectFromFile({
          endpoint: r2.bucket_endpoint,
          accessKey: r2.access_key,
          secretKey: r2.secret_key,
          bucket: r2.bucket_name,
          key: object_key,
          filePath: file.path,
          artifactSha256: sha256,
          artifactBytes: bytes,
          contentType: "application/octet-stream",
        });
        last_uploaded_wal_segment = file.name;
      }
      state = {
        ...state,
        last_uploaded_wal_segment,
      };
    }
    if (`${state.last_error ?? ""}`.startsWith(walErrorPrefix)) {
      state = {
        ...state,
        last_error: null,
        last_error_at: null,
      };
    }
  } catch (err) {
    state = {
      ...state,
      last_error_at: new Date().toISOString(),
      last_error: `${walErrorPrefix} upload failed: ${String(err)}`,
    };
    logger.warn("bay wal archive sync failed", {
      bay_id: resolvedBayId,
      err,
    });
  }

  await writeJson(paths.state_file, state);
  snapshot = await getWalArchiveSnapshot({ paths, state });
  return { state, snapshot };
}

export function startBayWalArchiveMaintenance(): void {
  if (walMaintenanceTimer) return;
  const run = async () => {
    if (walMaintenanceRunning) return;
    walMaintenanceRunning = true;
    try {
      await syncBayWalArchive();
    } catch (err) {
      logger.warn("bay wal archive maintenance failed", { err });
    } finally {
      walMaintenanceRunning = false;
    }
  };
  walMaintenanceTimer = setInterval(() => {
    void run();
  }, getWalArchiveIntervalMs());
  void run();
}

function mapStateToStatus({
  paths,
  state,
  wal,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  state: StoredBayBackupState;
  wal: WalArchiveSnapshot;
}): BayBackupStatus {
  return {
    enabled: true,
    backup_root: paths.backup_root,
    state_file: paths.state_file,
    archives_dir: paths.archives_dir,
    manifests_dir: paths.manifests_dir,
    staging_dir: paths.staging_dir,
    wal_archive_dir: wal.wal_archive_dir,
    r2_configured: state.r2_configured,
    current_storage_backend: state.current_storage_backend,
    bucket_name: state.bucket_name,
    bucket_region: state.bucket_region,
    bucket_endpoint: state.bucket_endpoint,
    object_prefix_root: state.object_prefix_root,
    wal_object_prefix: wal.wal_object_prefix,
    latest_backup_set_id: state.latest_backup_set_id,
    latest_format: state.latest_format,
    latest_storage_backend: state.latest_storage_backend,
    latest_local_manifest_path: state.latest_local_manifest_path,
    latest_remote_manifest_key: state.latest_remote_manifest_key,
    latest_object_prefix: state.latest_object_prefix,
    latest_artifact_count: state.latest_artifact_count,
    latest_artifact_bytes: state.latest_artifact_bytes,
    last_archived_wal_segment:
      wal.last_archived_wal_segment ?? state.last_archived_wal_segment,
    last_uploaded_wal_segment: state.last_uploaded_wal_segment ?? null,
    archived_wal_count: wal.archived_wal_count,
    pending_wal_count: wal.pending_wal_count,
    last_started_at: state.last_started_at,
    last_finished_at: state.last_finished_at,
    last_successful_backup_at: state.last_successful_backup_at,
    last_successful_remote_backup_at: state.last_successful_remote_backup_at,
    last_successful_wal_archive_at: state.last_successful_wal_archive_at,
    last_error_at: state.last_error_at,
    last_error: state.last_error,
    restore_state: state.restore_state,
  };
}

export async function getBayBackupStatus({
  bay_id,
}: {
  bay_id?: string;
} = {}): Promise<{
  postgres: BayBackupsPostgresStatus;
  bay_backup: BayBackupStatus;
}> {
  const currentBay = getSingleBayInfo();
  const resolvedBayId =
    `${bay_id ?? currentBay.bay_id}`.trim() || currentBay.bay_id;
  if (resolvedBayId !== currentBay.bay_id) {
    throw new Error(`bay '${resolvedBayId}' not found`);
  }
  const [postgres, r2] = await Promise.all([
    inspectPostgres(),
    resolveR2Target(resolvedBayId),
  ]);
  const current_storage_backend: StorageBackend = r2.configured
    ? "r2"
    : "local";
  const paths = getBayBackupPaths(resolvedBayId);
  const stored =
    (await readJsonIfExists<StoredBayBackupState>(paths.state_file)) ??
    defaultState({
      bay_id: resolvedBayId,
      current_storage_backend,
      r2,
    });
  const state: StoredBayBackupState = {
    ...stored,
    bay_id: resolvedBayId,
    current_storage_backend,
    r2_configured: r2.configured,
    bucket_name: r2.bucket_name ?? stored.bucket_name ?? null,
    bucket_region: r2.bucket_region ?? stored.bucket_region ?? null,
    bucket_endpoint: r2.bucket_endpoint ?? stored.bucket_endpoint ?? null,
    object_prefix_root:
      r2.object_prefix_root ?? stored.object_prefix_root ?? null,
    last_archived_wal_segment: stored.last_archived_wal_segment ?? null,
    last_uploaded_wal_segment: stored.last_uploaded_wal_segment ?? null,
  };
  const wal = await getWalArchiveSnapshot({ paths, state });
  return {
    postgres,
    bay_backup: mapStateToStatus({
      paths,
      state,
      wal,
    }),
  };
}

export async function runBayBackup({
  bay_id,
}: {
  bay_id?: string;
} = {}): Promise<BayBackupRunResult> {
  if (runInFlight) {
    return await runInFlight;
  }
  runInFlight = (async () => {
    const currentBay = getSingleBayInfo();
    const resolvedBayId =
      `${bay_id ?? currentBay.bay_id}`.trim() || currentBay.bay_id;
    if (resolvedBayId !== currentBay.bay_id) {
      throw new Error(`bay '${resolvedBayId}' not found`);
    }
    const [postgres, r2] = await Promise.all([
      inspectPostgres(),
      resolveR2Target(resolvedBayId),
    ]);
    const current_storage_backend: StorageBackend = r2.configured
      ? "r2"
      : "local";
    const paths = getBayBackupPaths(resolvedBayId);
    const previous =
      (await readJsonIfExists<StoredBayBackupState>(paths.state_file)) ??
      defaultState({
        bay_id: resolvedBayId,
        current_storage_backend,
        r2,
      });
    await Promise.all([
      ensureDir(paths.archives_dir),
      ensureDir(paths.manifests_dir),
      ensureDir(paths.staging_dir),
      ensureDir(paths.wal_archive_dir),
    ]);
    const started_at = new Date().toISOString();
    const backup_set_id = randomUUID();
    const initialState: StoredBayBackupState = {
      ...previous,
      bay_id: resolvedBayId,
      current_storage_backend,
      r2_configured: r2.configured,
      bucket_name: r2.bucket_name ?? null,
      bucket_region: r2.bucket_region ?? null,
      bucket_endpoint: r2.bucket_endpoint ?? null,
      object_prefix_root: r2.object_prefix_root ?? null,
      last_started_at: started_at,
      last_finished_at: null,
      last_error_at: null,
      last_error: null,
    };
    await writeJson(paths.state_file, initialState);
    const staging_dir = await mkdtemp(
      join(paths.staging_dir, `${backup_set_id}-`),
    );
    let archive_dir: string | null = null;
    try {
      logger.info("starting bay postgres backup", {
        bay_id: resolvedBayId,
        backup_set_id,
        strategy: postgres.preferred_strategy,
        current_storage_backend,
      });
      const actual_strategy = await runBackupCommand({
        strategy: postgres.preferred_strategy,
        staging_dir,
      });
      archive_dir = join(paths.archives_dir, backup_set_id);
      await rename(staging_dir, archive_dir);
      let artifacts = await collectArtifacts(archive_dir);
      const artifact_bytes = artifacts.reduce(
        (sum, artifact) => sum + artifact.bytes,
        0,
      );
      const local_manifest_path = join(
        paths.manifests_dir,
        `${backup_set_id}.json`,
      );
      let latest_storage_backend: StorageBackend = "local";
      let latest_remote_manifest_key: string | null = null;
      let latest_object_prefix: string | null = null;
      if (r2.configured) {
        try {
          const uploaded = await uploadArtifactsToR2({
            target: r2,
            backup_set_id,
            artifacts,
          });
          artifacts = uploaded.artifacts;
          latest_storage_backend = "r2";
          latest_object_prefix = uploaded.object_prefix;
          latest_remote_manifest_key = `${uploaded.object_prefix}/manifest.json`;
        } catch (err) {
          logger.warn("bay backup R2 upload failed; local backup retained", {
            bay_id: resolvedBayId,
            backup_set_id,
            err,
          });
          initialState.last_error_at = new Date().toISOString();
          initialState.last_error = `remote upload failed: ${String(err)}`;
        }
      }
      const finished_at = new Date().toISOString();
      const manifest: StoredBayBackupManifest = {
        bay_id: resolvedBayId,
        bay_label: currentBay.label,
        backup_set_id,
        created_at: started_at,
        finished_at,
        format: actual_strategy,
        current_storage_backend,
        latest_storage_backend,
        bucket_name: r2.bucket_name ?? null,
        bucket_region: r2.bucket_region ?? null,
        bucket_endpoint: r2.bucket_endpoint ?? null,
        object_prefix: latest_object_prefix,
        remote_manifest_key: latest_remote_manifest_key,
        postgres,
        artifacts,
      };
      await writeJson(local_manifest_path, manifest);
      if (
        latest_storage_backend === "r2" &&
        latest_remote_manifest_key &&
        r2.bucket_name &&
        r2.bucket_endpoint &&
        r2.access_key &&
        r2.secret_key
      ) {
        await uploadObjectFromBuffer({
          endpoint: r2.bucket_endpoint,
          accessKey: r2.access_key,
          secretKey: r2.secret_key,
          bucket: r2.bucket_name,
          key: latest_remote_manifest_key,
          body: JSON.stringify(manifest, null, 2),
          contentType: "application/json",
        });
      }
      let state: StoredBayBackupState = {
        ...initialState,
        latest_backup_set_id: backup_set_id,
        latest_format: actual_strategy,
        latest_storage_backend,
        latest_local_manifest_path: local_manifest_path,
        latest_remote_manifest_key,
        latest_object_prefix,
        latest_artifact_count: artifacts.length,
        latest_artifact_bytes: artifact_bytes,
        last_finished_at: finished_at,
        last_successful_backup_at: finished_at,
        last_successful_remote_backup_at:
          latest_storage_backend === "r2"
            ? finished_at
            : previous.last_successful_remote_backup_at,
        restore_state:
          latest_storage_backend === "r2" ? "ready" : "ready-local-only",
      };
      await writeJson(paths.state_file, state);
      try {
        const walSync = await syncBayWalArchive({
          bay_id: resolvedBayId,
          forceSwitch: `${postgres.archive_mode ?? ""}`.toLowerCase() === "on",
        });
        state = walSync.state;
      } catch (err) {
        logger.warn("post-backup WAL archive sync failed", {
          bay_id: resolvedBayId,
          backup_set_id,
          err,
        });
      }
      const wal = await getWalArchiveSnapshot({ paths, state });
      return {
        ...currentBay,
        started_at,
        finished_at,
        backup_set_id,
        format: actual_strategy,
        bucket_name: r2.bucket_name ?? null,
        object_prefix: latest_object_prefix,
        local_manifest_path,
        storage_backend: latest_storage_backend,
        artifact_count: artifacts.length,
        artifact_bytes,
        artifacts,
        postgres,
        bay_backup: mapStateToStatus({
          paths,
          state,
          wal,
        }),
      };
    } catch (err) {
      const finished_at = new Date().toISOString();
      const failed: StoredBayBackupState = {
        ...initialState,
        last_finished_at: finished_at,
        last_error_at: finished_at,
        last_error: String(err),
        restore_state: previous.restore_state ?? "failed",
      };
      await writeJson(paths.state_file, failed);
      throw err;
    } finally {
      if (archive_dir == null) {
        await rm(staging_dir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  })();
  try {
    return await runInFlight;
  } finally {
    runInFlight = null;
  }
}

function defaultRestoreTargetDir({
  paths,
  backup_set_id,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  backup_set_id: string;
}): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(paths.restores_dir, `${backup_set_id}-${stamp}`);
}

export async function runBayRestore({
  bay_id,
  backup_set_id,
  target_dir,
  dry_run = true,
}: {
  bay_id?: string;
  backup_set_id?: string;
  target_dir?: string;
  dry_run?: boolean;
} = {}): Promise<BayRestoreRunResult> {
  const currentBay = getSingleBayInfo();
  const resolvedBayId =
    `${bay_id ?? currentBay.bay_id}`.trim() || currentBay.bay_id;
  if (resolvedBayId !== currentBay.bay_id) {
    throw new Error(`bay '${resolvedBayId}' not found`);
  }
  const started_at = new Date().toISOString();
  const paths = getBayBackupPaths(resolvedBayId);
  const r2 = await resolveR2Target(resolvedBayId);
  const current_storage_backend: StorageBackend = r2.configured
    ? "r2"
    : "local";
  const stored =
    (await readJsonIfExists<StoredBayBackupState>(paths.state_file)) ??
    defaultState({
      bay_id: resolvedBayId,
      current_storage_backend,
      r2,
    });
  const state: StoredBayBackupState = {
    ...stored,
    bay_id: resolvedBayId,
    current_storage_backend,
    r2_configured: r2.configured,
    bucket_name: r2.bucket_name ?? stored.bucket_name ?? null,
    bucket_region: r2.bucket_region ?? stored.bucket_region ?? null,
    bucket_endpoint: r2.bucket_endpoint ?? stored.bucket_endpoint ?? null,
    object_prefix_root:
      r2.object_prefix_root ?? stored.object_prefix_root ?? null,
    last_archived_wal_segment: stored.last_archived_wal_segment ?? null,
    last_uploaded_wal_segment: stored.last_uploaded_wal_segment ?? null,
  };
  const resolvedBackupSetId =
    `${backup_set_id ?? state.latest_backup_set_id ?? ""}`.trim() || undefined;
  if (!resolvedBackupSetId) {
    throw new Error("no bay backup is available to restore");
  }
  const resolvedTargetDir =
    target_dir?.trim() ||
    defaultRestoreTargetDir({
      paths,
      backup_set_id: resolvedBackupSetId,
    });
  let tempDownloadDir: string | null = null;
  const notes: string[] = [];
  try {
    await ensureDir(paths.staging_dir);
    if (!dry_run) {
      await ensureDir(paths.restores_dir);
    }
    tempDownloadDir = await mkdtemp(
      join(
        paths.staging_dir,
        dry_run ? `restore-plan-${resolvedBackupSetId}-` : "restore-cache-",
      ),
    );
    const manifestInfo = await resolveBackupManifest({
      paths,
      bay_id: resolvedBayId,
      backup_set_id: resolvedBackupSetId,
      r2,
      download_dir: tempDownloadDir,
    });
    const wal = await getWalArchiveSnapshot({ paths, state });
    let source_storage_backend: StorageBackend =
      manifestInfo.source_storage_backend;
    let data_dir: string | null =
      manifestInfo.manifest.format === "pg_basebackup"
        ? join(resolvedTargetDir, "data")
        : null;
    const restore_manifest_path = dry_run
      ? null
      : join(resolvedTargetDir, "restore-manifest.json");
    let backup_manifest_path = manifestInfo.backup_manifest_path ?? null;
    if (dry_run) {
      notes.push("Dry run only; no restore files were written.");
      if (manifestInfo.manifest.format === "pg_basebackup") {
        notes.push(
          `Would stage a recoverable Postgres data directory at ${data_dir}.`,
        );
        notes.push(
          `Recovery would read archived WAL from ${paths.wal_archive_dir}.`,
        );
      } else {
        notes.push(
          `Would stage the SQL dump at ${join(resolvedTargetDir, "cluster.sql")}.`,
        );
        notes.push(
          "pg_dumpall backups are not recovery-ready clusters and require manual import into a fresh database.",
        );
      }
      if (manifestInfo.source_storage_backend === "r2") {
        notes.push(
          "The backup manifest is not present locally; restore would download metadata from R2.",
        );
      }
      return {
        ...currentBay,
        started_at,
        finished_at: new Date().toISOString(),
        dry_run,
        backup_set_id: resolvedBackupSetId,
        format: manifestInfo.manifest.format,
        target_dir: resolvedTargetDir,
        data_dir,
        backup_manifest_path:
          manifestInfo.source_storage_backend === "local"
            ? backup_manifest_path
            : null,
        restore_manifest_path,
        source_storage_backend,
        artifact_count: manifestInfo.manifest.artifacts.length,
        wal_segment_count: wal.archived_wal_count,
        recovery_ready: manifestInfo.manifest.format === "pg_basebackup",
        notes,
      };
    }

    if (await exists(resolvedTargetDir)) {
      const entries = await readdir(resolvedTargetDir);
      if (entries.length > 0) {
        throw new Error(
          `restore target directory is not empty: ${resolvedTargetDir}`,
        );
      }
    } else {
      await ensureDir(resolvedTargetDir);
    }

    const backupManifestCopyPath = join(
      resolvedTargetDir,
      "backup-manifest.json",
    );
    await writeJson(backupManifestCopyPath, manifestInfo.manifest);
    backup_manifest_path = backupManifestCopyPath;

    if (manifestInfo.manifest.format === "pg_basebackup") {
      const baseArtifact = manifestInfo.manifest.artifacts.find(
        (artifact) => artifact.name === "base.tar.gz",
      );
      if (!baseArtifact) {
        throw new Error("backup manifest is missing base.tar.gz");
      }
      const baseArtifactPath = await resolveArtifactPath({
        artifact: baseArtifact,
        r2,
        download_dir: tempDownloadDir,
      });
      source_storage_backend = baseArtifactPath.source_storage_backend;
      await ensureDir(data_dir!);
      await extractTarGz({
        archivePath: baseArtifactPath.path,
        targetDir: data_dir!,
      });
      const walArtifact = manifestInfo.manifest.artifacts.find(
        (artifact) => artifact.name === "pg_wal.tar.gz",
      );
      if (walArtifact) {
        const walArtifactPath = await resolveArtifactPath({
          artifact: walArtifact,
          r2,
          download_dir: tempDownloadDir,
        });
        if (walArtifactPath.source_storage_backend === "r2") {
          source_storage_backend = "r2";
        }
        await extractTarGz({
          archivePath: walArtifactPath.path,
          targetDir: join(data_dir!, "pg_wal"),
        });
      }
      await rm(join(data_dir!, "postmaster.pid"), {
        force: true,
      }).catch(() => undefined);
      await rm(join(data_dir!, "postmaster.opts"), {
        force: true,
      }).catch(() => undefined);

      const restoreScriptPath = join(resolvedTargetDir, "restore-wal.sh");
      await writeFile(
        restoreScriptPath,
        [
          "#!/bin/sh",
          "set -eu",
          `ARCHIVE_DIR=${shellQuote(paths.wal_archive_dir)}`,
          'SEGMENT="$1"',
          'DEST_PATH="$2"',
          'SRC_PATH="$ARCHIVE_DIR/$SEGMENT"',
          'if [ ! -f "$SRC_PATH" ]; then',
          "  exit 1",
          "fi",
          'cp "$SRC_PATH" "$DEST_PATH"',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const autoConfPath = join(data_dir!, "postgresql.auto.conf");
      const autoConfExisting = (await exists(autoConfPath))
        ? await readFile(autoConfPath, "utf8")
        : "";
      const recoveryConfig = [
        "",
        "# cocalc bay restore",
        `restore_command = ${postgresQuote(`${restoreScriptPath} %f %p`)}`,
        "recovery_target_timeline = 'latest'",
        "recovery_target_action = 'promote'",
        "",
      ].join("\n");
      await writeFile(
        autoConfPath,
        `${autoConfExisting}${recoveryConfig}`,
        "utf8",
      );
      await writeFile(join(data_dir!, "restore.signal"), "", "utf8");
      notes.push(`Restored base backup into ${data_dir}.`);
      notes.push(
        `Start the fenced restore with: postgres -D ${shellQuote(data_dir!)}`,
      );
      notes.push(
        `Archive recovery will read WAL segments from ${paths.wal_archive_dir}.`,
      );
    } else {
      const dumpArtifact = manifestInfo.manifest.artifacts.find(
        (artifact) => artifact.name === "cluster.sql.gz",
      );
      if (!dumpArtifact) {
        throw new Error("backup manifest is missing cluster.sql.gz");
      }
      const dumpArtifactPath = await resolveArtifactPath({
        artifact: dumpArtifact,
        r2,
        download_dir: tempDownloadDir,
      });
      source_storage_backend = dumpArtifactPath.source_storage_backend;
      const sqlPath = join(resolvedTargetDir, "cluster.sql");
      await gunzipFile(dumpArtifactPath.path, sqlPath);
      notes.push(`Restored SQL dump into ${sqlPath}.`);
      notes.push(
        "This backup was created via pg_dumpall; create a fresh Postgres cluster and import the SQL manually.",
      );
      data_dir = null;
    }

    const finished_at = new Date().toISOString();
    await writeJson(restore_manifest_path!, {
      bay_id: resolvedBayId,
      backup_set_id: resolvedBackupSetId,
      format: manifestInfo.manifest.format,
      started_at,
      finished_at,
      target_dir: resolvedTargetDir,
      data_dir,
      backup_manifest_path,
      source_storage_backend,
      wal_archive_dir: paths.wal_archive_dir,
      wal_segment_count: wal.archived_wal_count,
      recovery_ready: manifestInfo.manifest.format === "pg_basebackup",
      notes,
    });
    return {
      ...currentBay,
      started_at,
      finished_at,
      dry_run,
      backup_set_id: resolvedBackupSetId,
      format: manifestInfo.manifest.format,
      target_dir: resolvedTargetDir,
      data_dir,
      backup_manifest_path,
      restore_manifest_path,
      source_storage_backend,
      artifact_count: manifestInfo.manifest.artifacts.length,
      wal_segment_count: wal.archived_wal_count,
      recovery_ready: manifestInfo.manifest.format === "pg_basebackup",
      notes,
    };
  } finally {
    if (tempDownloadDir) {
      await rm(tempDownloadDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
