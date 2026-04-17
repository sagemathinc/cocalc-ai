import { exists } from "@cocalc/backend/misc/async-utils-node";
import getLogger from "@cocalc/backend/logger";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { btrfs } from "./util";
import { btrfsQuotaMode, btrfsQuotasDisabled } from "./config";
import { ensureBtrfsQuotaMode } from "./quota-mode";

const logger = getLogger("file-server:btrfs:quota-queue");
const DEFAULT_RESCAN_LOG_MS = 250;
const DEFAULT_RESCAN_WARN_MS = 2000;

type QuotaWorkKind =
  | "create_qgroup"
  | "assign_snapshot_qgroup"
  | "set_qgroup_limit";

type QuotaWorkPayload =
  | {
      mount: string;
      kind: "create_qgroup";
      path: string;
    }
  | {
      mount: string;
      kind: "assign_snapshot_qgroup";
      snapshotPath: string;
      subvolumePath: string;
    }
  | {
      mount: string;
      kind: "set_qgroup_limit";
      path: string;
      size: string;
    };

type QueueStatusValue = "queued" | "in_progress" | "failed";

type QueueRow = {
  id: string;
  mount: string;
  kind: QuotaWorkKind;
  payload: QuotaWorkPayload;
  status: QueueStatusValue;
  created_at: number;
  available_at: number;
  started_at?: number | null;
  finished_at?: number | null;
  attempts: number;
  last_error?: string | null;
};

export type BtrfsQuotaQueueStatus = {
  enabled: boolean;
  mode: "disabled" | "qgroup" | "simple";
  queued_count: number;
  running_count: number;
  failed_count: number;
  retrying_count: number;
  oldest_queued_ms: number | null;
  oldest_failed_ms: number | null;
  running?: {
    id: string;
    mount: string;
    kind: QuotaWorkKind;
    age_ms: number;
    attempts: number;
  };
  last_failed?: {
    id: string;
    mount: string;
    kind: QuotaWorkKind;
    finished_at: number;
    attempts: number;
    error?: string | null;
  };
};

const TABLE = "btrfs_quota_queue";
const MAX_ATTEMPTS = 8;
let queueInitialized = false;
let workerRunning = false;
let wakeTimer: NodeJS.Timeout | undefined;
let sqliteDb: DatabaseSync | undefined;
const waiters = new Map<
  string,
  { resolve: () => void; reject: (err: Error) => void }
>();

type QuotaWorkLogContext = {
  queue_id?: string;
  kind?: QuotaWorkKind;
  mount: string;
  path?: string;
  snapshotPath?: string;
  subvolumePath?: string;
  attempts?: number;
  phase?: string;
};

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function rescanLogMs(): number {
  return positiveNumberEnv(
    "COCALC_BTRFS_QUOTA_RESCAN_LOG_MS",
    DEFAULT_RESCAN_LOG_MS,
  );
}

function rescanWarnMs(): number {
  return Math.max(
    rescanLogMs(),
    positiveNumberEnv(
      "COCALC_BTRFS_QUOTA_RESCAN_WARN_MS",
      DEFAULT_RESCAN_WARN_MS,
    ),
  );
}

function trimOutput(value: unknown, max = 400): string | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function logRescanResult(
  context: QuotaWorkLogContext,
  {
    elapsedMs,
    exit_code,
    stderr,
    stdout,
  }: {
    elapsedMs: number;
    exit_code?: number;
    stderr?: string;
    stdout?: string;
  },
): void {
  const threshold = rescanLogMs();
  const warnThreshold = rescanWarnMs();
  if (elapsedMs < threshold) {
    return;
  }
  const payload = {
    elapsed_ms: elapsedMs,
    exit_code: exit_code ?? 0,
    stderr: trimOutput(stderr),
    stdout: trimOutput(stdout),
    ...context,
  };
  if (elapsedMs >= warnThreshold || (exit_code ?? 0) !== 0) {
    logger.warn("btrfs quota rescan completed", payload);
  } else {
    logger.info("btrfs quota rescan completed", payload);
  }
}

function sqliteFilename(): string {
  return (
    process.env.COCALC_LITE_SQLITE_FILENAME ??
    path.join(process.cwd(), "data", "lite", "hub", "sqlite.db")
  );
}

function ensureSqlite(): DatabaseSync {
  if (sqliteDb) return sqliteDb;
  const filename = sqliteFilename();
  if (filename !== ":memory:") {
    mkdirSync(path.dirname(filename), { recursive: true });
  }
  sqliteDb = new DatabaseSync(filename);
  sqliteDb.exec("PRAGMA journal_mode=WAL");
  sqliteDb.exec("PRAGMA synchronous=NORMAL");
  sqliteDb.exec("PRAGMA busy_timeout=5000");
  return sqliteDb;
}

function ensureQueueTable(): void {
  if (queueInitialized) return;
  const db = ensureSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      mount TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      available_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_status_available_idx ON ${TABLE}(status, available_at, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_mount_status_idx ON ${TABLE}(mount, status, created_at)`,
  );
  queueInitialized = true;
}

function db() {
  ensureQueueTable();
  return ensureSqlite();
}

function parseRow(row: any): QueueRow {
  return {
    id: `${row.id}`,
    mount: `${row.mount}`,
    kind: row.kind as QuotaWorkKind,
    payload: JSON.parse(`${row.payload}`) as QuotaWorkPayload,
    status: row.status as QueueStatusValue,
    created_at: Number(row.created_at ?? 0),
    available_at: Number(row.available_at ?? 0),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    attempts: Number(row.attempts ?? 0),
    last_error: row.last_error == null ? null : `${row.last_error}`,
  };
}

function quoteIdent(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function lowerError(err: any): string {
  const message =
    typeof err?.stderr === "string" && err.stderr.trim()
      ? err.stderr
      : `${err?.message ?? err}`;
  return message.toLowerCase();
}

function alreadyExistsError(err: any): boolean {
  const s = lowerError(err);
  return s.includes("exist") || s.includes("already");
}

function quotaDisabledError(err: any): boolean {
  const s = lowerError(err);
  return s.includes("quota not enabled") || s.includes("quotas not enabled");
}

function rescanInProgressError(err: any): boolean {
  const s = lowerError(err);
  return s.includes("operation now in progress");
}

async function waitForRescan(
  mount: string,
  context?: Omit<QuotaWorkLogContext, "mount">,
): Promise<void> {
  if (btrfsQuotaMode() !== "qgroup") {
    return;
  }
  const started = Date.now();
  const result = await btrfs({
    args: ["quota", "rescan", "-W", mount],
    err_on_exit: false,
    verbose: false,
  });
  const elapsedMs = Date.now() - started;
  logRescanResult(
    { mount, ...context },
    {
      elapsedMs,
      exit_code: result.exit_code,
      stderr: result.stderr,
      stdout: result.stdout,
    },
  );
  if (!result.exit_code) return;
  const stderr = `${result.stderr ?? ""}`.toLowerCase();
  if (
    stderr.includes("quota not enabled") ||
    stderr.includes("quotas not enabled")
  ) {
    return;
  }
  throw new Error(
    `btrfs quota rescan -W ${mount} failed: ${result.stderr || result.stdout || result.exit_code}`,
  );
}

async function getSubvolumeIdAtPath(path: string): Promise<number> {
  const { stdout } = await btrfs({
    args: ["subvolume", "show", path],
    verbose: false,
  });
  const match = stdout.match(/^\s*Subvolume ID\s*:\s*(\d+)\s*$/im);
  if (!match?.[1]) {
    throw new Error(`unable to parse subvolume id for ${path}`);
  }
  return Number(match[1]);
}

async function enableQuota(
  mount: string,
  context?: Omit<QuotaWorkLogContext, "mount">,
): Promise<void> {
  const status = await ensureBtrfsQuotaMode(mount);
  if (status.mode === "qgroup") {
    await waitForRescan(mount, { ...context, phase: "enable-quota" });
  }
}

async function withRescanBarrier(
  mount: string,
  context: Omit<QuotaWorkLogContext, "mount">,
  fn: () => Promise<void>,
): Promise<void> {
  await waitForRescan(mount, { ...context, phase: "before" });
  try {
    await fn();
  } catch (err) {
    if (!rescanInProgressError(err)) {
      throw err;
    }
    logger.warn("btrfs qgroup operation hit in-progress rescan", {
      mount,
      ...context,
      err: trimOutput((err as any)?.stderr ?? (err as any)?.message ?? err),
    });
    await waitForRescan(mount, { ...context, phase: "retry-before" });
    await fn();
  }
  await waitForRescan(mount, { ...context, phase: "after" });
}

async function createQgroupNow({
  mount,
  path,
  context,
}: {
  mount: string;
  path: string;
  context?: Omit<QuotaWorkLogContext, "mount" | "path">;
}): Promise<void> {
  if (btrfsQuotaMode() === "simple") {
    return;
  }
  if (!(await exists(path))) return;
  const id = await getSubvolumeIdAtPath(path);
  const tryCreate = async () => {
    await withRescanBarrier(mount, { ...context, path }, async () => {
      await btrfs({
        args: ["qgroup", "create", `1/${id}`, path],
        verbose: false,
      });
    });
  };
  try {
    await tryCreate();
  } catch (err) {
    if (alreadyExistsError(err)) return;
    if (!quotaDisabledError(err)) throw err;
    await enableQuota(mount, { ...context, path });
    try {
      await tryCreate();
    } catch (retryErr) {
      if (alreadyExistsError(retryErr)) return;
      throw retryErr;
    }
  }
}

async function assignSnapshotQgroupNow({
  mount,
  snapshotPath,
  subvolumePath,
  context,
}: {
  mount: string;
  snapshotPath: string;
  subvolumePath: string;
  context?: Omit<
    QuotaWorkLogContext,
    "mount" | "snapshotPath" | "subvolumePath"
  >;
}): Promise<void> {
  if (btrfsQuotaMode() === "simple") {
    return;
  }
  if (!(await exists(snapshotPath)) || !(await exists(subvolumePath))) return;
  const snapshotId = await getSubvolumeIdAtPath(snapshotPath);
  const subvolumeId = await getSubvolumeIdAtPath(subvolumePath);
  const tryAssign = async () => {
    await withRescanBarrier(
      mount,
      { ...context, snapshotPath, subvolumePath },
      async () => {
        await btrfs({
          args: [
            "qgroup",
            "assign",
            `0/${snapshotId}`,
            `1/${subvolumeId}`,
            subvolumePath,
          ],
          verbose: false,
        });
      },
    );
  };
  try {
    await tryAssign();
  } catch (err) {
    if (alreadyExistsError(err)) return;
    if (!quotaDisabledError(err)) throw err;
    await enableQuota(mount, { ...context, snapshotPath, subvolumePath });
    try {
      await tryAssign();
    } catch (retryErr) {
      if (alreadyExistsError(retryErr)) return;
      throw retryErr;
    }
  }
}

async function setQgroupLimitNow({
  mount,
  path,
  size,
  context,
}: {
  mount: string;
  path: string;
  size: string;
  context?: Omit<QuotaWorkLogContext, "mount" | "path">;
}): Promise<void> {
  if (!(await exists(path))) return;
  const id = await getSubvolumeIdAtPath(path);
  const quotaMode = btrfsQuotaMode();
  const tryLimit = async () => {
    await withRescanBarrier(mount, { ...context, path }, async () => {
      await btrfs({
        args: ["qgroup", "limit", `${size}`, path],
        verbose: false,
      });
      if (quotaMode === "simple") {
        return;
      }
      await btrfs({
        args: ["qgroup", "limit", `${size}`, `1/${id}`, path],
        verbose: false,
      });
    });
  };
  try {
    await tryLimit();
  } catch (err) {
    await enableQuota(mount, { ...context, path });
    if (quotaMode !== "simple") {
      await createQgroupNow({ mount, path, context });
    }
    await tryLimit();
  }
}

async function executeRow(row: QueueRow): Promise<void> {
  const context = {
    queue_id: row.id,
    kind: row.kind,
    attempts: row.attempts,
  } satisfies Omit<QuotaWorkLogContext, "mount">;
  switch (row.payload.kind) {
    case "create_qgroup":
      await createQgroupNow({
        mount: row.payload.mount,
        path: row.payload.path,
        context,
      });
      return;
    case "assign_snapshot_qgroup":
      await assignSnapshotQgroupNow({
        mount: row.payload.mount,
        snapshotPath: row.payload.snapshotPath,
        subvolumePath: row.payload.subvolumePath,
        context,
      });
      return;
    case "set_qgroup_limit":
      await setQgroupLimitNow({
        mount: row.payload.mount,
        path: row.payload.path,
        size: row.payload.size,
        context,
      });
      return;
  }
}

function readyRow(now = Date.now()): QueueRow | undefined {
  const row = db()
    .prepare(
      `
        SELECT id, mount, kind, payload, status, created_at, available_at, started_at, finished_at, attempts, last_error
        FROM ${TABLE}
        WHERE status = 'in_progress'
           OR (status = 'queued' AND available_at <= ?)
        ORDER BY
          CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END,
          available_at ASC,
          created_at ASC
        LIMIT 1
      `,
    )
    .get(now);
  if (!row) return undefined;
  return parseRow(row);
}

function nextWakeMs(now = Date.now()): number | null {
  const row = db()
    .prepare(
      `
        SELECT MIN(available_at) AS next_at
        FROM ${TABLE}
        WHERE status = 'queued'
      `,
    )
    .get() as { next_at?: number | null } | undefined;
  const next = row?.next_at == null ? null : Number(row.next_at);
  if (next == null || Number.isNaN(next)) return null;
  return Math.max(0, next - now);
}

function markInProgress(row: QueueRow): QueueRow {
  const attempts = row.attempts + 1;
  const started_at = Date.now();
  db()
    .prepare(
      `
        UPDATE ${TABLE}
        SET status='in_progress', started_at=?, finished_at=NULL, attempts=?, last_error=NULL
        WHERE id=?
      `,
    )
    .run(started_at, attempts, row.id);
  return {
    ...row,
    status: "in_progress",
    started_at,
    attempts,
    last_error: null,
  };
}

function clearWakeTimer(): void {
  if (!wakeTimer) return;
  clearTimeout(wakeTimer);
  wakeTimer = undefined;
}

function scheduleWake(delayMs = 0): void {
  clearWakeTimer();
  wakeTimer = setTimeout(
    () => {
      wakeTimer = undefined;
      void runWorker();
    },
    Math.max(0, delayMs),
  );
  wakeTimer.unref?.();
}

function shouldRetry(row: QueueRow, err: any): boolean {
  if (alreadyExistsError(err)) return false;
  return row.attempts < MAX_ATTEMPTS;
}

function retryDelayMs(attempts: number): number {
  return Math.min(30_000, Math.max(250, 250 * 2 ** Math.max(0, attempts - 1)));
}

function settleWaiter(id: string, err?: Error): void {
  const waiter = waiters.get(id);
  if (!waiter) return;
  waiters.delete(id);
  if (err) {
    waiter.reject(err);
  } else {
    waiter.resolve();
  }
}

async function runWorker(): Promise<void> {
  ensureQueueTable();
  if (workerRunning) return;
  workerRunning = true;
  clearWakeTimer();
  try {
    while (true) {
      const row = readyRow();
      if (!row) {
        const nextDelay = nextWakeMs();
        if (nextDelay != null) {
          scheduleWake(nextDelay);
        }
        return;
      }
      const claimed = markInProgress(row);
      try {
        await executeRow(claimed);
        db().prepare(`DELETE FROM ${TABLE} WHERE id=?`).run(claimed.id);
        settleWaiter(claimed.id);
      } catch (err) {
        const message =
          typeof (err as any)?.stderr === "string" && (err as any).stderr.trim()
            ? `${(err as any).stderr}`.trim()
            : `${(err as any)?.message ?? err}`;
        if (shouldRetry(claimed, err)) {
          const delayMs = retryDelayMs(claimed.attempts);
          db()
            .prepare(
              `
                UPDATE ${TABLE}
                SET status='queued',
                    available_at=?,
                    finished_at=?,
                    last_error=?
                WHERE id=?
              `,
            )
            .run(Date.now() + delayMs, Date.now(), message, claimed.id);
          logger.warn("requeueing btrfs quota work", {
            id: claimed.id,
            kind: claimed.kind,
            mount: claimed.mount,
            attempts: claimed.attempts,
            delayMs,
            err: message,
          });
        } else {
          db()
            .prepare(
              `
                UPDATE ${TABLE}
                SET status='failed', finished_at=?, last_error=?
                WHERE id=?
              `,
            )
            .run(Date.now(), message, claimed.id);
          logger.error("btrfs quota work failed permanently", {
            id: claimed.id,
            kind: claimed.kind,
            mount: claimed.mount,
            attempts: claimed.attempts,
            err: message,
          });
          settleWaiter(
            claimed.id,
            new Error(
              `btrfs quota queue item ${claimed.id} failed after ${claimed.attempts} attempts: ${message}`,
            ),
          );
        }
      }
    }
  } finally {
    workerRunning = false;
    if (readyRow()) {
      scheduleWake(0);
    }
  }
}

function enqueueRow(
  payload: QuotaWorkPayload,
  { wait }: { wait: boolean },
): Promise<void> | void {
  if (btrfsQuotasDisabled()) {
    return wait ? Promise.resolve() : undefined;
  }
  ensureQueueTable();
  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      `
        INSERT INTO ${TABLE} (
          id, mount, kind, payload, status, created_at, available_at, attempts
        )
        VALUES (?, ?, ?, ?, 'queued', ?, ?, 0)
      `,
    )
    .run(id, payload.mount, payload.kind, JSON.stringify(payload), now, now);
  scheduleWake(0);
  if (!wait) return;
  return new Promise<void>((resolve, reject) => {
    waiters.set(id, { resolve, reject });
  });
}

export function startBtrfsQuotaQueue(): void {
  if (btrfsQuotasDisabled()) {
    return;
  }
  ensureQueueTable();
  scheduleWake(0);
}

export function queueCreateSubvolumeQgroup(opts: {
  mount: string;
  path: string;
  wait?: boolean;
}): Promise<void> | void {
  return enqueueRow(
    {
      mount: opts.mount,
      kind: "create_qgroup",
      path: opts.path,
    },
    { wait: opts.wait ?? true },
  );
}

export function queueAssignSnapshotQgroup(opts: {
  mount: string;
  snapshotPath: string;
  subvolumePath: string;
  wait?: boolean;
}): Promise<void> | void {
  return enqueueRow(
    {
      mount: opts.mount,
      kind: "assign_snapshot_qgroup",
      snapshotPath: opts.snapshotPath,
      subvolumePath: opts.subvolumePath,
    },
    { wait: opts.wait ?? false },
  );
}

export function queueSetSubvolumeQuota(opts: {
  mount: string;
  path: string;
  size: string | number;
  wait?: boolean;
}): Promise<void> | void {
  return enqueueRow(
    {
      mount: opts.mount,
      kind: "set_qgroup_limit",
      path: opts.path,
      size: `${opts.size}`,
    },
    { wait: opts.wait ?? true },
  );
}

export function getBtrfsQuotaQueueStatus(
  mount?: string,
): BtrfsQuotaQueueStatus | undefined {
  if (btrfsQuotasDisabled()) {
    return {
      enabled: false,
      mode: "disabled",
      queued_count: 0,
      running_count: 0,
      failed_count: 0,
      retrying_count: 0,
      oldest_queued_ms: null,
      oldest_failed_ms: null,
    };
  }
  if (!queueInitialized) return undefined;
  const mode = btrfsQuotaMode();
  const where = mount ? `WHERE mount = ${quoteIdent(mount)}` : "";
  const rows = db()
    .prepare(
      `
        SELECT id, mount, kind, payload, status, created_at, available_at, started_at, finished_at, attempts, last_error
        FROM ${TABLE}
        ${where}
        ORDER BY created_at ASC
      `,
    )
    .all()
    .map(parseRow);
  const now = Date.now();
  let oldest_queued_ms: number | null = null;
  let oldest_failed_ms: number | null = null;
  let last_failed: BtrfsQuotaQueueStatus["last_failed"];
  let running: BtrfsQuotaQueueStatus["running"];
  let queued_count = 0;
  let running_count = 0;
  let failed_count = 0;
  let retrying_count = 0;
  for (const row of rows) {
    if (row.status === "queued") {
      queued_count += 1;
      if (row.available_at > now) {
        retrying_count += 1;
      }
      const age = now - row.created_at;
      oldest_queued_ms =
        oldest_queued_ms == null ? age : Math.max(oldest_queued_ms, age);
      continue;
    }
    if (row.status === "in_progress") {
      running_count += 1;
      const age = now - (row.started_at ?? row.created_at);
      if (!running) {
        running = {
          id: row.id,
          mount: row.mount,
          kind: row.kind,
          age_ms: age,
          attempts: row.attempts,
        };
      }
      continue;
    }
    if (row.status === "failed") {
      failed_count += 1;
      const finished_at = row.finished_at ?? row.created_at;
      const age = now - finished_at;
      oldest_failed_ms =
        oldest_failed_ms == null ? age : Math.max(oldest_failed_ms, age);
      if (
        !last_failed ||
        finished_at > (last_failed.finished_at ?? row.created_at)
      ) {
        last_failed = {
          id: row.id,
          mount: row.mount,
          kind: row.kind,
          finished_at,
          attempts: row.attempts,
          error: row.last_error,
        };
      }
    }
  }
  return {
    enabled: true,
    mode: mode === "simple" ? "simple" : "qgroup",
    queued_count,
    running_count,
    failed_count,
    retrying_count,
    oldest_queued_ms,
    oldest_failed_ms,
    running,
    last_failed,
  };
}
