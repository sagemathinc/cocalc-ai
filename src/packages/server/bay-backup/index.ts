/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Bay control-plane backup strategy

- `runBayBackup()` makes the full snapshot. `startBayBackupMaintenance()`
  starts the periodic full-snapshot scheduler used by the running hub. Manual
  `cocalc bay backup` runs still use the same code path.
- A full snapshot captures the Postgres control-plane state plus the bay-local
  `sync` and `secrets` trees. The sqlite files in `sync` are snapshotted via
  sqlite `.backup`; `sync` and `secrets` are not copied continuously and are
  only refreshed when a full snapshot runs.
- Periodic scheduling only controls when a new full snapshot is taken. The
  scheduler computes its next run from the last successful snapshot time and
  keeps a shorter retry interval after maintenance failures. Freshness and next
  run state are recorded in `state.json` and shown by `cocalc bay backups`.
- The resulting snapshot artifacts are kept locally under the bay backup root.
  The full snapshot is then pushed to the regional rustic repo, using the bay
  id as the rustic host selector, so multiple bays can share one repo.
- Snapshot retention is applied after each successful full snapshot. Local
  archive directories are trimmed to the configured keep-last count, stale
  restore workspaces are deleted after a retention window, and the rustic repo
  gets a matching `forget --keep-last ... --prune` pass for the bay host.
- WAL archiving is separate from full snapshots. `startBayWalArchiveMaintenance`
  starts a background loop at Conat startup that keeps syncing archived WAL
  segments to direct R2 object storage.
- After a full snapshot finishes, `runBayBackup()` also forces a WAL switch and
  runs an immediate WAL sync so the snapshot has fresh replay coverage.
- Restore is therefore "full snapshot + archived WAL". The backup set carries
  enough information and helper scripts for fenced offline recovery, while the
  running-hub RPC is the convenience path for admins.
*/

import { execFile as execFile0 } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import {
  data,
  secrets,
  pghost,
  pgdatabase,
  pgssl,
  pguser,
  syncFiles,
  sslConfigToPsqlEnv,
} from "@cocalc/backend/data";
import getPort from "@cocalc/backend/get-port";
import getLogger from "@cocalc/backend/logger";
import { rustic as rusticBinary } from "@cocalc/backend/sandbox/install";
import { ensureInitialized as ensureRusticInitialized } from "@cocalc/backend/sandbox/rustic";
import { which } from "@cocalc/backend/which";
import getPool from "@cocalc/database/pool";
import dbPassword from "@cocalc/database/pool/password";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import type {
  BayBackupArtifactInfo,
  BayBackupRunResult,
  BayRestoreRunResult,
  BayRestoreTestRunResult,
  BayBackupStatus,
  BayRestoreReadinessStatus,
  BayBackupsPostgresStatus,
} from "@cocalc/conat/hub/api/system";
import { getSingleBayInfo } from "@cocalc/server/bay-directory";
import { getLaunchpadLocalConfig } from "@cocalc/server/launchpad/mode";
import {
  createBucket,
  issueSignedObjectDownload,
  listObjects,
  listBuckets,
  uploadObjectFromFile,
} from "@cocalc/server/project-backup/r2";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  parseR2Region,
} from "@cocalc/util/consts";

const logger = getLogger("server:bay-backup");
const execFile = promisify(execFile0);
const RESTORE_TEST_QUERIES: RestoreTestQuery[] = [
  {
    label: "current_database",
    sql: "SELECT current_database()",
    expected: pgdatabase,
  },
  {
    label: "accounts_table",
    sql: "SELECT to_regclass('public.accounts')::text",
    expected: "accounts",
  },
  {
    label: "projects_table",
    sql: "SELECT to_regclass('public.projects')::text",
    expected: "projects",
  },
  {
    label: "server_settings_table",
    sql: "SELECT to_regclass('public.server_settings')::text",
    expected: "server_settings",
  },
];
const RESTORE_TEST_PITR_TABLE = "public.bay_restore_test_pitr_events";

type BackupStrategy = "pg_basebackup" | "pg_dumpall";
type StorageBackend = "local" | "r2" | "rustic";

type RestoreTestQuery = {
  label: string;
  sql: string;
  expected: string;
};

type PitrRestoreSentinel = {
  run_id: string;
  target_time: string;
};

type StoredBayBackupState = {
  bay_id: string;
  current_storage_backend: StorageBackend;
  r2_configured: boolean;
  bucket_name: string | null;
  bucket_region: string | null;
  bucket_endpoint: string | null;
  object_prefix_root: string | null;
  rustic_repo_selector: string | null;
  latest_backup_set_id: string | null;
  latest_format: BackupStrategy | null;
  latest_storage_backend: StorageBackend | null;
  latest_local_manifest_path: string | null;
  latest_remote_manifest_key: string | null;
  latest_object_prefix: string | null;
  latest_remote_snapshot_id: string | null;
  latest_remote_snapshot_host: string | null;
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
  maintenance_last_started_at: string | null;
  maintenance_last_finished_at: string | null;
  maintenance_last_success_at: string | null;
  maintenance_last_error_at: string | null;
  maintenance_last_error: string | null;
  maintenance_next_run_at: string | null;
  last_pruned_at: string | null;
  last_pruned_local_archive_count: number;
  last_pruned_restore_count: number;
  last_restore_test_backup_set_id: string | null;
  last_restore_test_status: "passed" | "failed" | null;
  last_restore_tested_at: string | null;
  last_restore_test_target_dir: string | null;
  last_restore_test_recovery_ready: boolean | null;
  last_pitr_test_backup_set_id: string | null;
  last_pitr_test_status: "passed" | "failed" | null;
  last_pitr_tested_at: string | null;
  last_pitr_test_target_time: string | null;
  last_pitr_test_target_dir: string | null;
  last_pitr_test_remote_only: boolean | null;
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
  remote_snapshot_id: string | null;
  remote_snapshot_host: string | null;
  rustic_repo_selector: string | null;
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

type BayRusticRepoConfig = {
  repo_toml: string;
  repo_selector: string;
  repo_root: string;
  region: string;
  bucket_name: string;
  bucket_endpoint: string;
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
  remote_snapshot_id: string | null;
};

type ControlPlaneArtifact = {
  name: string;
  local_path: string;
  type: "sync" | "secrets";
};

type RusticSnapshotInfo = {
  id: string;
  time: string | null;
  hostname: string | null;
  tags: string[];
  paths: string[];
};

let runInFlight: Promise<BayBackupRunResult> | null = null;
let walMaintenanceTimer: NodeJS.Timeout | undefined;
let walMaintenanceRunning = false;
let backupMaintenanceTimer: NodeJS.Timeout | undefined;
let backupMaintenanceRunning = false;

const DEFAULT_WAL_ARCHIVE_INTERVAL_MS = 60 * 1000;
const DEFAULT_BAY_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BAY_BACKUP_RETRY_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_BAY_BACKUP_RETENTION_COUNT = 14;
const DEFAULT_BAY_BACKUP_RESTORE_RETENTION_DAYS = 7;

function getWalArchiveIntervalMs(): number {
  const n = Number.parseInt(
    `${process.env.COCALC_BAY_WAL_ARCHIVE_INTERVAL_MS ?? ""}`,
    10,
  );
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WAL_ARCHIVE_INTERVAL_MS;
}

function parsePositiveIntEnv({
  name,
  defaultValue,
  allowZero = false,
}: {
  name: string;
  defaultValue: number;
  allowZero?: boolean;
}): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (raw === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    return defaultValue;
  }
  return parsed;
}

function getBayBackupIntervalMs(): number | null {
  const raw = `${process.env.COCALC_BAY_BACKUP_INTERVAL_MS ?? ""}`.trim();
  if (raw === "") {
    return DEFAULT_BAY_BACKUP_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_BAY_BACKUP_INTERVAL_MS;
  }
  return parsed === 0 ? null : parsed;
}

function getBayBackupRetryIntervalMs(): number {
  return parsePositiveIntEnv({
    name: "COCALC_BAY_BACKUP_RETRY_INTERVAL_MS",
    defaultValue: DEFAULT_BAY_BACKUP_RETRY_INTERVAL_MS,
  });
}

function getBayBackupRetentionCount(): number {
  return parsePositiveIntEnv({
    name: "COCALC_BAY_BACKUP_RETENTION_COUNT",
    defaultValue: DEFAULT_BAY_BACKUP_RETENTION_COUNT,
    allowZero: true,
  });
}

function getBayBackupRestoreRetentionDays(): number {
  return parsePositiveIntEnv({
    name: "COCALC_BAY_BACKUP_RESTORE_RETENTION_DAYS",
    defaultValue: DEFAULT_BAY_BACKUP_RESTORE_RETENTION_DAYS,
    allowZero: true,
  });
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

async function ensureDir(path: string, mode?: number): Promise<void> {
  await mkdir(path, {
    recursive: true,
    ...(mode == null ? {} : { mode }),
  });
  if (mode != null) {
    await chmod(path, mode).catch(() => undefined);
  }
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
    rustic_repo_selector: null,
    latest_backup_set_id: null,
    latest_format: null,
    latest_storage_backend: null,
    latest_local_manifest_path: null,
    latest_remote_manifest_key: null,
    latest_object_prefix: null,
    latest_remote_snapshot_id: null,
    latest_remote_snapshot_host: null,
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
    maintenance_last_started_at: null,
    maintenance_last_finished_at: null,
    maintenance_last_success_at: null,
    maintenance_last_error_at: null,
    maintenance_last_error: null,
    maintenance_next_run_at: null,
    last_pruned_at: null,
    last_pruned_local_archive_count: 0,
    last_pruned_restore_count: 0,
    last_restore_test_backup_set_id: null,
    last_restore_test_status: null,
    last_restore_tested_at: null,
    last_restore_test_target_dir: null,
    last_restore_test_recovery_ready: null,
    last_pitr_test_backup_set_id: null,
    last_pitr_test_status: null,
    last_pitr_tested_at: null,
    last_pitr_test_target_time: null,
    last_pitr_test_target_dir: null,
    last_pitr_test_remote_only: null,
  };
}

type BayBackupMaintenanceConfig = {
  enabled: boolean;
  full_snapshot_interval_ms: number | null;
  full_snapshot_retry_interval_ms: number;
  full_snapshot_retention_count: number;
  restore_workspace_retention_days: number;
};

function getBayBackupMaintenanceConfig(): BayBackupMaintenanceConfig {
  const full_snapshot_interval_ms = getBayBackupIntervalMs();
  return {
    enabled: full_snapshot_interval_ms != null,
    full_snapshot_interval_ms,
    full_snapshot_retry_interval_ms: getBayBackupRetryIntervalMs(),
    full_snapshot_retention_count: getBayBackupRetentionCount(),
    restore_workspace_retention_days: getBayBackupRestoreRetentionDays(),
  };
}

async function loadBayBackupState({
  bay_id,
}: {
  bay_id?: string;
} = {}): Promise<{
  bay_id: string;
  paths: ReturnType<typeof getBayBackupPaths>;
  r2: R2Target;
  rusticRepo: BayRusticRepoConfig | null;
  current_storage_backend: StorageBackend;
  state: StoredBayBackupState;
}> {
  const currentBay = getSingleBayInfo();
  const resolvedBayId =
    `${bay_id ?? currentBay.bay_id}`.trim() || currentBay.bay_id;
  if (resolvedBayId !== currentBay.bay_id) {
    throw new Error(`bay '${resolvedBayId}' not found`);
  }
  const r2 = await resolveR2Target(resolvedBayId);
  const rusticRepo = await buildBayRusticRepoConfig({ r2 });
  const current_storage_backend: StorageBackend = rusticRepo
    ? "rustic"
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
    rustic_repo_selector:
      rusticRepo?.repo_selector ?? stored.rustic_repo_selector ?? null,
    last_archived_wal_segment: stored.last_archived_wal_segment ?? null,
    last_uploaded_wal_segment: stored.last_uploaded_wal_segment ?? null,
    latest_remote_snapshot_id: stored.latest_remote_snapshot_id ?? null,
    latest_remote_snapshot_host: stored.latest_remote_snapshot_host ?? null,
    last_restore_test_backup_set_id:
      stored.last_restore_test_backup_set_id ?? null,
    last_restore_test_status: stored.last_restore_test_status ?? null,
    last_restore_tested_at: stored.last_restore_tested_at ?? null,
    last_restore_test_target_dir: stored.last_restore_test_target_dir ?? null,
    last_restore_test_recovery_ready:
      stored.last_restore_test_recovery_ready ?? null,
  };
  return {
    bay_id: resolvedBayId,
    paths,
    r2,
    rusticRepo,
    current_storage_backend,
    state,
  };
}

async function writeUpdatedBayBackupState({
  bay_id,
  update,
}: {
  bay_id?: string;
  update: (state: StoredBayBackupState) => StoredBayBackupState;
}): Promise<StoredBayBackupState> {
  const loaded = await loadBayBackupState({ bay_id });
  const next = update(loaded.state);
  await ensureDir(dirname(loaded.paths.state_file));
  await writeJson(loaded.paths.state_file, next);
  return next;
}

function computeNextBackupMaintenanceDelayMs({
  state,
  config,
  now = Date.now(),
}: {
  state: StoredBayBackupState;
  config: BayBackupMaintenanceConfig;
  now?: number;
}): number | null {
  if (!config.enabled || config.full_snapshot_interval_ms == null) {
    return null;
  }
  const lastSuccessful = state.last_successful_backup_at
    ? Date.parse(state.last_successful_backup_at)
    : Number.NaN;
  if (!Number.isFinite(lastSuccessful)) {
    return 0;
  }
  return Math.max(0, lastSuccessful + config.full_snapshot_interval_ms - now);
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

const bayBackupSharedSecretPath = join(secrets, "backup-shared-secret");
let bayBackupSharedSecret: string | undefined;

async function getBayBackupSharedSecret(): Promise<string> {
  if (bayBackupSharedSecret) return bayBackupSharedSecret;
  let encoded = "";
  try {
    encoded = (await readFile(bayBackupSharedSecretPath, "utf8")).trim();
  } catch {
    // create below
  }
  if (!encoded) {
    encoded = randomBytes(32).toString("base64url");
    await ensureDir(dirname(bayBackupSharedSecretPath));
    await writeFile(bayBackupSharedSecretPath, encoded, { mode: 0o600 });
  }
  bayBackupSharedSecret = encoded;
  return encoded;
}

function buildBayRusticS3Toml({
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

async function buildBayRusticRepoConfig({
  r2,
}: {
  r2: R2Target;
}): Promise<BayRusticRepoConfig | null> {
  if (
    !r2.configured ||
    !r2.bucket_name ||
    !r2.bucket_region ||
    !r2.bucket_endpoint ||
    !r2.access_key ||
    !r2.secret_key
  ) {
    return null;
  }
  const region = r2.bucket_region;
  const root = `rustic/bay-backups/${region}`;
  return {
    repo_toml: buildBayRusticS3Toml({
      endpoint: r2.bucket_endpoint,
      bucket: r2.bucket_name,
      accessKey: r2.access_key,
      secretKey: r2.secret_key,
      password: await getBayBackupSharedSecret(),
      root,
    }),
    repo_selector: `r2:bay-backups:${region}`,
    repo_root: root,
    region,
    bucket_name: r2.bucket_name,
    bucket_endpoint: r2.bucket_endpoint,
  };
}

async function ensureBayRusticRepoProfile({
  repo_selector,
  repo_toml,
}: BayRusticRepoConfig): Promise<string> {
  const digest = createHash("sha256")
    .update(`${repo_selector}\0${repo_toml}`)
    .digest("hex");
  const dir = join(secrets, "rustic", "bay-backups");
  const path = join(dir, `${digest}.toml`);
  try {
    if ((await readFile(path, "utf8")) === repo_toml) {
      await ensureRusticInitialized(path);
      return path;
    }
  } catch {
    // write below
  }
  await mkdir(dir, { recursive: true });
  await writeFile(path, repo_toml, { mode: 0o600 });
  await ensureRusticInitialized(path);
  return path;
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

function normalizeRecoveryTargetTime(value?: string): string | null {
  const trimmed = `${value ?? ""}`.trim();
  if (trimmed === "") {
    return null;
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      trimmed,
    )
  ) {
    throw new Error(
      "target_time must be an RFC3339 timestamp with an explicit timezone, e.g. 2026-04-07T15:37:57Z",
    );
  }
  const normalized = new Date(trimmed);
  if (Number.isNaN(normalized.getTime())) {
    throw new Error(`invalid target_time '${trimmed}'`);
  }
  return normalized.toISOString();
}

function formatRecoveryTargetTimeForPostgres(value: string): string {
  return value.replace("T", " ").replace("Z", "+00");
}

const WAL_SEGMENT_NAME_RE = /^[0-9A-F]{24}(?:\.partial)?$/;

async function refreshBundledWalSegmentsFromArchive({
  pgWalDir,
  remote_only,
  paths,
  r2,
  wal_object_prefix,
  remote_wal_keys,
}: {
  pgWalDir: string;
  remote_only: boolean;
  paths: ReturnType<typeof getBayBackupPaths>;
  r2: R2Target;
  wal_object_prefix: string | null;
  remote_wal_keys: string[] | null;
}): Promise<void> {
  const names = await readdir(pgWalDir).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  });
  for (const name of names) {
    if (!WAL_SEGMENT_NAME_RE.test(name)) continue;
    const destinationPath = join(pgWalDir, name);
    if (!remote_only) {
      const archivedPath = join(paths.wal_archive_dir, name);
      if (await exists(archivedPath)) {
        await copyFile(archivedPath, destinationPath);
      }
      continue;
    }
    if (!wal_object_prefix || !remote_wal_keys) continue;
    const object_key = `${wal_object_prefix}/${name}`;
    if (!remote_wal_keys.includes(object_key)) continue;
    await downloadObjectToFileFromR2({
      target: r2,
      key: object_key,
      destinationPath,
    });
  }
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

function rusticCommonArgs(repoProfilePath: string): string[] {
  return repoProfilePath.endsWith(".toml")
    ? ["-P", repoProfilePath.slice(0, -5)]
    : ["--password", "", "-r", repoProfilePath];
}

async function execRustic({
  repoProfilePath,
  args,
  cwd,
  timeout = 10 * 60 * 1000,
}: {
  repoProfilePath: string;
  args: string[];
  cwd?: string;
  timeout?: number;
}): Promise<string> {
  const { stdout } = await execFile(
    rusticBinary,
    [...rusticCommonArgs(repoProfilePath), ...args],
    {
      cwd,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  return `${stdout ?? ""}`;
}

function flattenRusticSnapshotGroups(groups: unknown): RusticSnapshotInfo[] {
  if (!Array.isArray(groups)) return [];
  const snapshots: RusticSnapshotInfo[] = [];
  for (const group of groups) {
    const grouped = Array.isArray((group as any)?.snapshots)
      ? (group as any).snapshots
      : Array.isArray(group) && Array.isArray((group as any)[1])
        ? (group as any)[1]
        : [];
    for (const snapshot of grouped) {
      const id = `${snapshot?.id ?? ""}`.trim();
      if (!id) continue;
      snapshots.push({
        id,
        time: typeof snapshot?.time === "string" ? snapshot.time : null,
        hostname:
          typeof snapshot?.hostname === "string" ? snapshot.hostname : null,
        tags: Array.isArray(snapshot?.tags)
          ? snapshot.tags
              .map((tag: unknown) => `${tag ?? ""}`.trim())
              .filter(Boolean)
          : [],
        paths: Array.isArray(snapshot?.paths)
          ? snapshot.paths
              .map((path: unknown) => `${path ?? ""}`.trim())
              .filter(Boolean)
          : [],
      });
    }
  }
  snapshots.sort((a, b) =>
    `${b.time ?? ""}\0${b.id}`.localeCompare(`${a.time ?? ""}\0${a.id}`),
  );
  return snapshots;
}

async function listBayRusticSnapshots({
  repoProfilePath,
  snapshotHost,
}: {
  repoProfilePath: string;
  snapshotHost: string;
}): Promise<RusticSnapshotInfo[]> {
  const stdout = await execRustic({
    repoProfilePath,
    args: ["snapshots", "--json", "--filter-host", snapshotHost],
  });
  return flattenRusticSnapshotGroups(JSON.parse(stdout));
}

async function findBayRusticSnapshot({
  repoProfilePath,
  snapshotHost,
  backup_set_id,
}: {
  repoProfilePath: string;
  snapshotHost: string;
  backup_set_id: string;
}): Promise<RusticSnapshotInfo> {
  const snapshots = await listBayRusticSnapshots({
    repoProfilePath,
    snapshotHost,
  });
  const expectedTag = `backup-set-id=${backup_set_id}`;
  const snapshot = snapshots.find((entry) => entry.tags.includes(expectedTag));
  if (!snapshot) {
    throw new Error(
      `rustic snapshot for backup set '${backup_set_id}' and host '${snapshotHost}' was not found`,
    );
  }
  return snapshot;
}

async function backupToBayRusticRepo({
  repoProfilePath,
  snapshotHost,
  backup_set_id,
  format,
  sourceDir,
}: {
  repoProfilePath: string;
  snapshotHost: string;
  backup_set_id: string;
  format: BackupStrategy;
  sourceDir: string;
}): Promise<RusticSnapshotInfo> {
  await execRustic({
    repoProfilePath,
    cwd: sourceDir,
    args: [
      "backup",
      "--json",
      "--host",
      snapshotHost,
      "--tag",
      `backup-set-id=${backup_set_id}`,
      "--tag",
      `backup-format=${format}`,
      "--tag",
      `bay-id=${snapshotHost}`,
      ".",
    ],
    timeout: 30 * 60 * 1000,
  });
  return await findBayRusticSnapshot({
    repoProfilePath,
    snapshotHost,
    backup_set_id,
  });
}

async function restoreBayRusticPath({
  repoProfilePath,
  snapshot_id,
  path,
  destinationDir,
}: {
  repoProfilePath: string;
  snapshot_id: string;
  path?: string;
  destinationDir: string;
}): Promise<void> {
  await ensureDir(destinationDir);
  await execRustic({
    repoProfilePath,
    args: [
      "restore",
      path ? `${snapshot_id}:${path}` : snapshot_id,
      destinationDir,
    ],
    timeout: 30 * 60 * 1000,
  });
}

function sqliteShellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}

async function tarGzDirectory({
  sourceDir,
  archivePath,
}: {
  sourceDir: string;
  archivePath: string;
}): Promise<void> {
  await ensureDir(dirname(archivePath));
  await execFile(
    "tar",
    ["-C", dirname(sourceDir), "-czf", archivePath, basename(sourceDir)],
    {
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

async function backupSqliteDatabase({
  sourcePath,
  destinationPath,
}: {
  sourcePath: string;
  destinationPath: string;
}): Promise<void> {
  await ensureDir(dirname(destinationPath));
  await execFile(
    "sqlite3",
    [
      sourcePath,
      ".timeout 5000",
      `.backup ${sqliteShellQuote(destinationPath)}`,
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

async function snapshotSyncTree({
  sourceDir,
  destinationDir,
}: {
  sourceDir: string;
  destinationDir: string;
}): Promise<void> {
  await ensureDir(destinationDir);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      // If the sync tree ever grows large, keep a persistent staged snapshot
      // and refresh only sqlite files whose .db/.db-wal/.db-shm inputs changed
      // since the previous backup instead of rebuilding the whole tree here.
      await snapshotSyncTree({
        sourceDir: sourcePath,
        destinationDir: destinationPath,
      });
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.endsWith(".db")) {
        await backupSqliteDatabase({
          sourcePath,
          destinationPath,
        });
        continue;
      }
      if (entry.name.endsWith(".db-wal") || entry.name.endsWith(".db-shm")) {
        continue;
      }
      await ensureDir(dirname(destinationPath));
      await copyFile(sourcePath, destinationPath);
      const info = await stat(sourcePath);
      await chmod(destinationPath, info.mode);
    }
  }
}

async function copySecretsTree({
  sourceDir,
  destinationDir,
}: {
  sourceDir: string;
  destinationDir: string;
}): Promise<void> {
  await ensureDir(destinationDir);
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith(".pid")) {
      continue;
    }
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await copySecretsTree({
        sourceDir: sourcePath,
        destinationDir: destinationPath,
      });
      continue;
    }
    if (entry.isFile()) {
      await ensureDir(dirname(destinationPath));
      await copyFile(sourcePath, destinationPath);
      const info = await stat(sourcePath);
      await chmod(destinationPath, info.mode);
    }
  }
}

async function stageControlPlaneArtifacts({
  stagingDir,
}: {
  stagingDir: string;
}): Promise<ControlPlaneArtifact[]> {
  const artifacts: ControlPlaneArtifact[] = [];

  if (await exists(syncFiles.local)) {
    const syncSnapshotDir = join(stagingDir, "sync");
    await snapshotSyncTree({
      sourceDir: syncFiles.local,
      destinationDir: syncSnapshotDir,
    });
    const syncArchivePath = join(stagingDir, "sync.tar.gz");
    // This gzip/tar packaging is simple and works well for the current
    // local-cache plus direct-object-storage layout. If the rustic repo becomes
    // the long-term canonical remote backend, we should reconsider this and
    // likely snapshot the uncompressed tree instead so rustic can deduplicate
    // unchanged sqlite pages and other repeated content across bay backups.
    await tarGzDirectory({
      sourceDir: syncSnapshotDir,
      archivePath: syncArchivePath,
    });
    await rm(syncSnapshotDir, { recursive: true, force: true });
    artifacts.push({
      name: "sync.tar.gz",
      local_path: syncArchivePath,
      type: "sync",
    });
  }

  if (await exists(secrets)) {
    const secretsSnapshotDir = join(stagingDir, "secrets");
    await copySecretsTree({
      sourceDir: secrets,
      destinationDir: secretsSnapshotDir,
    });
    const secretsArchivePath = join(stagingDir, "secrets.tar.gz");
    // The same compression tradeoff applies here as for sync/postgres: tar.gz
    // is convenient for local/offline handling, but if rustic becomes the main
    // remote store then an uncompressed staged tree may be better so rustic can
    // deduplicate repeated secret material across snapshots while still keeping
    // the remote copy encrypted at rest.
    await tarGzDirectory({
      sourceDir: secretsSnapshotDir,
      archivePath: secretsArchivePath,
    });
    await rm(secretsSnapshotDir, { recursive: true, force: true });
    artifacts.push({
      name: "secrets.tar.gz",
      local_path: secretsArchivePath,
      type: "secrets",
    });
  }

  return artifacts;
}

async function writeOfflineRestoreHelper({
  archiveDir,
  backup_set_id,
}: {
  archiveDir: string;
  backup_set_id: string;
}): Promise<void> {
  const helperPath = join(archiveDir, "restore-offline.sh");
  const readmePath = join(archiveDir, "RESTORE-OFFLINE.txt");
  const script = [
    "#!/bin/sh",
    "set -eu",
    "",
    'BACKUP_DIR="${1:-$(pwd)}"',
    'TARGET_DIR="${2:-$BACKUP_DIR/restore-output}"',
    'MANIFEST_PATH="$BACKUP_DIR/manifest.json"',
    'if [ ! -f "$MANIFEST_PATH" ]; then',
    '  echo "missing manifest.json in $BACKUP_DIR" >&2',
    "  exit 1",
    "fi",
    'mkdir -p "$TARGET_DIR"',
    'cp "$MANIFEST_PATH" "$TARGET_DIR/backup-manifest.json"',
    'if [ -f "$BACKUP_DIR/base.tar.gz" ]; then',
    '  mkdir -p "$TARGET_DIR/data"',
    '  tar -xzf "$BACKUP_DIR/base.tar.gz" -C "$TARGET_DIR/data"',
    '  if [ -f "$BACKUP_DIR/pg_wal.tar.gz" ]; then',
    '    mkdir -p "$TARGET_DIR/data/pg_wal"',
    '    tar -xzf "$BACKUP_DIR/pg_wal.tar.gz" -C "$TARGET_DIR/data/pg_wal"',
    "  fi",
    '  rm -f "$TARGET_DIR/data/postmaster.pid" "$TARGET_DIR/data/postmaster.opts"',
    '  echo "restored Postgres base backup into $TARGET_DIR/data"',
    '  echo "If you also have the archived WAL available, add a restore_command"',
    '  echo "to $TARGET_DIR/data/postgresql.auto.conf. Use restore.signal for"',
    '  echo "recovery to the latest available WAL, or standby.signal for"',
    '  echo "targeted PITR so PostgreSQL keeps fetching archive WAL until the"',
    '  echo "requested target is reached."',
    '  echo "Otherwise you can start the fenced snapshot directly with:"',
    '  echo "  postgres -D $TARGET_DIR/data"',
    "fi",
    'if [ -f "$BACKUP_DIR/cluster.sql.gz" ]; then',
    '  gzip -dc "$BACKUP_DIR/cluster.sql.gz" > "$TARGET_DIR/cluster.sql"',
    '  echo "wrote $TARGET_DIR/cluster.sql for manual import"',
    "fi",
    'if [ -f "$BACKUP_DIR/sync.tar.gz" ]; then',
    '  tar -xzf "$BACKUP_DIR/sync.tar.gz" -C "$TARGET_DIR"',
    '  echo "restored Conat sync tree into $TARGET_DIR/sync"',
    "fi",
    'if [ -f "$BACKUP_DIR/secrets.tar.gz" ]; then',
    '  tar -xzf "$BACKUP_DIR/secrets.tar.gz" -C "$TARGET_DIR"',
    '  echo "restored bay secrets into $TARGET_DIR/secrets"',
    "fi",
    "",
  ].join("\n");
  const readme = [
    `CoCalc bay offline restore helper for backup set ${backup_set_id}.`,
    "",
    "This backup set can be restored without a running hub.",
    "",
    "Fast path:",
    "  ./restore-offline.sh /path/to/unpacked-backup-set /path/to/restore-target",
    "",
    "What it restores:",
    "  - backup-manifest.json",
    "  - a fenced Postgres data directory from base.tar.gz when present",
    "  - cluster.sql from cluster.sql.gz for pg_dumpall backups",
    "  - sync/ from sync.tar.gz when present",
    "  - secrets/ from secrets.tar.gz when present",
    "",
    "Limitations:",
    "  - The hub RPC `cocalc bay restore` is still the easiest admin path.",
    "  - Point-in-time replay still needs archived WAL access outside this backup set.",
    "  - For pg_basebackup snapshots, pg_wal.tar.gz is restored, so the fenced",
    "    snapshot itself is locally recoverable to the checkpoint captured by",
    "    the backup even before extra archived WAL is configured.",
    "",
  ].join("\n");
  await writeFile(helperPath, script, { mode: 0o700 });
  await writeFile(readmePath, readme, "utf8");
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
      // `-Ft -z` gives us portable local artifacts (`base.tar.gz`,
      // `pg_wal.tar.gz`) that are easy to inspect and restore directly.
      // If rustic remains the primary remote backend, this is probably not the
      // best long-term representation because the pre-compressed tarballs
      // prevent rustic from deduplicating repeated page-level content across
      // snapshots. A future cleanup should consider staging an uncompressed
      // base-backup directory for rustic while keeping the current tarballs
      // only for local/offline convenience.
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

async function readStoredBackupManifests({
  paths,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
}): Promise<StoredBayBackupManifest[]> {
  const entries = await readdir(paths.manifests_dir).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  });
  const manifests = await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        return await readJsonIfExists<StoredBayBackupManifest>(
          join(paths.manifests_dir, name),
        );
      }),
  );
  return manifests
    .filter((manifest): manifest is StoredBayBackupManifest => manifest != null)
    .sort((a, b) =>
      `${b.finished_at ?? b.created_at ?? ""}\0${b.backup_set_id}`.localeCompare(
        `${a.finished_at ?? a.created_at ?? ""}\0${a.backup_set_id}`,
      ),
    );
}

async function pruneLocalArchiveDirectories({
  paths,
  keep_backup_set_ids,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  keep_backup_set_ids: Set<string>;
}): Promise<number> {
  const entries = await readdir(paths.archives_dir).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  });
  let removed = 0;
  for (const name of entries) {
    if (keep_backup_set_ids.has(name)) continue;
    const path = join(paths.archives_dir, name);
    const info = await stat(path).catch((err) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw err;
    });
    if (!info?.isDirectory()) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function pruneRestoreWorkspaces({
  paths,
  retention_days,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  retention_days: number;
}): Promise<number> {
  if (retention_days <= 0) {
    return 0;
  }
  const entries = await readdir(paths.restores_dir).catch((err) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  });
  const cutoff = Date.now() - retention_days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of entries) {
    const path = join(paths.restores_dir, name);
    const info = await stat(path).catch((err) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw err;
    });
    if (!info?.isDirectory()) continue;
    if (info.mtimeMs >= cutoff) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function pruneBayRusticSnapshots({
  repoProfilePath,
  snapshotHost,
  keep_last,
}: {
  repoProfilePath: string;
  snapshotHost: string;
  keep_last: number;
}): Promise<void> {
  if (keep_last <= 0) {
    return;
  }
  await execRustic({
    repoProfilePath,
    args: [
      "forget",
      "--host",
      snapshotHost,
      "--keep-last",
      `${keep_last}`,
      "--prune",
    ],
    timeout: 30 * 60 * 1000,
  });
}

async function applyBayBackupRetention({
  bay_id,
  paths,
  state,
  rusticRepoProfilePath,
}: {
  bay_id: string;
  paths: ReturnType<typeof getBayBackupPaths>;
  state: StoredBayBackupState;
  rusticRepoProfilePath: string | null;
}): Promise<StoredBayBackupState> {
  const config = getBayBackupMaintenanceConfig();
  let pruned_local_archive_count = 0;
  let pruned_restore_count = 0;

  if (config.full_snapshot_retention_count > 0) {
    const manifests = await readStoredBackupManifests({ paths });
    const keep = new Set<string>();
    for (const manifest of manifests.slice(
      0,
      config.full_snapshot_retention_count,
    )) {
      keep.add(manifest.backup_set_id);
    }
    for (const pinned of [
      state.latest_backup_set_id,
      state.last_restore_test_backup_set_id,
      state.last_pitr_test_backup_set_id,
    ]) {
      if (pinned) {
        keep.add(pinned);
      }
    }
    pruned_local_archive_count = await pruneLocalArchiveDirectories({
      paths,
      keep_backup_set_ids: keep,
    });
    if (rusticRepoProfilePath) {
      await pruneBayRusticSnapshots({
        repoProfilePath: rusticRepoProfilePath,
        snapshotHost: bay_id,
        keep_last: config.full_snapshot_retention_count,
      });
    }
  }

  pruned_restore_count = await pruneRestoreWorkspaces({
    paths,
    retention_days: config.restore_workspace_retention_days,
  });

  return {
    ...state,
    last_pruned_at: new Date().toISOString(),
    last_pruned_local_archive_count: pruned_local_archive_count,
    last_pruned_restore_count: pruned_restore_count,
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
  rusticRepoProfilePath,
  download_dir,
  prefer_local = true,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  bay_id: string;
  backup_set_id: string;
  r2: R2Target;
  rusticRepoProfilePath?: string | null;
  download_dir?: string;
  prefer_local?: boolean;
}): Promise<ResolvedBackupManifest> {
  const localManifestPath = join(paths.manifests_dir, `${backup_set_id}.json`);
  const localManifest = prefer_local
    ? await readJsonIfExists<StoredBayBackupManifest>(localManifestPath)
    : undefined;
  if (prefer_local && localManifest) {
    return {
      manifest: localManifest,
      backup_manifest_path: localManifestPath,
      source_storage_backend: "local",
      remote_snapshot_id: localManifest.remote_snapshot_id ?? null,
    };
  }
  if (download_dir && rusticRepoProfilePath) {
    try {
      const snapshot = await findBayRusticSnapshot({
        repoProfilePath: rusticRepoProfilePath,
        snapshotHost: bay_id,
        backup_set_id,
      });
      const restoreDir = join(download_dir, "rustic-manifest");
      await restoreBayRusticPath({
        repoProfilePath: rusticRepoProfilePath,
        snapshot_id: snapshot.id,
        path: "manifest.json",
        destinationDir: restoreDir,
      });
      const downloadPath = join(restoreDir, "manifest.json");
      const manifest = JSON.parse(
        await readFile(downloadPath, "utf8"),
      ) as StoredBayBackupManifest;
      return {
        manifest,
        backup_manifest_path: downloadPath,
        source_storage_backend: "rustic",
        remote_snapshot_id: snapshot.id,
      };
    } catch (err) {
      logger.debug(
        "rustic bay backup manifest lookup missed; trying legacy R2",
        {
          bay_id,
          backup_set_id,
          err,
        },
      );
    }
  }
  if (download_dir) {
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
      remote_snapshot_id: null,
    };
  }
  throw new Error(
    `backup manifest for '${backup_set_id}' is not available locally`,
  );
}

async function resolveArtifactPath({
  artifact,
  r2,
  remote_snapshot_id,
  rusticRepoProfilePath,
  download_dir,
  prefer_local = true,
}: {
  artifact: BayBackupArtifactInfo;
  r2: R2Target;
  remote_snapshot_id?: string | null;
  rusticRepoProfilePath?: string | null;
  download_dir?: string;
  prefer_local?: boolean;
}): Promise<{
  path: string;
  source_storage_backend: StorageBackend;
}> {
  if (
    prefer_local &&
    artifact.local_path &&
    (await exists(artifact.local_path))
  ) {
    return {
      path: artifact.local_path,
      source_storage_backend: "local",
    };
  }
  if (remote_snapshot_id && rusticRepoProfilePath) {
    if (!download_dir) {
      throw new Error(
        `artifact '${artifact.name}' requires rustic download but no download dir is available`,
      );
    }
    const destinationDir = join(download_dir, "artifacts");
    await restoreBayRusticPath({
      repoProfilePath: rusticRepoProfilePath,
      snapshot_id: remote_snapshot_id,
      path: artifact.name,
      destinationDir,
    });
    return {
      path: join(destinationDir, artifact.name),
      source_storage_backend: "rustic",
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

function findArtifactByName(
  artifacts: BayBackupArtifactInfo[],
  name: string,
): BayBackupArtifactInfo | undefined {
  return artifacts.find((artifact) => artifact.name === name);
}

function walObjectPrefix(root: string | null): string | null {
  return root ? `${root}/wal` : null;
}

async function listRemoteWalObjectKeys({
  r2,
  wal_object_prefix,
}: {
  r2: R2Target;
  wal_object_prefix: string;
}): Promise<string[]> {
  if (
    !r2.configured ||
    !r2.bucket_name ||
    !r2.bucket_endpoint ||
    !r2.access_key ||
    !r2.secret_key
  ) {
    throw new Error("R2 target is not configured for remote WAL restore");
  }
  return await listObjects({
    endpoint: r2.bucket_endpoint,
    accessKey: r2.access_key,
    secretKey: r2.secret_key,
    bucket: r2.bucket_name,
    prefix: `${wal_object_prefix}/`,
  });
}

async function writeRemoteWalRestoreHelper({
  targetDir,
  r2,
  wal_object_prefix,
}: {
  targetDir: string;
  r2: R2Target;
  wal_object_prefix: string;
}): Promise<string> {
  if (
    !r2.bucket_endpoint ||
    !r2.access_key ||
    !r2.secret_key ||
    !r2.bucket_name
  ) {
    throw new Error("R2 target is not configured for remote WAL restore");
  }
  const requestLogPath = join(targetDir, "restore-wal.requests.log");
  const scriptPath = join(targetDir, "restore-wal.js");
  const script = [
    "#!/usr/bin/env node",
    "const { createHash, createHmac } = require('node:crypto');",
    "const { appendFileSync, createWriteStream, mkdirSync } = require('node:fs');",
    "const { dirname } = require('node:path');",
    "const { Readable } = require('node:stream');",
    "const { pipeline } = require('node:stream/promises');",
    `const ENDPOINT = ${JSON.stringify(r2.bucket_endpoint)};`,
    `const ACCESS_KEY = ${JSON.stringify(r2.access_key)};`,
    `const SECRET_KEY = ${JSON.stringify(r2.secret_key)};`,
    `const BUCKET = ${JSON.stringify(r2.bucket_name)};`,
    `const PREFIX = ${JSON.stringify(wal_object_prefix)};`,
    `const REQUEST_LOG = ${JSON.stringify(requestLogPath)};`,
    "function hashHex(data) { return createHash('sha256').update(data).digest('hex'); }",
    "function hmac(key, data, encoding) { const hash = createHmac('sha256', key).update(data, 'utf8'); return encoding ? hash.digest(encoding) : hash.digest(); }",
    "function getSignatureKey(secret, dateStamp) { const kDate = hmac(`AWS4${secret}`, dateStamp); const kRegion = hmac(kDate, 'auto'); const kService = hmac(kRegion, 's3'); return hmac(kService, 'aws4_request'); }",
    "function toAmzDate(now) { return now.toISOString().replace(/[:-]|\\.\\d{3}/g, ''); }",
    "function encodeRfc3986(str) { return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }",
    "function canonicalizeObjectPath(bucket, key) { const parts = [bucket, ...`${key ?? ''}`.split('/').filter(Boolean)]; return `/${parts.map(encodeRfc3986).join('/')}`; }",
    "async function main() {",
    "  const [segment, destPath] = process.argv.slice(2);",
    "  if (!segment || !destPath) process.exit(1);",
    "  const key = `${PREFIX}/${segment}`;",
    "  const parsed = new URL(ENDPOINT);",
    "  const canonicalUri = canonicalizeObjectPath(BUCKET, key);",
    "  const now = new Date();",
    "  const amzDate = toAmzDate(now);",
    "  const dateStamp = amzDate.slice(0, 8);",
    "  const payloadSha256 = hashHex('');",
    "  const headers = {",
    "    host: parsed.host,",
    "    'x-amz-content-sha256': payloadSha256,",
    "    'x-amz-date': amzDate,",
    "  };",
    "  const signedHeaderNames = Object.keys(headers).sort();",
    "  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(headers[name]).trim()}\\n`).join('');",
    "  const signedHeaders = signedHeaderNames.join(';');",
    "  const canonicalRequest = ['GET', canonicalUri, '', canonicalHeaders, signedHeaders, payloadSha256].join('\\n');",
    "  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;",
    "  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, hashHex(canonicalRequest)].join('\\n');",
    "  const signingKey = getSignatureKey(SECRET_KEY, dateStamp);",
    "  const signature = hmac(signingKey, stringToSign, 'hex');",
    "  headers.authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;",
    "  const { host: _host, ...requestHeaders } = headers;",
    "  const response = await fetch(`${parsed.origin}${canonicalUri}`, { headers: requestHeaders });",
    "  if (!response.ok || !response.body) {",
    "    if (response.status === 404) process.exit(1);",
    "    throw new Error(`R2 GET failed (${response.status}): ${response.statusText || 'unknown error'}`);",
    "  }",
    "  mkdirSync(dirname(destPath), { recursive: true });",
    "  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));",
    "  appendFileSync(REQUEST_LOG, `${segment}\\n`);",
    "}",
    "main().catch((err) => { console.error(err?.message ?? String(err)); process.exit(1); });",
    "",
  ].join("\n");
  await writeFile(scriptPath, script, { mode: 0o700 });
  return scriptPath;
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
  const rusticRepo = await buildBayRusticRepoConfig({ r2 });
  const current_storage_backend: StorageBackend = rusticRepo
    ? "rustic"
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
    rustic_repo_selector:
      rusticRepo?.repo_selector ?? stored.rustic_repo_selector ?? null,
    last_archived_wal_segment: stored.last_archived_wal_segment ?? null,
    last_uploaded_wal_segment: stored.last_uploaded_wal_segment ?? null,
    latest_remote_snapshot_id: stored.latest_remote_snapshot_id ?? null,
    latest_remote_snapshot_host: stored.latest_remote_snapshot_host ?? null,
    last_restore_test_backup_set_id:
      stored.last_restore_test_backup_set_id ?? null,
    last_restore_test_status: stored.last_restore_test_status ?? null,
    last_restore_tested_at: stored.last_restore_tested_at ?? null,
    last_restore_test_target_dir: stored.last_restore_test_target_dir ?? null,
    last_restore_test_recovery_ready:
      stored.last_restore_test_recovery_ready ?? null,
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
  walMaintenanceTimer.unref?.();
  void run();
}

async function setBayBackupMaintenanceNextRunAt({
  bay_id,
  next_run_at,
}: {
  bay_id: string;
  next_run_at: string | null;
}): Promise<void> {
  await writeUpdatedBayBackupState({
    bay_id,
    update: (state) => ({
      ...state,
      maintenance_next_run_at: next_run_at,
    }),
  });
}

function scheduleBayBackupMaintenance({
  bay_id,
  delay_ms,
}: {
  bay_id: string;
  delay_ms: number | null;
}): void {
  if (backupMaintenanceTimer) {
    clearTimeout(backupMaintenanceTimer);
    backupMaintenanceTimer = undefined;
  }
  const next_run_at =
    delay_ms == null ? null : new Date(Date.now() + delay_ms).toISOString();
  void setBayBackupMaintenanceNextRunAt({ bay_id, next_run_at }).catch(
    (err) => {
      logger.warn("failed to persist bay backup maintenance schedule", {
        bay_id,
        err,
      });
    },
  );
  if (delay_ms == null) {
    return;
  }
  backupMaintenanceTimer = setTimeout(() => {
    void runBayBackupMaintenance({ bay_id });
  }, delay_ms);
  backupMaintenanceTimer.unref?.();
}

async function runBayBackupMaintenance({
  bay_id,
}: {
  bay_id: string;
}): Promise<void> {
  if (backupMaintenanceRunning) {
    return;
  }
  const config = getBayBackupMaintenanceConfig();
  if (!config.enabled) {
    scheduleBayBackupMaintenance({ bay_id, delay_ms: null });
    return;
  }
  backupMaintenanceRunning = true;
  const started_at = new Date().toISOString();
  try {
    await writeUpdatedBayBackupState({
      bay_id,
      update: (state) => ({
        ...state,
        maintenance_last_started_at: started_at,
        maintenance_last_finished_at: null,
        maintenance_last_error_at: null,
        maintenance_last_error: null,
        maintenance_next_run_at: null,
      }),
    });
    await runBayBackup({ bay_id });
    const finished_at = new Date().toISOString();
    await writeUpdatedBayBackupState({
      bay_id,
      update: (state) => ({
        ...state,
        maintenance_last_finished_at: finished_at,
        maintenance_last_success_at: finished_at,
        maintenance_last_error_at: null,
        maintenance_last_error: null,
      }),
    });
    scheduleBayBackupMaintenance({
      bay_id,
      delay_ms: config.full_snapshot_interval_ms,
    });
  } catch (err) {
    const finished_at = new Date().toISOString();
    await writeUpdatedBayBackupState({
      bay_id,
      update: (state) => ({
        ...state,
        maintenance_last_finished_at: finished_at,
        maintenance_last_error_at: finished_at,
        maintenance_last_error: String(err),
      }),
    }).catch((writeErr) => {
      logger.warn("failed to persist bay backup maintenance error", {
        bay_id,
        err: writeErr,
      });
    });
    logger.warn("bay backup maintenance failed", {
      bay_id,
      err,
    });
    scheduleBayBackupMaintenance({
      bay_id,
      delay_ms: config.full_snapshot_retry_interval_ms,
    });
  } finally {
    backupMaintenanceRunning = false;
  }
}

export function startBayBackupMaintenance(): void {
  if (backupMaintenanceTimer) return;
  const config = getBayBackupMaintenanceConfig();
  const bay_id = getSingleBayInfo().bay_id;
  if (!config.enabled) {
    void setBayBackupMaintenanceNextRunAt({
      bay_id,
      next_run_at: null,
    }).catch((err) => {
      logger.warn("failed to persist disabled bay backup scheduler state", {
        bay_id,
        err,
      });
    });
    return;
  }
  void (async () => {
    try {
      const { state } = await loadBayBackupState({ bay_id });
      scheduleBayBackupMaintenance({
        bay_id,
        delay_ms: computeNextBackupMaintenanceDelayMs({
          state,
          config,
        }),
      });
    } catch (err) {
      logger.warn("failed to initialize bay backup maintenance", {
        bay_id,
        err,
      });
      scheduleBayBackupMaintenance({
        bay_id,
        delay_ms: config.full_snapshot_retry_interval_ms,
      });
    }
  })();
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
  const config = getBayBackupMaintenanceConfig();
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
    rustic_repo_selector: state.rustic_repo_selector,
    latest_backup_set_id: state.latest_backup_set_id,
    latest_format: state.latest_format,
    latest_storage_backend: state.latest_storage_backend,
    latest_local_manifest_path: state.latest_local_manifest_path,
    latest_remote_manifest_key: state.latest_remote_manifest_key,
    latest_object_prefix: state.latest_object_prefix,
    latest_remote_snapshot_id: state.latest_remote_snapshot_id,
    latest_remote_snapshot_host: state.latest_remote_snapshot_host,
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
    full_snapshot_scheduler_enabled: config.enabled,
    full_snapshot_interval_ms: config.full_snapshot_interval_ms,
    full_snapshot_retry_interval_ms: config.full_snapshot_retry_interval_ms,
    full_snapshot_retention_count: config.full_snapshot_retention_count,
    restore_workspace_retention_days: config.restore_workspace_retention_days,
    maintenance_running: backupMaintenanceRunning,
    maintenance_next_run_at: state.maintenance_next_run_at,
    maintenance_last_started_at: state.maintenance_last_started_at,
    maintenance_last_finished_at: state.maintenance_last_finished_at,
    maintenance_last_success_at: state.maintenance_last_success_at,
    maintenance_last_error_at: state.maintenance_last_error_at,
    maintenance_last_error: state.maintenance_last_error,
    last_pruned_at: state.last_pruned_at,
    last_pruned_local_archive_count: state.last_pruned_local_archive_count,
    last_pruned_restore_count: state.last_pruned_restore_count,
  };
}

function mapRestoreReadiness({
  state,
}: {
  state: StoredBayBackupState;
}): BayRestoreReadinessStatus {
  const latest_backup_set_id = state.latest_backup_set_id ?? null;
  const latest_backup_format = state.latest_format ?? null;
  const last_restore_test_backup_set_id =
    state.last_restore_test_backup_set_id ?? null;
  const last_restore_test_status = state.last_restore_test_status ?? null;
  const last_restore_tested_at = state.last_restore_tested_at ?? null;
  const last_restore_test_target_dir =
    state.last_restore_test_target_dir ?? null;
  const last_restore_test_recovery_ready =
    state.last_restore_test_recovery_ready ?? null;
  const last_pitr_test_backup_set_id =
    state.last_pitr_test_backup_set_id ?? null;
  const last_pitr_test_status = state.last_pitr_test_status ?? null;
  const last_pitr_tested_at = state.last_pitr_tested_at ?? null;
  const last_pitr_test_target_time = state.last_pitr_test_target_time ?? null;
  const last_pitr_test_target_dir = state.last_pitr_test_target_dir ?? null;
  const last_pitr_test_remote_only = state.last_pitr_test_remote_only ?? null;

  let latest_backup_restore_test_status:
    | "no-backup"
    | "not-run"
    | "stale"
    | "passed"
    | "failed";
  let latest_backup_pitr_test_status:
    | "no-backup"
    | "not-recovery-ready"
    | "not-run"
    | "stale"
    | "passed"
    | "failed";
  let summary: string;

  if (!latest_backup_set_id) {
    latest_backup_restore_test_status = "no-backup";
    latest_backup_pitr_test_status = "no-backup";
    summary = "No bay backup exists yet.";
  } else if (!last_restore_test_backup_set_id || !last_restore_test_status) {
    latest_backup_restore_test_status = "not-run";
  } else if (last_restore_test_backup_set_id !== latest_backup_set_id) {
    latest_backup_restore_test_status = "stale";
  } else {
    latest_backup_restore_test_status = last_restore_test_status;
  }

  if (!latest_backup_set_id) {
    latest_backup_pitr_test_status = "no-backup";
    summary = "No bay backup exists yet.";
  } else if (latest_backup_format !== "pg_basebackup") {
    latest_backup_pitr_test_status = "not-recovery-ready";
    summary = `Latest backup ${latest_backup_set_id} is not recovery-ready, so PITR validation is unavailable.`;
  } else if (!last_pitr_test_backup_set_id || !last_pitr_test_status) {
    latest_backup_pitr_test_status = "not-run";
    summary = `Latest backup ${latest_backup_set_id} has not been PITR-tested.`;
  } else if (last_pitr_test_backup_set_id !== latest_backup_set_id) {
    latest_backup_pitr_test_status = "stale";
    const prior = last_pitr_test_status === "passed" ? "passed" : "failed";
    summary = `Latest backup ${latest_backup_set_id} has not been PITR-tested. Last PITR-tested backup ${last_pitr_test_backup_set_id} ${prior} at ${last_pitr_tested_at ?? "unknown time"}.`;
  } else {
    latest_backup_pitr_test_status = last_pitr_test_status;
    const mode = last_pitr_test_remote_only ? "remote-only " : "";
    summary =
      last_pitr_test_status === "passed"
        ? `Latest backup ${latest_backup_set_id} passed a ${mode}PITR restore test at ${last_pitr_tested_at ?? "unknown time"}.`
        : `Latest backup ${latest_backup_set_id} failed its last ${mode}PITR restore test at ${last_pitr_tested_at ?? "unknown time"}.`;
  }

  if (
    latest_backup_pitr_test_status === "not-run" &&
    latest_backup_restore_test_status === "stale" &&
    last_restore_test_backup_set_id
  ) {
    const prior = last_restore_test_status === "passed" ? "passed" : "failed";
    summary = `Latest backup ${latest_backup_set_id} has not been PITR-tested. Last restore-tested backup ${last_restore_test_backup_set_id} ${prior} at ${last_restore_tested_at ?? "unknown time"}.`;
  } else if (
    latest_backup_pitr_test_status === "not-run" &&
    latest_backup_restore_test_status === "passed"
  ) {
    summary = `Latest backup ${latest_backup_set_id} passed a plain restore test at ${last_restore_tested_at ?? "unknown time"}, but has not been PITR-tested yet.`;
  } else if (
    latest_backup_pitr_test_status === "not-run" &&
    latest_backup_restore_test_status === "failed"
  ) {
    summary = `Latest backup ${latest_backup_set_id} failed its last plain restore test at ${last_restore_tested_at ?? "unknown time"} and has not been PITR-tested yet.`;
  } else if (last_restore_test_backup_set_id !== latest_backup_set_id) {
    const prior = last_restore_test_status === "passed" ? "passed" : "failed";
    summary = `Latest backup ${latest_backup_set_id} has not been restore-tested. Last tested backup ${last_restore_test_backup_set_id} ${prior} at ${last_restore_tested_at ?? "unknown time"}.`;
  }

  return {
    latest_backup_set_id,
    latest_backup_format,
    latest_backup_restore_test_status,
    latest_backup_restore_tested:
      latest_backup_restore_test_status === "passed",
    latest_backup_restore_tested_at:
      latest_backup_restore_test_status === "passed" ||
      latest_backup_restore_test_status === "failed"
        ? last_restore_tested_at
        : null,
    latest_backup_pitr_test_status,
    latest_backup_pitr_tested: latest_backup_pitr_test_status === "passed",
    latest_backup_pitr_tested_at:
      latest_backup_pitr_test_status === "passed" ||
      latest_backup_pitr_test_status === "failed"
        ? last_pitr_tested_at
        : null,
    gold_star: latest_backup_pitr_test_status === "passed",
    last_restore_test_backup_set_id,
    last_restore_test_status,
    last_restore_tested_at,
    last_restore_test_target_dir,
    last_restore_test_recovery_ready,
    last_pitr_test_backup_set_id,
    last_pitr_test_status,
    last_pitr_tested_at,
    last_pitr_test_target_time,
    last_pitr_test_target_dir,
    last_pitr_test_remote_only,
    summary,
  };
}

export async function getBayBackupStatus({
  bay_id,
}: {
  bay_id?: string;
} = {}): Promise<{
  postgres: BayBackupsPostgresStatus;
  bay_backup: BayBackupStatus;
  restore_readiness: BayRestoreReadinessStatus;
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
  const rusticRepo = await buildBayRusticRepoConfig({ r2 });
  const current_storage_backend: StorageBackend = rusticRepo
    ? "rustic"
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
    rustic_repo_selector:
      rusticRepo?.repo_selector ?? stored.rustic_repo_selector ?? null,
    last_archived_wal_segment: stored.last_archived_wal_segment ?? null,
    last_uploaded_wal_segment: stored.last_uploaded_wal_segment ?? null,
    latest_remote_snapshot_id: stored.latest_remote_snapshot_id ?? null,
    latest_remote_snapshot_host: stored.latest_remote_snapshot_host ?? null,
    last_restore_test_backup_set_id:
      stored.last_restore_test_backup_set_id ?? null,
    last_restore_test_status: stored.last_restore_test_status ?? null,
    last_restore_tested_at: stored.last_restore_tested_at ?? null,
    last_restore_test_target_dir: stored.last_restore_test_target_dir ?? null,
    last_restore_test_recovery_ready:
      stored.last_restore_test_recovery_ready ?? null,
  };
  const wal = await getWalArchiveSnapshot({ paths, state });
  return {
    postgres,
    bay_backup: mapStateToStatus({
      paths,
      state,
      wal,
    }),
    restore_readiness: mapRestoreReadiness({ state }),
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
    const rusticRepo = await buildBayRusticRepoConfig({ r2 });
    const rusticRepoProfilePath = rusticRepo
      ? await ensureBayRusticRepoProfile(rusticRepo)
      : null;
    const current_storage_backend: StorageBackend = rusticRepo
      ? "rustic"
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
      rustic_repo_selector:
        rusticRepo?.repo_selector ?? previous.rustic_repo_selector ?? null,
      last_started_at: started_at,
      last_finished_at: null,
      last_error_at: null,
      last_error: null,
      latest_remote_snapshot_id: previous.latest_remote_snapshot_id ?? null,
      latest_remote_snapshot_host: previous.latest_remote_snapshot_host ?? null,
      last_restore_test_backup_set_id:
        previous.last_restore_test_backup_set_id ?? null,
      last_restore_test_status: previous.last_restore_test_status ?? null,
      last_restore_tested_at: previous.last_restore_tested_at ?? null,
      last_restore_test_target_dir:
        previous.last_restore_test_target_dir ?? null,
      last_restore_test_recovery_ready:
        previous.last_restore_test_recovery_ready ?? null,
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
      await stageControlPlaneArtifacts({
        stagingDir: staging_dir,
      });
      archive_dir = join(paths.archives_dir, backup_set_id);
      await rename(staging_dir, archive_dir);
      await writeOfflineRestoreHelper({
        archiveDir: archive_dir,
        backup_set_id,
      });
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
      let latest_remote_snapshot_id: string | null = null;
      let latest_remote_snapshot_host: string | null = null;
      const snapshotManifest: StoredBayBackupManifest = {
        bay_id: resolvedBayId,
        bay_label: currentBay.label,
        backup_set_id,
        created_at: started_at,
        finished_at: started_at,
        format: actual_strategy,
        current_storage_backend,
        latest_storage_backend: rusticRepoProfilePath ? "rustic" : "local",
        bucket_name: r2.bucket_name ?? null,
        bucket_region: r2.bucket_region ?? null,
        bucket_endpoint: r2.bucket_endpoint ?? null,
        object_prefix: null,
        remote_manifest_key: null,
        remote_snapshot_id: null,
        remote_snapshot_host: resolvedBayId,
        rustic_repo_selector: rusticRepo?.repo_selector ?? null,
        postgres,
        artifacts,
      };
      await writeJson(join(archive_dir, "manifest.json"), snapshotManifest);
      if (rusticRepoProfilePath) {
        try {
          const remoteSnapshot = await backupToBayRusticRepo({
            repoProfilePath: rusticRepoProfilePath,
            snapshotHost: resolvedBayId,
            backup_set_id,
            format: actual_strategy,
            sourceDir: archive_dir,
          });
          latest_storage_backend = "rustic";
          latest_remote_snapshot_id = remoteSnapshot.id;
          latest_remote_snapshot_host =
            remoteSnapshot.hostname ?? resolvedBayId;
        } catch (err) {
          logger.warn(
            "bay backup rustic upload failed; local backup retained",
            {
              bay_id: resolvedBayId,
              backup_set_id,
              err,
            },
          );
          initialState.last_error_at = new Date().toISOString();
          initialState.last_error = `remote rustic upload failed: ${String(err)}`;
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
        remote_snapshot_id: latest_remote_snapshot_id,
        remote_snapshot_host: latest_remote_snapshot_host,
        rustic_repo_selector: rusticRepo?.repo_selector ?? null,
        postgres,
        artifacts,
      };
      await writeJson(local_manifest_path, manifest);
      let state: StoredBayBackupState = {
        ...initialState,
        latest_backup_set_id: backup_set_id,
        latest_format: actual_strategy,
        latest_storage_backend,
        latest_local_manifest_path: local_manifest_path,
        latest_remote_manifest_key,
        latest_object_prefix,
        latest_remote_snapshot_id,
        latest_remote_snapshot_host,
        latest_artifact_count: artifacts.length,
        latest_artifact_bytes: artifact_bytes,
        last_finished_at: finished_at,
        last_successful_backup_at: finished_at,
        last_successful_remote_backup_at:
          latest_storage_backend === "rustic"
            ? finished_at
            : previous.last_successful_remote_backup_at,
        restore_state:
          latest_storage_backend === "rustic" ? "ready" : "ready-local-only",
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
      try {
        state = await applyBayBackupRetention({
          bay_id: resolvedBayId,
          paths,
          state,
          rusticRepoProfilePath,
        });
        await writeJson(paths.state_file, state);
      } catch (err) {
        logger.warn("bay backup retention maintenance failed", {
          bay_id: resolvedBayId,
          backup_set_id,
          err,
        });
      }
      if (backupMaintenanceTimer && !backupMaintenanceRunning) {
        const config = getBayBackupMaintenanceConfig();
        if (config.enabled) {
          scheduleBayBackupMaintenance({
            bay_id: resolvedBayId,
            delay_ms: config.full_snapshot_interval_ms,
          });
        }
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
        remote_snapshot_id: latest_remote_snapshot_id,
        remote_snapshot_host: latest_remote_snapshot_host,
        rustic_repo_selector: rusticRepo?.repo_selector ?? null,
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
  remote_only = false,
  target_time,
}: {
  bay_id?: string;
  backup_set_id?: string;
  target_dir?: string;
  dry_run?: boolean;
  remote_only?: boolean;
  target_time?: string;
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
  const rusticRepo = await buildBayRusticRepoConfig({ r2 });
  const rusticRepoProfilePath = rusticRepo
    ? await ensureBayRusticRepoProfile(rusticRepo)
    : null;
  const current_storage_backend: StorageBackend = rusticRepo
    ? "rustic"
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
    rustic_repo_selector:
      rusticRepo?.repo_selector ?? stored.rustic_repo_selector ?? null,
    last_archived_wal_segment: stored.last_archived_wal_segment ?? null,
    last_uploaded_wal_segment: stored.last_uploaded_wal_segment ?? null,
    latest_remote_snapshot_id: stored.latest_remote_snapshot_id ?? null,
    latest_remote_snapshot_host: stored.latest_remote_snapshot_host ?? null,
    last_restore_test_backup_set_id:
      stored.last_restore_test_backup_set_id ?? null,
    last_restore_test_status: stored.last_restore_test_status ?? null,
    last_restore_tested_at: stored.last_restore_tested_at ?? null,
    last_restore_test_target_dir: stored.last_restore_test_target_dir ?? null,
    last_restore_test_recovery_ready:
      stored.last_restore_test_recovery_ready ?? null,
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
  const resolvedTargetTime = normalizeRecoveryTargetTime(target_time);
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
      rusticRepoProfilePath,
      download_dir: tempDownloadDir,
      prefer_local: !remote_only,
    });
    if (
      resolvedTargetTime != null &&
      manifestInfo.manifest.format !== "pg_basebackup"
    ) {
      throw new Error(
        "target_time is only supported for pg_basebackup backups with archived WAL",
      );
    }
    const wal = await getWalArchiveSnapshot({ paths, state });
    let source_storage_backend: StorageBackend =
      manifestInfo.source_storage_backend;
    const resolvedWalObjectPrefix =
      remote_only && manifestInfo.manifest.format === "pg_basebackup"
        ? walObjectPrefix(
            r2.object_prefix_root ?? state.object_prefix_root ?? null,
          )
        : null;
    if (
      remote_only &&
      manifestInfo.manifest.format === "pg_basebackup" &&
      !resolvedWalObjectPrefix
    ) {
      throw new Error("missing WAL object prefix for remote-only restore");
    }
    const remoteWalKeys =
      resolvedWalObjectPrefix == null
        ? null
        : await listRemoteWalObjectKeys({
            r2,
            wal_object_prefix: resolvedWalObjectPrefix,
          });
    let wal_storage_backend: "local" | "r2" | null =
      manifestInfo.manifest.format === "pg_basebackup"
        ? remote_only
          ? "r2"
          : "local"
        : null;
    let wal_segment_count =
      remoteWalKeys != null ? remoteWalKeys.length : wal.archived_wal_count;
    const source_snapshot_id =
      manifestInfo.remote_snapshot_id ??
      manifestInfo.manifest.remote_snapshot_id ??
      null;
    let data_dir: string | null =
      manifestInfo.manifest.format === "pg_basebackup"
        ? join(resolvedTargetDir, "data")
        : null;
    const sync_dir = join(resolvedTargetDir, "sync");
    const secrets_dir = join(resolvedTargetDir, "secrets");
    const restore_manifest_path = dry_run
      ? null
      : join(resolvedTargetDir, "restore-manifest.json");
    const syncArtifact = findArtifactByName(
      manifestInfo.manifest.artifacts,
      "sync.tar.gz",
    );
    const secretsArtifact = findArtifactByName(
      manifestInfo.manifest.artifacts,
      "secrets.tar.gz",
    );
    let backup_manifest_path = manifestInfo.backup_manifest_path ?? null;
    if (dry_run) {
      notes.push("Dry run only; no restore files were written.");
      if (manifestInfo.manifest.format === "pg_basebackup") {
        notes.push(
          `Would stage a recoverable Postgres data directory at ${data_dir}.`,
        );
        if (resolvedTargetTime) {
          notes.push(
            `Would recover only through ${resolvedTargetTime} before promoting the restored cluster.`,
          );
        }
        notes.push(
          remote_only
            ? "Recovery would fetch archived WAL from R2 on demand."
            : `Recovery would read archived WAL from ${paths.wal_archive_dir}.`,
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
      } else if (manifestInfo.source_storage_backend === "rustic") {
        notes.push(
          "The backup manifest is not present locally; restore would read metadata from the rustic snapshot repo.",
        );
      }
      if (remote_only) {
        notes.push(
          "Remote-only mode ignores the local snapshot and WAL cache.",
        );
      }
      if (syncArtifact) {
        notes.push(`Would stage the Conat sync snapshot at ${sync_dir}.`);
      } else {
        notes.push("This backup does not include a Conat sync snapshot.");
      }
      if (secretsArtifact) {
        notes.push(`Would stage the bay secrets snapshot at ${secrets_dir}.`);
      } else {
        notes.push("This backup does not include a secrets snapshot.");
      }
      return {
        ...currentBay,
        started_at,
        finished_at: new Date().toISOString(),
        dry_run,
        target_time: resolvedTargetTime,
        backup_set_id: resolvedBackupSetId,
        format: manifestInfo.manifest.format,
        target_dir: resolvedTargetDir,
        data_dir,
        sync_dir: syncArtifact ? sync_dir : null,
        secrets_dir: secretsArtifact ? secrets_dir : null,
        backup_manifest_path:
          manifestInfo.source_storage_backend === "local"
            ? backup_manifest_path
            : null,
        restore_manifest_path,
        source_storage_backend,
        source_snapshot_id,
        rustic_repo_selector:
          source_storage_backend === "rustic"
            ? (rusticRepo?.repo_selector ?? null)
            : null,
        wal_archive_dir:
          manifestInfo.manifest.format === "pg_basebackup"
            ? remote_only
              ? null
              : paths.wal_archive_dir
            : null,
        wal_storage_backend,
        remote_only,
        artifact_count: manifestInfo.manifest.artifacts.length,
        wal_segment_count,
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
        remote_snapshot_id: source_snapshot_id,
        rusticRepoProfilePath,
        download_dir: tempDownloadDir,
        prefer_local: !remote_only,
      });
      source_storage_backend = baseArtifactPath.source_storage_backend;
      await ensureDir(data_dir!, 0o700);
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
          remote_snapshot_id: source_snapshot_id,
          rusticRepoProfilePath,
          download_dir: tempDownloadDir,
          prefer_local: !remote_only,
        });
        if (walArtifactPath.source_storage_backend !== "local") {
          source_storage_backend = walArtifactPath.source_storage_backend;
        }
        await extractTarGz({
          archivePath: walArtifactPath.path,
          targetDir: join(data_dir!, "pg_wal"),
        });
      }
      // pg_basebackup snapshots can contain an in-progress WAL segment in
      // pg_wal/. After the backup finishes, the archived copy of that same
      // segment may contain more records than the bundled snapshot copy.
      // Refresh any bundled segment file from the authoritative archive when
      // that archive copy already exists.
      await refreshBundledWalSegmentsFromArchive({
        pgWalDir: join(data_dir!, "pg_wal"),
        remote_only,
        paths,
        r2,
        wal_object_prefix: resolvedWalObjectPrefix,
        remote_wal_keys: remoteWalKeys,
      });
      await rm(join(data_dir!, "postmaster.pid"), {
        force: true,
      }).catch(() => undefined);
      await rm(join(data_dir!, "postmaster.opts"), {
        force: true,
      }).catch(() => undefined);

      const restoreScriptPath = remote_only
        ? await writeRemoteWalRestoreHelper({
            targetDir: resolvedTargetDir,
            r2,
            wal_object_prefix: resolvedWalObjectPrefix!,
          })
        : join(resolvedTargetDir, "restore-wal.sh");
      if (!remote_only) {
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
      }
      const autoConfPath = join(data_dir!, "postgresql.auto.conf");
      const autoConfExisting = (await exists(autoConfPath))
        ? await readFile(autoConfPath, "utf8")
        : "";
      const restoreCommand = remote_only
        ? `${process.execPath} ${restoreScriptPath} %f %p`
        : `${restoreScriptPath} %f %p`;
      const postgresRecoveryTargetTime = resolvedTargetTime
        ? formatRecoveryTargetTimeForPostgres(resolvedTargetTime)
        : null;
      const recoveryConfig = [
        "",
        "# cocalc bay restore",
        `restore_command = ${postgresQuote(restoreCommand)}`,
        "archive_mode = 'off'",
        `archive_command = ${postgresQuote("/bin/false")}`,
        ...(postgresRecoveryTargetTime
          ? [
              `recovery_target_time = ${postgresQuote(postgresRecoveryTargetTime)}`,
              "recovery_target_inclusive = 'true'",
            ]
          : []),
        // Stay on the base backup timeline. Fenced restore-tests must not hop
        // onto a later timeline created by a previous promoted test restore.
        "recovery_target_timeline = 'current'",
        "recovery_target_action = 'promote'",
        "",
      ].join("\n");
      await writeFile(
        autoConfPath,
        `${autoConfExisting}${recoveryConfig}`,
        "utf8",
      );
      const recoverySignalPath = join(
        data_dir!,
        resolvedTargetTime ? "standby.signal" : "restore.signal",
      );
      const obsoleteSignalPath = join(
        data_dir!,
        resolvedTargetTime ? "restore.signal" : "standby.signal",
      );
      await rm(obsoleteSignalPath, { force: true }).catch(() => undefined);
      await writeFile(recoverySignalPath, "", "utf8");
      notes.push(`Restored base backup into ${data_dir}.`);
      if (resolvedTargetTime) {
        notes.push(
          `Recovery target time is set to ${resolvedTargetTime} before promotion.`,
        );
        notes.push(
          "Targeted recovery uses standby mode so PostgreSQL keeps fetching archived WAL until the requested target is reached.",
        );
      }
      notes.push(
        `Start the fenced restore with: postgres -D ${shellQuote(data_dir!)}`,
      );
      notes.push(
        remote_only
          ? `Archive recovery will fetch WAL segments from R2 via ${restoreScriptPath}.`
          : `Archive recovery will read WAL segments from ${paths.wal_archive_dir}.`,
      );
      if (remote_only) {
        notes.push("Remote-only mode ignores the local WAL archive.");
      }
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
        remote_snapshot_id: source_snapshot_id,
        rusticRepoProfilePath,
        download_dir: tempDownloadDir,
        prefer_local: !remote_only,
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

    if (syncArtifact) {
      const syncArtifactPath = await resolveArtifactPath({
        artifact: syncArtifact,
        r2,
        remote_snapshot_id: source_snapshot_id,
        rusticRepoProfilePath,
        download_dir: tempDownloadDir,
        prefer_local: !remote_only,
      });
      if (syncArtifactPath.source_storage_backend !== "local") {
        source_storage_backend = syncArtifactPath.source_storage_backend;
      }
      await extractTarGz({
        archivePath: syncArtifactPath.path,
        targetDir: resolvedTargetDir,
      });
      notes.push(`Restored the Conat sync snapshot into ${sync_dir}.`);
    } else {
      notes.push("This backup does not include a Conat sync snapshot.");
    }

    if (secretsArtifact) {
      const secretsArtifactPath = await resolveArtifactPath({
        artifact: secretsArtifact,
        r2,
        remote_snapshot_id: source_snapshot_id,
        rusticRepoProfilePath,
        download_dir: tempDownloadDir,
        prefer_local: !remote_only,
      });
      if (secretsArtifactPath.source_storage_backend !== "local") {
        source_storage_backend = secretsArtifactPath.source_storage_backend;
      }
      await extractTarGz({
        archivePath: secretsArtifactPath.path,
        targetDir: resolvedTargetDir,
      });
      notes.push(`Restored the bay secrets snapshot into ${secrets_dir}.`);
    } else {
      notes.push("This backup does not include a secrets snapshot.");
    }

    const finished_at = new Date().toISOString();
    await writeJson(restore_manifest_path!, {
      bay_id: resolvedBayId,
      backup_set_id: resolvedBackupSetId,
      format: manifestInfo.manifest.format,
      started_at,
      finished_at,
      target_time: resolvedTargetTime,
      target_dir: resolvedTargetDir,
      data_dir,
      sync_dir: syncArtifact ? sync_dir : null,
      secrets_dir: secretsArtifact ? secrets_dir : null,
      backup_manifest_path,
      source_storage_backend,
      source_snapshot_id,
      rustic_repo_selector:
        source_storage_backend === "rustic"
          ? (rusticRepo?.repo_selector ?? null)
          : null,
      wal_archive_dir:
        manifestInfo.manifest.format === "pg_basebackup"
          ? remote_only
            ? null
            : paths.wal_archive_dir
          : null,
      wal_storage_backend,
      remote_only,
      wal_segment_count,
      recovery_ready: manifestInfo.manifest.format === "pg_basebackup",
      notes,
    });
    return {
      ...currentBay,
      started_at,
      finished_at,
      dry_run,
      target_time: resolvedTargetTime,
      backup_set_id: resolvedBackupSetId,
      format: manifestInfo.manifest.format,
      target_dir: resolvedTargetDir,
      data_dir,
      sync_dir: syncArtifact ? sync_dir : null,
      secrets_dir: secretsArtifact ? secrets_dir : null,
      backup_manifest_path,
      restore_manifest_path,
      source_storage_backend,
      source_snapshot_id,
      rustic_repo_selector:
        source_storage_backend === "rustic"
          ? (rusticRepo?.repo_selector ?? null)
          : null,
      wal_archive_dir:
        manifestInfo.manifest.format === "pg_basebackup"
          ? remote_only
            ? null
            : paths.wal_archive_dir
          : null,
      wal_storage_backend,
      remote_only,
      artifact_count: manifestInfo.manifest.artifacts.length,
      wal_segment_count,
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

function restoreTestTargetDir({
  paths,
  backup_set_id,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  backup_set_id: string;
}): string {
  return `${defaultRestoreTargetDir({ paths, backup_set_id })}-test`;
}

async function restoreTestPort(): Promise<number> {
  return await getPort();
}

function buildRestoreTestCliEnv({
  socketDir,
  port,
}: {
  socketDir: string;
  port: number;
}): NodeJS.ProcessEnv {
  return {
    ...buildPostgresCliEnv(),
    PGHOST: socketDir,
    PGPORT: `${port}`,
    PGUSER: pguser,
    PGDATABASE: pgdatabase,
  };
}

async function resolveRestoreTestBinary(binary: string): Promise<string> {
  const path = await which(binary);
  if (!path) {
    throw new Error(`required binary '${binary}' was not found in PATH`);
  }
  return path;
}

async function preparePitrRestoreSentinel({
  bay_id,
  backup_set_id,
  remote_only,
}: {
  bay_id: string;
  backup_set_id: string;
  remote_only: boolean;
}): Promise<PitrRestoreSentinel> {
  const run_id = randomUUID();
  const note = `${bay_id}:${backup_set_id}:${remote_only ? "remote-only" : "local"}`;
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS ${RESTORE_TEST_PITR_TABLE} (
      run_id uuid NOT NULL,
      phase text NOT NULL,
      note text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`,
  );
  await getPool().query(
    `DELETE FROM ${RESTORE_TEST_PITR_TABLE} WHERE created_at < clock_timestamp() - interval '30 days'`,
  );
  await getPool().query(
    `INSERT INTO ${RESTORE_TEST_PITR_TABLE} (run_id, phase, note) VALUES ($1, 'pre', $2)`,
    [run_id, note],
  );
  const { rows } = await getPool().query<{ target_time: string | Date }>(
    "SELECT clock_timestamp() AS target_time",
  );
  const rawTargetTime = rows[0]?.target_time;
  const target_time = normalizeRecoveryTargetTime(
    rawTargetTime instanceof Date
      ? rawTargetTime.toISOString()
      : `${rawTargetTime ?? ""}`,
  );
  if (!target_time) {
    throw new Error("failed to record PITR target_time");
  }
  await getPool().query("SELECT pg_sleep(0.25)");
  await getPool().query(
    `INSERT INTO ${RESTORE_TEST_PITR_TABLE} (run_id, phase, note) VALUES ($1, 'post', $2)`,
    [run_id, note],
  );
  const walSync = await syncBayWalArchive({
    bay_id,
    forceSwitch: true,
  });
  if (`${walSync.state.last_error ?? ""}`.startsWith("wal archive:")) {
    throw new Error(
      `failed to archive PITR validation WAL: ${walSync.state.last_error}`,
    );
  }
  return { run_id, target_time };
}

async function recordRestoreTestState({
  paths,
  state,
  backup_set_id,
  status,
  tested_at,
  target_dir,
  recovery_ready,
  pitr_target_time,
  remote_only,
}: {
  paths: ReturnType<typeof getBayBackupPaths>;
  state: StoredBayBackupState;
  backup_set_id: string;
  status: "passed" | "failed";
  tested_at: string;
  target_dir: string | null;
  recovery_ready: boolean;
  pitr_target_time: string | null;
  remote_only: boolean;
}): Promise<StoredBayBackupState> {
  const currentState =
    (await readJsonIfExists<StoredBayBackupState>(paths.state_file)) ?? state;
  const nextState: StoredBayBackupState = {
    ...currentState,
    last_restore_test_backup_set_id: backup_set_id,
    last_restore_test_status: status,
    last_restore_tested_at: tested_at,
    last_restore_test_target_dir: target_dir,
    last_restore_test_recovery_ready: recovery_ready,
    last_pitr_test_backup_set_id: backup_set_id,
    last_pitr_test_status: status,
    last_pitr_tested_at: tested_at,
    last_pitr_test_target_time: pitr_target_time,
    last_pitr_test_target_dir: target_dir,
    last_pitr_test_remote_only: remote_only,
  };
  await writeJson(paths.state_file, nextState);
  return nextState;
}

async function runRestoreTestSql({
  psql,
  socketDir,
  port,
  env,
  sql,
}: {
  psql: string;
  socketDir: string;
  port: number;
  env: NodeJS.ProcessEnv;
  sql: string;
}): Promise<string> {
  const { stdout } = await execFile(
    psql,
    [
      "-h",
      socketDir,
      "-p",
      `${port}`,
      "-U",
      pguser,
      "-d",
      pgdatabase,
      "-tAc",
      sql,
    ],
    {
      env,
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return `${stdout ?? ""}`.trim();
}

async function waitForRestorePitrSentinel({
  psql,
  socketDir,
  port,
  env,
  run_id,
  target_time,
}: {
  psql: string;
  socketDir: string;
  port: number;
  env: NodeJS.ProcessEnv;
  run_id: string;
  target_time: string;
}): Promise<{ preCount: string; postCount: string }> {
  const deadline = Date.now() + 60_000;
  let lastState = "unavailable";
  while (Date.now() < deadline) {
    try {
      const counts = await runRestoreTestSql({
        psql,
        socketDir,
        port,
        env,
        sql: `SELECT count(*) FILTER (WHERE phase='pre')::text || ',' || count(*) FILTER (WHERE phase='post')::text FROM ${RESTORE_TEST_PITR_TABLE} WHERE run_id = ${postgresQuote(run_id)}`,
      });
      const [preCount = "", postCount = ""] = counts.split(",");
      lastState = `pre=${preCount}, post=${postCount}`;
      if (preCount === "1" && postCount === "0") {
        return { preCount, postCount };
      }
      if (preCount === "1" && postCount === "1") {
        throw new Error(
          `restore test PITR check failed: expected pre=1 and post=0, got ${lastState}`,
        );
      }
    } catch (err) {
      lastState = String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `restore test timed out waiting for PITR sentinel state at ${target_time} (${lastState})`,
  );
}

export async function runBayRestoreTest({
  bay_id,
  backup_set_id,
  target_dir,
  keep = false,
  remote_only = false,
}: {
  bay_id?: string;
  backup_set_id?: string;
  target_dir?: string;
  keep?: boolean;
  remote_only?: boolean;
} = {}): Promise<BayRestoreTestRunResult> {
  const currentBay = getSingleBayInfo();
  const resolvedBayId =
    `${bay_id ?? currentBay.bay_id}`.trim() || currentBay.bay_id;
  if (resolvedBayId !== currentBay.bay_id) {
    throw new Error(`bay '${resolvedBayId}' not found`);
  }
  const started_at = new Date().toISOString();
  const paths = getBayBackupPaths(resolvedBayId);
  const r2 = await resolveR2Target(resolvedBayId);
  const rusticRepo = await buildBayRusticRepoConfig({ r2 });
  const current_storage_backend: StorageBackend = rusticRepo
    ? "rustic"
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
    rustic_repo_selector:
      rusticRepo?.repo_selector ?? stored.rustic_repo_selector ?? null,
    last_archived_wal_segment: stored.last_archived_wal_segment ?? null,
    last_uploaded_wal_segment: stored.last_uploaded_wal_segment ?? null,
    latest_remote_snapshot_id: stored.latest_remote_snapshot_id ?? null,
    latest_remote_snapshot_host: stored.latest_remote_snapshot_host ?? null,
    last_restore_test_backup_set_id:
      stored.last_restore_test_backup_set_id ?? null,
    last_restore_test_status: stored.last_restore_test_status ?? null,
    last_restore_tested_at: stored.last_restore_tested_at ?? null,
    last_restore_test_target_dir: stored.last_restore_test_target_dir ?? null,
    last_restore_test_recovery_ready:
      stored.last_restore_test_recovery_ready ?? null,
  };
  const resolvedBackupSetId =
    `${backup_set_id ?? state.latest_backup_set_id ?? ""}`.trim() || undefined;
  if (!resolvedBackupSetId) {
    throw new Error("no bay backup is available to restore-test");
  }
  const resolvedTargetDir =
    target_dir?.trim() ||
    restoreTestTargetDir({
      paths,
      backup_set_id: resolvedBackupSetId,
    });
  const restorePlan = await runBayRestore({
    bay_id: resolvedBayId,
    backup_set_id: resolvedBackupSetId,
    target_dir: resolvedTargetDir,
    dry_run: true,
    remote_only,
  });
  if (!restorePlan.recovery_ready || !restorePlan.data_dir) {
    throw new Error(
      "latest backup is not recovery-ready; restore-test currently requires a pg_basebackup snapshot",
    );
  }
  let restoreResult: BayRestoreRunResult | null = null;
  let kept_on_disk = keep === true;
  const verified_queries: string[] = [];
  let socketDir: string | null = null;
  let pitrRun: PitrRestoreSentinel | null = null;
  try {
    pitrRun = await preparePitrRestoreSentinel({
      bay_id: resolvedBayId,
      backup_set_id: resolvedBackupSetId,
      remote_only,
    });
    restoreResult = await runBayRestore({
      bay_id: resolvedBayId,
      backup_set_id: resolvedBackupSetId,
      target_dir: resolvedTargetDir,
      dry_run: false,
      remote_only,
      target_time: pitrRun.target_time,
    });
    if (!restoreResult.data_dir) {
      throw new Error("restore-test requires a restored data directory");
    }
    const restoreDataDir = restoreResult.data_dir;

    const [pgCtl, psql] = await Promise.all([
      resolveRestoreTestBinary("pg_ctl"),
      resolveRestoreTestBinary("psql"),
    ]);
    socketDir = await mkdtemp(join(tmpdir(), "cocalc-bay-restore-test-sock-"));
    const logPath = join(resolvedTargetDir, "postgres-restore-test.log");
    const port = await restoreTestPort();
    const env = buildRestoreTestCliEnv({ socketDir, port });
    const pgCtlOptions = `-k ${socketDir} -p ${port} -c listen_addresses=`;
    let started = false;
    await chmod(socketDir, 0o700).catch(() => undefined);
    try {
      await execFile(
        pgCtl,
        [
          "-D",
          restoreDataDir,
          "-l",
          logPath,
          "-o",
          pgCtlOptions,
          "-w",
          "start",
        ],
        {
          env,
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      started = true;
      const { preCount, postCount } = await waitForRestorePitrSentinel({
        psql,
        socketDir,
        port,
        env,
        run_id: pitrRun.run_id,
        target_time: pitrRun.target_time,
      });
      verified_queries.push("pitr_recovery_promoted=true");
      verified_queries.push(`pitr_pre_count=${preCount}`);
      verified_queries.push(`pitr_post_count=${postCount}`);
      for (const check of RESTORE_TEST_QUERIES) {
        const value = await runRestoreTestSql({
          psql,
          socketDir,
          port,
          env,
          sql: check.sql,
        });
        if (value !== check.expected) {
          throw new Error(
            `restore test check '${check.label}' failed: expected '${check.expected}', got '${value}'`,
          );
        }
        verified_queries.push(`${check.label}=${value}`);
      }
      if (!pitrRun) {
        throw new Error("missing PITR sentinel context");
      }
    } finally {
      if (started) {
        await execFile(
          pgCtl,
          ["-D", restoreDataDir, "-m", "fast", "-w", "stop"],
          {
            env,
            timeout: 60_000,
            maxBuffer: 10 * 1024 * 1024,
          },
        ).catch((err) => {
          logger.warn("failed to stop fenced restore-test postgres", {
            bay_id: resolvedBayId,
            backup_set_id: resolvedBackupSetId,
            err,
          });
        });
      }
    }
    if (!pitrRun) {
      throw new Error("missing PITR sentinel context");
    }
    const pitr = pitrRun;

    const notes = [
      ...restoreResult.notes,
      `Recorded PITR sentinel run ${pitr.run_id} at ${pitr.target_time} before restoring.`,
      "Verified PITR recovery stopped after the pre-target transaction and before the post-target transaction.",
      `Verified fenced restore using pg_ctl and psql against ${socketDir}.`,
    ];
    if (!kept_on_disk) {
      try {
        await rm(resolvedTargetDir, { recursive: true, force: true });
        notes.push("Removed the restore-test workspace after success.");
      } catch (err) {
        kept_on_disk = true;
        notes.push(
          `Restore-test cleanup failed; workspace retained at ${resolvedTargetDir}: ${String(err)}`,
        );
      }
    } else {
      notes.push(`Kept the restore-test workspace at ${resolvedTargetDir}.`);
    }

    const finished_at = new Date().toISOString();
    await recordRestoreTestState({
      paths,
      state,
      backup_set_id: resolvedBackupSetId,
      status: "passed",
      tested_at: finished_at,
      target_dir: kept_on_disk ? resolvedTargetDir : null,
      recovery_ready: true,
      pitr_target_time: pitr.target_time,
      remote_only,
    });
    return {
      ...currentBay,
      started_at,
      finished_at,
      target_time: pitr.target_time,
      backup_set_id: resolvedBackupSetId,
      target_dir: resolvedTargetDir,
      data_dir: restoreResult.data_dir,
      sync_dir: restoreResult.sync_dir,
      secrets_dir: restoreResult.secrets_dir,
      backup_manifest_path: restoreResult.backup_manifest_path,
      restore_manifest_path: restoreResult.restore_manifest_path,
      source_storage_backend: restoreResult.source_storage_backend,
      source_snapshot_id: restoreResult.source_snapshot_id,
      rustic_repo_selector: restoreResult.rustic_repo_selector,
      wal_archive_dir: restoreResult.wal_archive_dir,
      wal_storage_backend: restoreResult.wal_storage_backend,
      remote_only: restoreResult.remote_only,
      wal_segment_count: restoreResult.wal_segment_count,
      recovery_ready: restoreResult.recovery_ready,
      pitr_verified: true,
      pitr_run_id: pitr.run_id,
      kept_on_disk,
      verified_queries,
      notes,
    };
  } catch (err) {
    const finished_at = new Date().toISOString();
    await recordRestoreTestState({
      paths,
      state,
      backup_set_id: resolvedBackupSetId,
      status: "failed",
      tested_at: finished_at,
      target_dir: resolvedTargetDir,
      recovery_ready: restoreResult?.recovery_ready ?? false,
      pitr_target_time: pitrRun?.target_time ?? null,
      remote_only,
    });
    throw new Error(
      `bay restore-test failed for backup '${resolvedBackupSetId}': ${String(err)} (workspace kept at ${resolvedTargetDir})`,
    );
  } finally {
    if (socketDir) {
      await rm(socketDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
