import { exists } from "@cocalc/backend/misc/async-utils-node";
import getLogger from "@cocalc/backend/logger";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { btrfs } from "./util";
import { btrfsQuotasDisabled } from "./config";
import { ensureBtrfsQuotaMode } from "./quota-mode";
import {
  type BtrfsMutationContext,
  type BtrfsMutationPriority,
  effectiveBtrfsMutationContext,
  withBtrfsMutationContext,
  withBtrfsMutationLock,
} from "./operation-cache";

const logger = getLogger("file-server:btrfs:quota-queue");

type QuotaWorkKind = "set_subvolume_limit";

type QuotaWorkPayload = {
  mount: string;
  kind: "set_subvolume_limit";
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
  logical_key?: string | null;
  project_id?: string | null;
  volume_kind?: string | null;
  operation_id?: string | null;
  operation_class?: string | null;
  base_priority: number;
  context: BtrfsMutationContext;
  first_enqueued_at: number;
  last_coalesced_at: number;
  claimed_at?: number | null;
  lock_acquired_at?: number | null;
  command_started_at?: number | null;
  command_finished_at?: number | null;
  completed_at?: number | null;
  coalesced_count: number;
};

export type BtrfsQuotaQueueStatus = {
  enabled: boolean;
  mode: "disabled" | "simple";
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
    project_id?: string | null;
    volume_kind?: string | null;
    operation_id?: string | null;
    operation_class?: string | null;
    priority: BtrfsMutationPriority;
    queue_wait_ms: number;
    lock_wait_ms?: number;
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
const AGING_INTERVAL_MS = 5 * 60_000;
let queueInitialized = false;
let workerRunning = false;
let wakeTimer: NodeJS.Timeout | undefined;
let sqliteDb: DatabaseSync | undefined;
const waiters = new Map<
  string,
  Set<{ resolve: () => void; reject: (err: Error) => void }>
>();

const PRIORITY_VALUE: Record<BtrfsMutationPriority, number> = {
  lifecycle: 0,
  interactive: 1,
  scheduled: 2,
  scavenger: 3,
};

const PRIORITY_NAME: BtrfsMutationPriority[] = [
  "lifecycle",
  "interactive",
  "scheduled",
  "scavenger",
];

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
      last_error TEXT,
      logical_key TEXT,
      project_id TEXT,
      volume_kind TEXT,
      operation_id TEXT,
      operation_class TEXT,
      base_priority INTEGER NOT NULL DEFAULT 1,
      context_json TEXT,
      first_enqueued_at INTEGER,
      last_coalesced_at INTEGER,
      claimed_at INTEGER,
      lock_acquired_at INTEGER,
      command_started_at INTEGER,
      command_finished_at INTEGER,
      completed_at INTEGER,
      coalesced_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  for (const [name, definition] of [
    ["logical_key", "TEXT"],
    ["project_id", "TEXT"],
    ["volume_kind", "TEXT"],
    ["operation_id", "TEXT"],
    ["operation_class", "TEXT"],
    ["base_priority", "INTEGER NOT NULL DEFAULT 1"],
    ["context_json", "TEXT"],
    ["first_enqueued_at", "INTEGER"],
    ["last_coalesced_at", "INTEGER"],
    ["claimed_at", "INTEGER"],
    ["lock_acquired_at", "INTEGER"],
    ["command_started_at", "INTEGER"],
    ["command_finished_at", "INTEGER"],
    ["completed_at", "INTEGER"],
    ["coalesced_count", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    try {
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${name} ${definition}`);
    } catch {
      // Existing databases already have this additive column.
    }
  }
  db.exec(`
    UPDATE ${TABLE}
    SET first_enqueued_at = COALESCE(first_enqueued_at, created_at),
        last_coalesced_at = COALESCE(last_coalesced_at, created_at)
    WHERE first_enqueued_at IS NULL OR last_coalesced_at IS NULL
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_status_available_idx ON ${TABLE}(status, available_at, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_mount_status_idx ON ${TABLE}(mount, status, created_at)`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_queued_logical_key_idx ON ${TABLE}(logical_key) WHERE status='queued' AND logical_key IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_priority_idx ON ${TABLE}(status, base_priority, available_at, first_enqueued_at)`,
  );
  queueInitialized = true;
}

function db() {
  ensureQueueTable();
  return ensureSqlite();
}

function parseRow(row: any): QueueRow {
  let context: BtrfsMutationContext = {};
  try {
    context = row.context_json ? JSON.parse(`${row.context_json}`) : {};
  } catch {
    context = {};
  }
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
    logical_key: row.logical_key == null ? null : `${row.logical_key}`,
    project_id: row.project_id == null ? null : `${row.project_id}`,
    volume_kind: row.volume_kind == null ? null : `${row.volume_kind}`,
    operation_id: row.operation_id == null ? null : `${row.operation_id}`,
    operation_class:
      row.operation_class == null ? null : `${row.operation_class}`,
    base_priority: Number(row.base_priority ?? 1),
    context,
    first_enqueued_at: Number(row.first_enqueued_at ?? row.created_at ?? 0),
    last_coalesced_at: Number(row.last_coalesced_at ?? row.created_at ?? 0),
    claimed_at: row.claimed_at == null ? null : Number(row.claimed_at),
    lock_acquired_at:
      row.lock_acquired_at == null ? null : Number(row.lock_acquired_at),
    command_started_at:
      row.command_started_at == null ? null : Number(row.command_started_at),
    command_finished_at:
      row.command_finished_at == null ? null : Number(row.command_finished_at),
    completed_at: row.completed_at == null ? null : Number(row.completed_at),
    coalesced_count: Number(row.coalesced_count ?? 0),
  };
}

function quoteIdent(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shouldRetry(row: QueueRow): boolean {
  return row.attempts < MAX_ATTEMPTS;
}

function retryDelayMs(attempts: number): number {
  return Math.min(30_000, Math.max(250, 250 * 2 ** Math.max(0, attempts - 1)));
}

function settleWaiter(id: string, err?: Error): void {
  const entries = waiters.get(id);
  if (!entries) return;
  waiters.delete(id);
  for (const waiter of entries) {
    if (err) {
      waiter.reject(err);
    } else {
      waiter.resolve();
    }
  }
}

function addWaiter(
  id: string,
  waiter: { resolve: () => void; reject: (err: Error) => void },
): void {
  let entries = waiters.get(id);
  if (!entries) {
    entries = new Set();
    waiters.set(id, entries);
  }
  entries.add(waiter);
}

function priorityName(value: number): BtrfsMutationPriority {
  return PRIORITY_NAME[Math.max(0, Math.min(3, Math.floor(value)))]!;
}

async function setSubvolumeLimitNow({
  mount,
  path,
  size,
}: {
  mount: string;
  path: string;
  size: string;
}): Promise<void> {
  if (!(await exists(path))) return;
  // Deliberately do not create or touch tracking qgroups here. CoCalc uses
  // only btrfs simple quotas because classic qgroups caused severe latency and
  // host instability under our snapshot-heavy workload.
  await ensureBtrfsQuotaMode(mount);
  // Select the qgroup by subvolume path, but issue the ioctl through the
  // filesystem mount. On some kernels, using the over-quota subvolume as the
  // ioctl target needs a quota reservation there and fails with EDQUOT even
  // when raising its limit. btrfs resolves the selector to its current ID.
  await btrfs({
    args: ["qgroup", "limit", `${size}`, path, mount],
    verbose: false,
  });
}

async function executeRow(row: QueueRow): Promise<void> {
  const context = effectiveBtrfsMutationContext({
    ...row.context,
    project_id: row.project_id ?? row.context.project_id,
    operation_id: row.operation_id ?? row.context.operation_id,
    operation_class: row.operation_class ?? row.context.operation_class,
    priority: priorityName(row.base_priority),
  });
  await withBtrfsMutationContext(context, async () => {
    const lockWaitStarted = Date.now();
    await withBtrfsMutationLock({
      mount: row.mount,
      operation: `quota:${row.volume_kind ?? "subvolume"}`,
      context,
      run: async () => {
        const lockAcquiredAt = Date.now();
        db()
          .prepare(
            `UPDATE ${TABLE} SET lock_acquired_at=?, command_started_at=? WHERE id=?`,
          )
          .run(lockAcquiredAt, lockAcquiredAt, row.id);
        logger.debug("executing btrfs quota work", {
          id: row.id,
          project_id: row.project_id,
          volume_kind: row.volume_kind,
          operation_id: row.operation_id,
          priority: context.priority,
          queue_wait_ms:
            (row.claimed_at ?? lockWaitStarted) - row.first_enqueued_at,
          lock_wait_ms: lockAcquiredAt - lockWaitStarted,
          coalesced_count: row.coalesced_count,
        });
        switch (row.payload.kind) {
          case "set_subvolume_limit":
            await setSubvolumeLimitNow({
              mount: row.payload.mount,
              path: row.payload.path,
              size: row.payload.size,
            });
            break;
        }
        db()
          .prepare(`UPDATE ${TABLE} SET command_finished_at=? WHERE id=?`)
          .run(Date.now(), row.id);
      },
    });
  });
}

function readyRow(now = Date.now()): QueueRow | undefined {
  const row = db()
    .prepare(
      `
        SELECT *
        FROM ${TABLE}
        WHERE status = 'in_progress'
           OR (status = 'queued' AND available_at <= ?)
        ORDER BY
          CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END,
          MAX(0, base_priority - CAST((? - COALESCE(first_enqueued_at, created_at)) / ? AS INTEGER)) ASC,
          available_at ASC,
          COALESCE(first_enqueued_at, created_at) ASC
        LIMIT 1
      `,
    )
    .get(now, now, AGING_INTERVAL_MS);
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
        SET status='in_progress',
            started_at=?,
            claimed_at=?,
            lock_acquired_at=NULL,
            command_started_at=NULL,
            command_finished_at=NULL,
            finished_at=NULL,
            attempts=?,
            last_error=NULL
        WHERE id=?
      `,
    )
    .run(started_at, started_at, attempts, row.id);
  return {
    ...row,
    status: "in_progress",
    started_at,
    claimed_at: started_at,
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
        const completedAt = Date.now();
        db()
          .prepare(`UPDATE ${TABLE} SET completed_at=? WHERE id=?`)
          .run(completedAt, claimed.id);
        db().prepare(`DELETE FROM ${TABLE} WHERE id=?`).run(claimed.id);
        settleWaiter(claimed.id);
      } catch (err) {
        const message =
          typeof (err as any)?.stderr === "string" && (err as any).stderr.trim()
            ? `${(err as any).stderr}`.trim()
            : `${(err as any)?.message ?? err}`;
        if (shouldRetry(claimed)) {
          const delayMs = retryDelayMs(claimed.attempts);
          db()
            .prepare(
              `
                UPDATE ${TABLE}
                SET status='queued',
                    available_at=?,
                    finished_at=?,
                    claimed_at=NULL,
                    lock_acquired_at=NULL,
                    command_started_at=NULL,
                    command_finished_at=NULL,
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
  {
    wait,
    logicalKey,
    projectId,
    volumeKind,
    operationId,
    operationClass,
    context,
  }: {
    wait: boolean;
    logicalKey: string;
    projectId?: string;
    volumeKind?: string;
    operationId?: string;
    operationClass?: string;
    context: BtrfsMutationContext;
  },
): Promise<void> | void {
  if (btrfsQuotasDisabled()) {
    return wait ? Promise.resolve() : undefined;
  }
  ensureQueueTable();
  const now = Date.now();
  const effectiveContext = effectiveBtrfsMutationContext(context);
  const basePriority =
    PRIORITY_VALUE[effectiveContext.priority ?? "interactive"];
  const existing = db()
    .prepare(
      `SELECT id, base_priority FROM ${TABLE} WHERE status='queued' AND logical_key=?`,
    )
    .get(logicalKey) as { id: string; base_priority: number } | undefined;
  const id = existing?.id ?? randomUUID();
  if (existing) {
    db()
      .prepare(
        `
          UPDATE ${TABLE}
          SET mount=?,
              kind=?,
              payload=?,
              available_at=MIN(available_at, ?),
              project_id=?,
              volume_kind=?,
              operation_id=?,
              operation_class=?,
              base_priority=MIN(base_priority, ?),
              context_json=?,
              last_coalesced_at=?,
              coalesced_count=coalesced_count + 1,
              last_error=NULL
          WHERE id=?
        `,
      )
      .run(
        payload.mount,
        payload.kind,
        JSON.stringify(payload),
        now,
        projectId ?? effectiveContext.project_id ?? null,
        volumeKind ?? null,
        operationId ?? effectiveContext.operation_id ?? null,
        operationClass ?? effectiveContext.operation_class ?? null,
        basePriority,
        JSON.stringify(effectiveContext),
        now,
        id,
      );
  } else {
    db()
      .prepare(
        `
        INSERT INTO ${TABLE} (
          id, mount, kind, payload, status, created_at, available_at, attempts,
          logical_key, project_id, volume_kind, operation_id, operation_class,
          base_priority, context_json, first_enqueued_at, last_coalesced_at,
          coalesced_count
        )
        VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `,
      )
      .run(
        id,
        payload.mount,
        payload.kind,
        JSON.stringify(payload),
        now,
        now,
        logicalKey,
        projectId ?? effectiveContext.project_id ?? null,
        volumeKind ?? null,
        operationId ?? effectiveContext.operation_id ?? null,
        operationClass ?? effectiveContext.operation_class ?? null,
        basePriority,
        JSON.stringify(effectiveContext),
        now,
        now,
      );
  }
  scheduleWake(0);
  if (!wait) return;
  return new Promise<void>((resolve, reject) => {
    addWaiter(id, { resolve, reject });
  });
}

export function startBtrfsQuotaQueue(): void {
  if (btrfsQuotasDisabled()) {
    return;
  }
  ensureQueueTable();
  scheduleWake(0);
}

export function queueSetSubvolumeQuota(opts: {
  mount: string;
  path: string;
  size: string | number;
  wait?: boolean;
  project_id?: string;
  volume_kind?: string;
  operation_id?: string;
  operation_class?: string;
  priority?: BtrfsMutationPriority;
  context?: BtrfsMutationContext;
}): Promise<void> | void {
  const context = effectiveBtrfsMutationContext({
    ...(opts.context ?? {}),
    project_id: opts.project_id ?? opts.context?.project_id,
    operation_id: opts.operation_id ?? opts.context?.operation_id,
    operation_class: opts.operation_class ?? opts.context?.operation_class,
    priority: opts.priority ?? opts.context?.priority,
  });
  return enqueueRow(
    {
      mount: opts.mount,
      kind: "set_subvolume_limit",
      path: opts.path,
      size: `${opts.size}`,
    },
    {
      wait: opts.wait ?? true,
      logicalKey: `${opts.mount}\0${opts.path}`,
      projectId: opts.project_id,
      volumeKind: opts.volume_kind,
      operationId: opts.operation_id,
      operationClass: opts.operation_class,
      context,
    },
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
  const where = mount ? `WHERE mount = ${quoteIdent(mount)}` : "";
  const rows = db()
    .prepare(
      `
        SELECT *
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
          project_id: row.project_id,
          volume_kind: row.volume_kind,
          operation_id: row.operation_id,
          operation_class: row.operation_class,
          priority: priorityName(row.base_priority),
          queue_wait_ms:
            (row.claimed_at ?? row.started_at ?? now) - row.first_enqueued_at,
          lock_wait_ms:
            row.lock_acquired_at != null && row.claimed_at != null
              ? row.lock_acquired_at - row.claimed_at
              : undefined,
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
    mode: "simple",
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
