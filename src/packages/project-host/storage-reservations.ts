import { executeCode } from "@cocalc/backend/execute-code";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import getLogger from "@cocalc/backend/logger";
import type { HostCurrentMetrics } from "@cocalc/conat/hub/api/hosts";
import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  imageCachePath,
  inspectFilePath,
} from "@cocalc/project-runner/run/rootfs-base";
import type { RootfsReleaseArtifactAccess } from "@cocalc/util/rootfs-images";
import { uuid } from "@cocalc/util/misc";
import { readDiskMetrics, resolveStorageMount } from "./storage-metrics";

const logger = getLogger("project-host:storage-reservations");

const TABLE = "storage_reservations";
const GiB = 1024 ** 3;
const DEFAULT_MIN_FREE_BYTES = Math.max(
  GiB,
  Number(process.env.COCALC_STORAGE_RESERVATION_MIN_FREE_BYTES ?? 8 * GiB),
);
const DEFAULT_TTL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.COCALC_STORAGE_RESERVATION_TTL_MS ?? 2 * 60 * 60 * 1000),
);
const DEFAULT_METADATA_MAX_USED_PERCENT = Math.max(
  1,
  Math.min(
    99,
    Number(process.env.COCALC_STORAGE_METADATA_MAX_USED_PERCENT ?? 92),
  ),
);
const DEFAULT_OCI_UNKNOWN_BYTES = Math.max(
  GiB,
  Number(process.env.COCALC_STORAGE_OCI_UNKNOWN_BYTES ?? 20 * GiB),
);
const DEFAULT_OCI_MIN_BYTES = Math.max(
  GiB,
  Number(process.env.COCALC_STORAGE_OCI_MIN_BYTES ?? 4 * GiB),
);
const DEFAULT_OCI_OVERHEAD_BYTES = Math.max(
  0,
  Number(process.env.COCALC_STORAGE_OCI_OVERHEAD_BYTES ?? 2 * GiB),
);
const DEFAULT_ROOTFS_OVERHEAD_BYTES = Math.max(
  0,
  Number(process.env.COCALC_STORAGE_ROOTFS_OVERHEAD_BYTES ?? GiB),
);
const DEFAULT_OCI_COMPRESSED_MULTIPLIER = Math.max(
  1,
  Number(process.env.COCALC_STORAGE_OCI_COMPRESSED_MULTIPLIER ?? 3),
);
const OCI_ESTIMATE_CACHE_MS = 15 * 60 * 1000;

type ReservationState = "active";

export type StorageReservationKind =
  | "oci-pull"
  | "rootfs-pull"
  | "backup-restore"
  | "rootfs-publish";

export type StorageReservationRow = {
  reservation_id: string;
  kind: StorageReservationKind;
  project_id?: string;
  op_id?: string;
  resource_id?: string;
  estimated_bytes: number;
  created_at: number;
  expires_at: number;
  state: ReservationState;
};

type ActiveStorageReservationSummary = {
  total_bytes: number;
  count: number;
  by_kind: Partial<Record<StorageReservationKind, number>>;
  rows: StorageReservationRow[];
};

export class StorageReservationError extends Error {
  readonly kind: StorageReservationKind;
  readonly estimated_bytes: number;
  readonly available_bytes?: number;
  readonly metadata_used_percent?: number;

  constructor({
    kind,
    message,
    estimated_bytes,
    available_bytes,
    metadata_used_percent,
  }: {
    kind: StorageReservationKind;
    message: string;
    estimated_bytes: number;
    available_bytes?: number;
    metadata_used_percent?: number;
  }) {
    super(message);
    this.name = "StorageReservationError";
    this.kind = kind;
    this.estimated_bytes = estimated_bytes;
    this.available_bytes = available_bytes;
    this.metadata_used_percent = metadata_used_percent;
  }
}

type AcquireStorageReservationOptions = {
  kind: StorageReservationKind;
  estimated_bytes: number;
  project_id?: string;
  op_id?: string;
  resource_id?: string;
  ttl_ms?: number;
  min_free_bytes?: number;
  metadata_max_used_percent?: number;
  current_storage?: Partial<HostCurrentMetrics>;
};

function roundBytes(value: number): number {
  return Math.max(0, Math.ceil(value));
}

function formatBinaryBytes(value?: number): string {
  if (value == null || !Number.isFinite(value)) return "unknown";
  const abs = Math.abs(value);
  if (abs >= GiB) return `${(value / GiB).toFixed(1)} GiB`;
  const MiB = 1024 ** 2;
  if (abs >= MiB) return `${(value / MiB).toFixed(1)} MiB`;
  const KiB = 1024;
  if (abs >= KiB) return `${(value / KiB).toFixed(1)} KiB`;
  return `${Math.round(value)} B`;
}

function kindLabel(kind: StorageReservationKind): string {
  switch (kind) {
    case "oci-pull":
      return "OCI pull";
    case "rootfs-pull":
      return "RootFS pull";
    case "backup-restore":
      return "backup restore";
    case "rootfs-publish":
      return "RootFS publish";
  }
}

function ensureStorageReservationsTable() {
  const db = initDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      reservation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      project_id TEXT,
      op_id TEXT,
      resource_id TEXT,
      estimated_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_state_expires_idx ON ${TABLE}(state, expires_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_project_state_idx ON ${TABLE}(project_id, state)`,
  );
}

export function cleanupExpiredStorageReservations(now = Date.now()): number {
  ensureStorageReservationsTable();
  const db = getDatabase();
  const result = db
    .prepare(
      `DELETE FROM ${TABLE} WHERE state='active' AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .run(now) as { changes?: number };
  return Number(result?.changes ?? 0);
}

export function listActiveStorageReservations(
  now = Date.now(),
): StorageReservationRow[] {
  ensureStorageReservationsTable();
  cleanupExpiredStorageReservations(now);
  const db = getDatabase();
  return db
    .prepare(
      `SELECT reservation_id, kind, project_id, op_id, resource_id, estimated_bytes, created_at, expires_at, state
         FROM ${TABLE}
        WHERE state='active' AND expires_at > ?
        ORDER BY created_at ASC`,
    )
    .all(now) as StorageReservationRow[];
}

export function getActiveStorageReservationSummary(
  now = Date.now(),
): ActiveStorageReservationSummary {
  const rows = listActiveStorageReservations(now);
  const by_kind: ActiveStorageReservationSummary["by_kind"] = {};
  let total_bytes = 0;
  for (const row of rows) {
    total_bytes += Math.max(0, Number(row.estimated_bytes) || 0);
    by_kind[row.kind] = (by_kind[row.kind] ?? 0) + 1;
  }
  return {
    total_bytes,
    count: rows.length,
    by_kind,
    rows,
  };
}

function metadataUsedPercent(
  storage: Partial<HostCurrentMetrics>,
): number | undefined {
  const used = storage.btrfs_metadata_used_bytes;
  const total = storage.btrfs_metadata_total_bytes;
  if (
    used == null ||
    total == null ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return undefined;
  }
  return (used / total) * 100;
}

export async function acquireStorageReservation({
  kind,
  estimated_bytes,
  project_id,
  op_id,
  resource_id,
  ttl_ms = DEFAULT_TTL_MS,
  min_free_bytes = DEFAULT_MIN_FREE_BYTES,
  metadata_max_used_percent = DEFAULT_METADATA_MAX_USED_PERCENT,
  current_storage,
}: AcquireStorageReservationOptions): Promise<StorageReservationRow> {
  const estimated = roundBytes(estimated_bytes);
  if (!(estimated > 0)) {
    throw new Error(`invalid storage reservation estimate for ${kind}`);
  }
  const storage =
    current_storage ?? (await readDiskMetrics(resolveStorageMount()));
  const available = storage.disk_available_conservative_bytes;
  if (available == null || !Number.isFinite(available)) {
    throw new StorageReservationError({
      kind,
      estimated_bytes: estimated,
      message: `host storage reservation denied for ${kindLabel(kind)}: unable to determine conservative free space on ${resolveStorageMount()}`,
    });
  }
  const metadataPercent = metadataUsedPercent(storage);
  if (
    metadataPercent != null &&
    Number.isFinite(metadataPercent) &&
    metadataPercent >= metadata_max_used_percent
  ) {
    throw new StorageReservationError({
      kind,
      estimated_bytes: estimated,
      available_bytes: available,
      metadata_used_percent: metadataPercent,
      message: `host storage reservation denied for ${kindLabel(kind)}: Btrfs metadata usage is ${metadataPercent.toFixed(1)}%, above the ${metadata_max_used_percent.toFixed(1)}% safety limit`,
    });
  }
  const now = Date.now();
  const summary = getActiveStorageReservationSummary(now);
  const availableForAdmission = Math.max(0, available - summary.total_bytes);
  const requiredWithHeadroom = estimated + Math.max(0, min_free_bytes);
  if (availableForAdmission < requiredWithHeadroom) {
    throw new StorageReservationError({
      kind,
      estimated_bytes: estimated,
      available_bytes: availableForAdmission,
      metadata_used_percent: metadataPercent,
      message:
        `host storage reservation denied for ${kindLabel(kind)}: need ${formatBinaryBytes(estimated)} plus ${formatBinaryBytes(min_free_bytes)} safety headroom, ` +
        `but only ${formatBinaryBytes(availableForAdmission)} is available for admission on ${resolveStorageMount()}`,
    });
  }
  const row: StorageReservationRow = {
    reservation_id: uuid(),
    kind,
    project_id,
    op_id,
    resource_id,
    estimated_bytes: estimated,
    created_at: now,
    expires_at: now + Math.max(60_000, ttl_ms),
    state: "active",
  };
  const db = getDatabase();
  db.prepare(
    `INSERT INTO ${TABLE} (
      reservation_id,
      kind,
      project_id,
      op_id,
      resource_id,
      estimated_bytes,
      created_at,
      expires_at,
      state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.reservation_id,
    row.kind,
    row.project_id ?? null,
    row.op_id ?? null,
    row.resource_id ?? null,
    row.estimated_bytes,
    row.created_at,
    row.expires_at,
    row.state,
  );
  logger.info("storage reservation acquired", {
    reservation_id: row.reservation_id,
    kind,
    project_id,
    op_id,
    resource_id,
    estimated_bytes: estimated,
    available_bytes: availableForAdmission,
    remaining_after_reservation: availableForAdmission - estimated,
  });
  return row;
}

export function releaseStorageReservation(reservation_id: string): void {
  if (!reservation_id) return;
  ensureStorageReservationsTable();
  const db = getDatabase();
  db.prepare(`DELETE FROM ${TABLE} WHERE reservation_id = ?`).run(
    reservation_id,
  );
}

export async function withStorageReservation<T>(
  opts: AcquireStorageReservationOptions,
  fn: (reservation: StorageReservationRow) => Promise<T>,
): Promise<T> {
  const reservation = await acquireStorageReservation(opts);
  try {
    return await fn(reservation);
  } finally {
    releaseStorageReservation(reservation.reservation_id);
  }
}

type CachedEstimate = {
  expires_at: number;
  estimated_bytes: number;
  compressed_bytes?: number;
  source: "skopeo" | "fallback";
};

const ociEstimateCache = new Map<string, CachedEstimate>();

async function inspectRemoteOciCompressedBytes(
  image: string,
): Promise<number | undefined> {
  try {
    const { stdout, exit_code, stderr } = await executeCode({
      command: "skopeo",
      args: ["inspect", `docker://${image}`],
      timeout: 60,
      err_on_exit: false,
      env: {
        ...process.env,
        LC_ALL: "C.UTF-8",
        LANG: "C.UTF-8",
      },
    });
    if (exit_code !== 0) {
      logger.warn("skopeo inspect failed during OCI storage estimate", {
        image,
        exit_code,
        stderr,
      });
      return undefined;
    }
    const parsed = JSON.parse(`${stdout ?? "{}"}`);
    const layersData = Array.isArray(parsed?.LayersData)
      ? parsed.LayersData
      : undefined;
    const total = layersData?.reduce((sum: number, layer: any) => {
      const size = Number(layer?.Size);
      return Number.isFinite(size) && size > 0 ? sum + size : sum;
    }, 0);
    return total && Number.isFinite(total) && total > 0 ? total : undefined;
  } catch (err) {
    logger.warn("unable to estimate OCI image size with skopeo", {
      image,
      err: `${err}`,
    });
    return undefined;
  }
}

export async function estimateOciPullReservation({
  image,
}: {
  image: string;
}): Promise<{
  estimated_bytes: number;
  compressed_bytes?: number;
  source: "skopeo" | "fallback";
}> {
  const cached = ociEstimateCache.get(image);
  if (cached && cached.expires_at > Date.now()) {
    return {
      estimated_bytes: cached.estimated_bytes,
      compressed_bytes: cached.compressed_bytes,
      source: cached.source,
    };
  }
  const compressed_bytes = await inspectRemoteOciCompressedBytes(image);
  const estimated_bytes =
    compressed_bytes != null
      ? Math.max(
          DEFAULT_OCI_MIN_BYTES,
          Math.ceil(
            compressed_bytes * DEFAULT_OCI_COMPRESSED_MULTIPLIER +
              DEFAULT_OCI_OVERHEAD_BYTES,
          ),
        )
      : DEFAULT_OCI_UNKNOWN_BYTES;
  const value: CachedEstimate = {
    expires_at: Date.now() + OCI_ESTIMATE_CACHE_MS,
    estimated_bytes,
    compressed_bytes,
    source: compressed_bytes != null ? "skopeo" : "fallback",
  };
  ociEstimateCache.set(image, value);
  return {
    estimated_bytes: value.estimated_bytes,
    compressed_bytes: value.compressed_bytes,
    source: value.source,
  };
}

async function hasCachedOciRootfs(image: string): Promise<boolean> {
  return (
    (await exists(imageCachePath(image))) &&
    (await exists(inspectFilePath(image)))
  );
}

export async function withOciPullReservationIfNeeded<T>({
  image,
  project_id,
  op_id,
  onProgress,
  fn,
}: {
  image: string;
  project_id?: string;
  op_id?: string;
  onProgress?: (update: {
    estimated_bytes: number;
    compressed_bytes?: number;
    source: "skopeo" | "fallback";
  }) => void;
  fn: () => Promise<T>;
}): Promise<T> {
  if (await hasCachedOciRootfs(image)) {
    return await fn();
  }
  const estimate = await estimateOciPullReservation({ image });
  onProgress?.(estimate);
  return await withStorageReservation(
    {
      kind: "oci-pull",
      estimated_bytes: estimate.estimated_bytes,
      project_id,
      op_id,
      resource_id: image,
    },
    async () => await fn(),
  );
}

export function estimateManagedRootfsPullReservationBytes(
  access: Pick<RootfsReleaseArtifactAccess, "artifact_bytes" | "size_bytes">,
): number {
  const releaseBytes =
    access.size_bytes != null && Number.isFinite(access.size_bytes)
      ? access.size_bytes
      : undefined;
  const artifactBytes =
    access.artifact_bytes != null && Number.isFinite(access.artifact_bytes)
      ? access.artifact_bytes
      : undefined;
  const estimated = Math.max(
    releaseBytes ?? 0,
    artifactBytes != null ? Math.ceil(artifactBytes * 2) : 0,
    DEFAULT_OCI_MIN_BYTES,
  );
  return estimated + DEFAULT_ROOTFS_OVERHEAD_BYTES;
}

export const _test = {
  metadataUsedPercent,
  estimateManagedRootfsPullReservationBytes,
};
