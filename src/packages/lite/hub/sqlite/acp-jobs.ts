import type { TurnOutcome } from "@cocalc/conat/ai/acp/turn-outcome";
import type { AcpJobRequest } from "@cocalc/conat/ai/acp/types";
import type { CodexPaymentSourcePreference } from "@cocalc/util/ai/codex";
import {
  codexModelRecoveryConfig,
  unavailableChatGptCodexModel,
} from "@cocalc/util/ai/codex-model-recovery";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";
import { upsertAcpSessionFromJob } from "./acp-sessions";

import { installThreadSuccessorFence } from "./acp-thread-successors";

const TABLE = "acp_jobs";
export const ACP_PROJECT_RESTART_FENCE_REASON =
  "project restart security fence";
// A restart, or a project runtime lost to a crash, fences running work like a
// stop but resumes it once the project runs again.
export const ACP_PROJECT_RESUME_FENCE_REASON =
  "project restarted; work resumes when it runs again";
export const ACP_PROJECT_RUNTIME_LOST_FENCE_REASON =
  "project stopped unexpectedly; work resumes when it runs again";

// What a project fence still owes a job, kept in recovery_code so it survives
// worker and project-host restarts. Distinct from failure recovery intents,
// which listAcpJobsWithRecoveryIntent excludes these from.
export const ACP_FENCE_INTENT_PREFIX = "fence:";
export const ACP_FENCE_INTENT_RESUME_PENDING = "fence:resume-pending";
export const ACP_FENCE_INTENT_RESUME_READY = "fence:resume-ready";
// Claimed by the follow-up that is enqueuing the resumed turn right now.
export const ACP_FENCE_INTENT_RESUMING = "fence:resuming";
export const ACP_FENCE_INTENT_STOPPED = "fence:stopped";
// Intents that still mean "this work may run again".
const ACP_FENCE_LIVE_RESUME_INTENTS = [
  ACP_FENCE_INTENT_RESUME_PENDING,
  ACP_FENCE_INTENT_RESUME_READY,
  ACP_FENCE_INTENT_RESUMING,
];
const LIVE_RESUME_PLACEHOLDERS = ACP_FENCE_LIVE_RESUME_INTENTS.map(
  () => "?",
).join(", ");
// The error of a held message the user canceled: never adopted by a fence.
export const ACP_FENCED_JOB_CANCELED_ERROR = "canceled while held by a restart";
// recovery_detail of a pending resume once its chat shows the interruption.
export const ACP_FENCE_CHAT_FINALIZED = "chat-finalized";
const THREAD_QUEUE_ORDER = `
priority DESC,
CASE WHEN priority > 0 THEN updated_at END DESC,
created_at ASC
`;

export type AcpJobState =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "canceled"
  | "interrupted";

export interface AcpJobRow {
  op_id: string;
  project_id: string;
  account_id?: string | null;
  path: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  assistant_message_date: string;
  session_id?: string | null;
  state: AcpJobState;
  available_at?: number | null;
  send_mode?: "immediate" | null;
  priority: number;
  worker_id?: string | null;
  worker_bundle_version?: string | null;
  recovery_parent_op_id?: string | null;
  recovery_reason?: string | null;
  recovery_count?: number | null;
  recovery_code?: string | null;
  recovery_detail?: string | null;
  /** How the turn ended (conat/ai/acp/turn-outcome.ts), as JSON. */
  outcome_json?: string | null;
  request_json: string;
  error?: string | null;
  created_at: number;
  updated_at: number;
  started_at?: number | null;
  finished_at?: number | null;
}

export type AcpJobSupersessionGuard = {
  source_op_id: string;
  source_created_at: number;
};

type EnqueueAcpJobOptions = {
  preferred_worker_id?: string | null;
  available_at?: number | null;
  reject_if_newer_non_recovery_than?: AcpJobSupersessionGuard;
  /** Insert only while the recovery parent still holds this fence intent,
   * in the same transaction, so a fence that wins cannot be outrun. */
  require_parent_fence_intent?: string;
};

function init(): void {
  const db = getAcpDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      op_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      assistant_message_date TEXT NOT NULL,
      session_id TEXT,
      state TEXT NOT NULL,
      available_at INTEGER,
      send_mode TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      worker_bundle_version TEXT,
      recovery_parent_op_id TEXT,
      recovery_reason TEXT,
      recovery_count INTEGER,
      recovery_code TEXT,
      recovery_detail TEXT,
      outcome_json TEXT,
      request_json TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      UNIQUE(project_id, path, user_message_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_thread_state_idx ON ${TABLE}(project_id, path, thread_id, state, priority, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_state_updated_idx ON ${TABLE}(state, updated_at)`,
  );
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const hasColumn = (name: string): boolean =>
    columns.some((x) => x?.name === name);
  if (!hasColumn("worker_id")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN worker_id TEXT`);
  }
  if (!hasColumn("account_id")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN account_id TEXT`);
  }
  if (!hasColumn("worker_bundle_version")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN worker_bundle_version TEXT`);
  }
  if (!hasColumn("recovery_parent_op_id")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN recovery_parent_op_id TEXT`);
  }
  if (!hasColumn("recovery_reason")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN recovery_reason TEXT`);
  }
  if (!hasColumn("recovery_count")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN recovery_count INTEGER`);
  }
  if (!hasColumn("available_at")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN available_at INTEGER`);
  }
  if (!hasColumn("recovery_code")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN recovery_code TEXT`);
  }
  if (!hasColumn("recovery_detail")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN recovery_detail TEXT`);
  }
  if (!hasColumn("outcome_json")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN outcome_json TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_recovery_parent_idx ON ${TABLE}(recovery_parent_op_id, state, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_account_state_idx ON ${TABLE}(account_id, state, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_project_state_idx ON ${TABLE}(project_id, state, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_state_available_idx ON ${TABLE}(state, available_at, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_worker_updated_idx ON ${TABLE}(worker_id, updated_at)`,
  );
  ensureAcpTableMigrated(TABLE);
  installThreadSuccessorFence(TABLE);
  removeRetiredAutomationJobs(db);
}

/**
 * Scheduled thread automations were retired for agent sensors. Their jobs
 * (agent turns and shell commands) wrote their results to the chats
 * already; nothing may run, recover or retry them, and their settings table
 * is no longer read.
 */
export function removeRetiredAutomationJobs(
  db: ReturnType<typeof getAcpDatabase>,
): void {
  db.exec(
    `DELETE FROM ${TABLE}
     WHERE json_extract(request_json, '$.request_kind') = 'command'
        OR json_extract(request_json, '$.chat.automation_id') IS NOT NULL`,
  );
  db.exec("DROP TABLE IF EXISTS acp_automations");
}

let initialized = false;

function ensureInit(): void {
  if (!initialized) {
    init();
    initialized = true;
  }
}

function mirrorAcpJobSession(row: AcpJobRow | undefined): void {
  if (!row) return;
  upsertAcpSessionFromJob(row);
}

function normalizeRequest(request: AcpJobRequest): AcpJobRequest {
  return {
    ...request,
    request_kind: request.request_kind ?? "codex",
    runtime_env: undefined,
  };
}

function assertChatIdentity(request: AcpJobRequest): {
  project_id: string;
  account_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  assistant_message_date: string;
} {
  const project_id =
    `${request.chat?.project_id ?? request.project_id ?? ""}`.trim();
  const account_id = `${request.account_id ?? ""}`.trim();
  const path = `${request.chat?.path ?? ""}`.trim();
  const thread_id = `${request.chat?.thread_id ?? ""}`.trim();
  const user_message_id = `${request.chat?.parent_message_id ?? ""}`.trim();
  const assistant_message_id = `${request.chat?.message_id ?? ""}`.trim();
  const assistant_message_date = `${request.chat?.message_date ?? ""}`.trim();
  if (!project_id || !account_id || !path || !thread_id || !user_message_id) {
    throw new Error("acp job is missing required chat identity");
  }
  if (!assistant_message_id || !assistant_message_date) {
    throw new Error("acp job is missing assistant turn identity");
  }
  return {
    project_id,
    account_id,
    path,
    thread_id,
    user_message_id,
    assistant_message_id,
    assistant_message_date,
  };
}

function hasNewerNonRecoveryAcpJobInDatabase({
  db,
  project_id,
  path,
  thread_id,
  guard,
}: {
  db: ReturnType<typeof getAcpDatabase>;
  project_id: string;
  path: string;
  thread_id: string;
  guard: AcpJobSupersessionGuard;
}): boolean {
  const source = db
    .prepare(`SELECT rowid AS sequence FROM ${TABLE} WHERE op_id = ?`)
    .get(guard.source_op_id) as { sequence?: number } | undefined;
  const sourceSequence = Number(source?.sequence);
  if (!Number.isFinite(sourceSequence)) {
    return false;
  }
  // A message that was canceled never runs, so it supersedes nothing; one a
  // restart holds (a live resume intent) may still run.  A stop's intent
  // (fence:stopped) only tells the sender; that message never runs either.
  const row = db
    .prepare(
      `SELECT 1
       FROM ${TABLE}
       WHERE project_id = ?
         AND path = ?
         AND thread_id = ?
         AND recovery_parent_op_id IS NULL
         AND rowid > ?
         AND (
           state != 'canceled'
           OR recovery_code IN (${LIVE_RESUME_PLACEHOLDERS})
         )
       LIMIT 1`,
    )
    .get(
      project_id,
      path,
      thread_id,
      sourceSequence,
      ...ACP_FENCE_LIVE_RESUME_INTENTS,
    );
  return row != null;
}

export function hasNewerNonRecoveryAcpJob({
  project_id,
  path,
  thread_id,
  guard,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  guard: AcpJobSupersessionGuard;
}): boolean {
  ensureInit();
  return hasNewerNonRecoveryAcpJobInDatabase({
    db: getAcpDatabase(),
    project_id,
    path,
    thread_id,
    guard,
  });
}

export function enqueueAcpJob(
  request: AcpJobRequest,
  opts: EnqueueAcpJobOptions & {
    reject_if_newer_non_recovery_than: AcpJobSupersessionGuard;
  },
): AcpJobRow | undefined;
export function enqueueAcpJob(
  request: AcpJobRequest,
  opts?: EnqueueAcpJobOptions,
): AcpJobRow;
export function enqueueAcpJob(
  request: AcpJobRequest,
  opts: EnqueueAcpJobOptions = {},
): AcpJobRow | undefined {
  ensureInit();
  const db = getAcpDatabase();
  const {
    project_id,
    account_id,
    path,
    thread_id,
    user_message_id,
    assistant_message_id,
    assistant_message_date,
  } = assertChatIdentity(request);
  const now = Date.now();
  const requestedAvailableAt = Number(opts.available_at);
  const available_at =
    Number.isFinite(requestedAvailableAt) && requestedAvailableAt > now
      ? Math.floor(requestedAvailableAt)
      : null;
  const op_id = assistant_message_id;
  const send_mode = request.chat?.send_mode ?? null;
  const priority = send_mode === "immediate" ? 1 : 0;
  const request_json = JSON.stringify(normalizeRequest(request));
  const recovery_parent_op_id =
    `${request.recovery_parent_op_id ?? ""}`.trim() || null;
  const recovery_reason = `${request.recovery_reason ?? ""}`.trim() || null;
  const recovery_count = Number.isFinite(Number(request.recovery_count))
    ? Math.max(1, Math.floor(Number(request.recovery_count)))
    : null;
  const insert = () =>
    db
      .prepare(
        `INSERT INTO ${TABLE}
        (op_id, project_id, account_id, path, thread_id, user_message_id, assistant_message_id, assistant_message_date, session_id, state, available_at, send_mode, priority, worker_id, worker_bundle_version, recovery_parent_op_id, recovery_reason, recovery_count, request_json, error, created_at, updated_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)
        ON CONFLICT(project_id, path, user_message_id) DO UPDATE SET
          account_id = excluded.account_id,
          send_mode = COALESCE(excluded.send_mode, ${TABLE}.send_mode),
          priority = MAX(${TABLE}.priority, excluded.priority),
          worker_id = COALESCE(${TABLE}.worker_id, excluded.worker_id),
          updated_at = excluded.updated_at`,
      )
      .run(
        op_id,
        project_id,
        account_id,
        path,
        thread_id,
        user_message_id,
        assistant_message_id,
        assistant_message_date,
        request.session_id ?? null,
        available_at,
        send_mode,
        priority,
        `${opts.preferred_worker_id ?? ""}`.trim() || null,
        recovery_parent_op_id,
        recovery_reason,
        recovery_count,
        request_json,
        now,
        now,
      );
  const loadInsertedJob = () =>
    db
      .prepare(
        `SELECT * FROM ${TABLE}
         WHERE project_id = ? AND path = ? AND user_message_id = ?`,
      )
      .get(project_id, path, user_message_id) as AcpJobRow | undefined;
  const guard = opts.reject_if_newer_non_recovery_than;
  const parentIntent = `${opts.require_parent_fence_intent ?? ""}`.trim();
  let job: AcpJobRow | undefined;
  if (guard || parentIntent) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (
        (guard &&
          hasNewerNonRecoveryAcpJobInDatabase({
            db,
            project_id,
            path,
            thread_id,
            guard,
          })) ||
        (parentIntent &&
          (
            db
              .prepare(`SELECT recovery_code FROM ${TABLE} WHERE op_id = ?`)
              .get(recovery_parent_op_id ?? "") as
              | { recovery_code?: string | null }
              | undefined
          )?.recovery_code !== parentIntent)
      ) {
        db.exec("COMMIT");
        return undefined;
      }
      insert();
      job = loadInsertedJob();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } else {
    insert();
    job = loadInsertedJob();
  }
  if (!job) {
    throw new Error("failed to enqueue ACP job");
  }
  mirrorAcpJobSession(job);
  return job;
}

export function getAcpJobByOpId(op_id: string): AcpJobRow | undefined {
  ensureInit();
  const db = getAcpDatabase();
  return db.prepare(`SELECT * FROM ${TABLE} WHERE op_id = ?`).get(op_id) as
    | AcpJobRow
    | undefined;
}

export function listAcpJobsByRecoveryParent({
  recovery_parent_op_id,
}: {
  recovery_parent_op_id: string;
}): AcpJobRow[] {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE recovery_parent_op_id = ?
       ORDER BY created_at ASC`,
    )
    .all(recovery_parent_op_id) as AcpJobRow[];
}

export function getAcpJob({
  project_id,
  path,
  user_message_id,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
}): AcpJobRow | undefined {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ? AND path = ? AND user_message_id = ?`,
    )
    .get(project_id, path, user_message_id) as AcpJobRow | undefined;
}

export function listQueuedAcpJobs(): AcpJobRow[] {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE state = 'queued'
       ORDER BY created_at ASC`,
    )
    .all() as AcpJobRow[];
}

/** Private admission history, never a credential selected by shared chat rows. */
export function latestHumanHarnessJob({
  project_id,
  account_id,
  path,
  thread_id,
}: {
  project_id: string;
  account_id: string;
  path: string;
  thread_id: string;
}): AcpJobRow | undefined {
  ensureInit();
  return getAcpDatabase()
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ? AND account_id = ? AND path = ? AND thread_id = ?
         AND json_extract(request_json, '$.runtime.kind') = 'acp'
         AND json_extract(request_json, '$.chat.agent_message') IS NOT 1
         AND json_extract(request_json, '$.chat.agent_rpc_execution') IS NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(project_id, account_id, path, thread_id) as AcpJobRow | undefined;
}

export function listQueuedAcpJobThreadKeys(): Pick<
  AcpJobRow,
  "project_id" | "path" | "thread_id"
>[] {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT project_id, path, thread_id
       FROM ${TABLE}
       WHERE state = 'queued'
         AND (available_at IS NULL OR available_at <= ?)
       GROUP BY project_id, path, thread_id
       ORDER BY MAX(priority) DESC, MIN(created_at) ASC`,
    )
    .all(Date.now()) as Pick<AcpJobRow, "project_id" | "path" | "thread_id">[];
}

export function hasQueuedOrRunningAcpJobs(): boolean {
  ensureInit();
  const db = getAcpDatabase();
  return (
    db
      .prepare(
        `SELECT 1
         FROM ${TABLE}
         WHERE state IN ('queued', 'running')
         LIMIT 1`,
      )
      .get() != null
  );
}

export function oldestQueuedAcpJobTimestamp(): number | undefined {
  ensureInit();
  const db = getAcpDatabase();
  const row = db
    .prepare(
      `SELECT MIN(
         CASE
           WHEN updated_at IS NOT NULL AND updated_at > 0 THEN updated_at
           ELSE created_at
         END
       ) AS oldest
       FROM ${TABLE}
       WHERE state = 'queued'
         AND (available_at IS NULL OR available_at <= ?)`,
    )
    .get(Date.now()) as { oldest?: number | null } | undefined;
  const oldest = Number(row?.oldest ?? 0);
  return Number.isFinite(oldest) && oldest > 0 ? oldest : undefined;
}

export function oldestClaimableQueuedAcpJobTimestamp({
  worker_id,
  include_unassigned,
  known_worker_ids,
  reclaimable_worker_ids,
}: {
  worker_id: string;
  include_unassigned: boolean;
  known_worker_ids?: string[];
  reclaimable_worker_ids?: string[];
}): number | undefined {
  const workerId = `${worker_id ?? ""}`.trim();
  if (!workerId) return undefined;
  ensureInit();
  const knownWorkerIds = Array.from(
    new Set(
      (known_worker_ids ?? []).map((id) => `${id}`.trim()).filter(Boolean),
    ),
  );
  const reclaimableWorkerIds = Array.from(
    new Set(
      (reclaimable_worker_ids ?? [])
        .map((id) => `${id}`.trim())
        .filter(Boolean),
    ),
  );
  const reclaimableSql = reclaimableWorkerIds.length
    ? `OR head.worker_id IN (${reclaimableWorkerIds.map(() => "?").join(", ")})`
    : "";
  const missingSql = known_worker_ids
    ? knownWorkerIds.length
      ? `OR head.worker_id NOT IN (${knownWorkerIds.map(() => "?").join(", ")})`
      : "OR (head.worker_id IS NOT NULL AND TRIM(head.worker_id) != '')"
    : "";
  // The queue pump only considers the first due job in each thread. A later
  // unassigned job is not claimable while another worker owns the thread head.
  const row = getAcpDatabase()
    .prepare(
      `WITH due AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY project_id, path, thread_id
                  ORDER BY ${THREAD_QUEUE_ORDER}
                ) AS thread_position
         FROM ${TABLE}
         WHERE state = 'queued'
           AND (available_at IS NULL OR available_at <= ?)
       )
       SELECT MIN(
         CASE
           WHEN updated_at IS NOT NULL AND updated_at > 0 THEN updated_at
           ELSE created_at
         END
       ) AS oldest
       FROM due AS head
       WHERE thread_position = 1
         AND (
           head.worker_id = ?
           OR (? = 1 AND (
             head.worker_id IS NULL
             OR TRIM(head.worker_id) = ''
             ${reclaimableSql}
             ${missingSql}
           ))
         )`,
    )
    .get(
      Date.now(),
      workerId,
      include_unassigned ? 1 : 0,
      ...reclaimableWorkerIds,
      ...knownWorkerIds,
    ) as { oldest?: number | null } | undefined;
  const oldest = Number(row?.oldest ?? 0);
  return Number.isFinite(oldest) && oldest > 0 ? oldest : undefined;
}

export function latestAcpJobUpdateForWorker(
  worker_id: string,
): number | undefined {
  const workerId = `${worker_id ?? ""}`.trim();
  if (!workerId) return undefined;
  ensureInit();
  const row = getAcpDatabase()
    .prepare(
      `SELECT MAX(updated_at) AS latest
       FROM ${TABLE}
       WHERE worker_id = ?`,
    )
    .get(workerId) as { latest?: number | null } | undefined;
  const latest = Number(row?.latest ?? 0);
  return Number.isFinite(latest) && latest > 0 ? latest : undefined;
}

export function nextQueuedAcpJobAvailability(): number | undefined {
  ensureInit();
  const now = Date.now();
  const row = getAcpDatabase()
    .prepare(
      `SELECT MIN(available_at) AS available_at
       FROM ${TABLE}
       WHERE state = 'queued'
         AND available_at > ?`,
    )
    .get(now) as { available_at?: number | null } | undefined;
  const availableAt = Number(row?.available_at ?? 0);
  return Number.isFinite(availableAt) && availableAt > now
    ? availableAt
    : undefined;
}

function countAcpJobsByWhere(where: string, args: unknown[]): number {
  ensureInit();
  const db = getAcpDatabase();
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${TABLE} ${where}`)
    .get(...args) as { count?: number } | undefined;
  return Number(row?.count ?? 0) || 0;
}

export function countQueuedAcpJobsForAccount(
  account_id: string,
  excludeRecoveryForThread?: {
    project_id: string;
    path: string;
    thread_id: string;
  },
): number {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) return 0;
  if (excludeRecoveryForThread) {
    return countAcpJobsByWhere(
      `WHERE account_id = ?
         AND state = 'queued'
         AND NOT (
           recovery_parent_op_id IS NOT NULL
           AND project_id = ?
           AND path = ?
           AND thread_id = ?
         )`,
      [
        accountId,
        excludeRecoveryForThread.project_id,
        excludeRecoveryForThread.path,
        excludeRecoveryForThread.thread_id,
      ],
    );
  }
  return countAcpJobsByWhere(`WHERE account_id = ? AND state = 'queued'`, [
    accountId,
  ]);
}

export function countRunningAcpJobsForAccount(account_id: string): number {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) return 0;
  return countAcpJobsByWhere(`WHERE account_id = ? AND state = 'running'`, [
    accountId,
  ]);
}

export function countRunningAcpJobsForProject(project_id: string): number {
  const projectId = `${project_id ?? ""}`.trim();
  if (!projectId) return 0;
  return countAcpJobsByWhere(`WHERE project_id = ? AND state = 'running'`, [
    projectId,
  ]);
}

export function countCreatedAcpJobsForAccountSince({
  account_id,
  since,
  includeRecovery = false,
}: {
  account_id: string;
  since: number;
  includeRecovery?: boolean;
}): number {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) return 0;
  const recoveryClause = includeRecovery
    ? ""
    : "AND recovery_parent_op_id IS NULL";
  return countAcpJobsByWhere(
    `WHERE account_id = ? AND created_at >= ? ${recoveryClause}`,
    [accountId, since],
  );
}

export function listRunningAcpJobs(): AcpJobRow[] {
  ensureInit();
  return listRunningAcpJobsByWorker();
}

export function listRunningAcpJobsByWorker(worker_id?: string): AcpJobRow[] {
  ensureInit();
  const db = getAcpDatabase();
  if (`${worker_id ?? ""}`.trim()) {
    return db
      .prepare(
        `SELECT * FROM ${TABLE}
         WHERE state = 'running'
           AND worker_id = ?
         ORDER BY started_at ASC, created_at ASC`,
      )
      .all(worker_id) as AcpJobRow[];
  }
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE state = 'running'
       ORDER BY started_at ASC, created_at ASC`,
    )
    .all() as AcpJobRow[];
}

export function countRunningAcpJobsForWorker(worker_id: string): number {
  ensureInit();
  const db = getAcpDatabase();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ${TABLE}
       WHERE state = 'running'
         AND worker_id = ?`,
    )
    .get(worker_id) as { count?: number } | undefined;
  return Number(row?.count ?? 0) || 0;
}

export function countQueuedAcpJobsForThread({
  project_id,
  path,
  thread_id,
  includeRecovery = true,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  includeRecovery?: boolean;
}): number {
  const recoveryClause = includeRecovery
    ? ""
    : "AND recovery_parent_op_id IS NULL";
  return countAcpJobsByWhere(
    `WHERE project_id = ?
       AND path = ?
       AND thread_id = ?
       AND state = 'queued'
       ${recoveryClause}`,
    [project_id, path, thread_id],
  );
}

export function hasRunningAcpJobForThread({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): boolean {
  ensureInit();
  const db = getAcpDatabase();
  return (
    db
      .prepare(
        `SELECT 1
         FROM ${TABLE}
         WHERE project_id = ?
           AND path = ?
           AND thread_id = ?
           AND state = 'running'
         LIMIT 1`,
      )
      .get(project_id, path, thread_id) != null
  );
}

export function listQueuedAcpJobsForThread({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): AcpJobRow[] {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ?
         AND path = ?
         AND thread_id = ?
         AND state = 'queued'
       ORDER BY ${THREAD_QUEUE_ORDER}`,
    )
    .all(project_id, path, thread_id) as AcpJobRow[];
}

export function claimNextQueuedAcpJobForThread({
  project_id,
  path,
  thread_id,
  worker_id,
  worker_bundle_version,
  max_running_for_account,
  max_running_for_project,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  worker_id?: string;
  worker_bundle_version?: string;
  max_running_for_account?: number;
  max_running_for_project?: number;
}): AcpJobRow | undefined {
  ensureInit();
  const db = getAcpDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const running = db
      .prepare(
        `SELECT op_id FROM ${TABLE}
         WHERE project_id = ?
           AND path = ?
           AND thread_id = ?
           AND state = 'running'
         LIMIT 1`,
      )
      .get(project_id, path, thread_id) as { op_id?: string } | undefined;
    if (running?.op_id) {
      db.exec("COMMIT");
      return undefined;
    }
    const next = db
      .prepare(
        `SELECT * FROM ${TABLE}
       WHERE project_id = ?
         AND path = ?
         AND thread_id = ?
         AND state = 'queued'
         AND (available_at IS NULL OR available_at <= ?)
         AND (worker_id IS NULL OR worker_id = ?)
       ORDER BY ${THREAD_QUEUE_ORDER}
       LIMIT 1`,
      )
      .get(
        project_id,
        path,
        thread_id,
        Date.now(),
        worker_id?.trim() || null,
      ) as AcpJobRow | undefined;
    if (!next) {
      db.exec("COMMIT");
      return undefined;
    }
    const maxProject = Number(max_running_for_project);
    if (
      Number.isFinite(maxProject) &&
      maxProject >= 0 &&
      countRunningAcpJobsForProject(project_id) >= maxProject
    ) {
      db.exec("COMMIT");
      return undefined;
    }
    const accountId = `${next.account_id ?? ""}`.trim();
    const maxAccount = Number(max_running_for_account);
    if (
      accountId &&
      Number.isFinite(maxAccount) &&
      maxAccount >= 0 &&
      countRunningAcpJobsForAccount(accountId) >= maxAccount
    ) {
      db.exec("COMMIT");
      return undefined;
    }
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE ${TABLE}
          SET state = 'running',
              available_at = NULL,
              started_at = ?,
              updated_at = ?,
              error = NULL,
              -- Each attempt ends with its own outcome, never a resent
              -- attempt's earlier one.
              outcome_json = NULL,
              worker_id = ?,
              worker_bundle_version = ?
          WHERE op_id = ?
            AND state = 'queued'`,
      )
      .run(
        now,
        now,
        worker_id?.trim() || null,
        worker_bundle_version?.trim() || null,
        next.op_id,
      );
    if (result.changes === 0) {
      db.exec("COMMIT");
      return undefined;
    }
    const claimed = db
      .prepare(`SELECT * FROM ${TABLE} WHERE op_id = ?`)
      .get(next.op_id) as AcpJobRow | undefined;
    db.exec("COMMIT");
    mirrorAcpJobSession(claimed);
    return claimed;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function setAcpJobState({
  op_id,
  state,
  error,
  worker_id,
  recovery_code,
  recovery_detail,
  outcome,
  onlyIfRunning = false,
}: {
  op_id: string;
  state: Exclude<AcpJobState, "queued" | "running">;
  error?: string;
  worker_id?: string;
  recovery_code?: string;
  recovery_detail?: string;
  outcome?: TurnOutcome;
  /** End only a running job: one a fence or cancel already ended stays so. */
  onlyIfRunning?: boolean;
}): boolean {
  const outcome_json = outcome ? JSON.stringify(outcome) : null;
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  if (`${worker_id ?? ""}`.trim()) {
    const { changes } = db
      .prepare(
        `UPDATE ${TABLE}
        SET state = ?,
            error = COALESCE(?, error),
            recovery_code = COALESCE(?, recovery_code),
            recovery_detail = COALESCE(?, recovery_detail),
            outcome_json = COALESCE(?, outcome_json),
            updated_at = ?,
            finished_at = ?
        WHERE op_id = ?
          AND state = 'running'
          AND (worker_id IS NULL OR worker_id = ?)`,
      )
      .run(
        state,
        error ?? null,
        recovery_code ?? null,
        recovery_detail ?? null,
        outcome_json,
        now,
        now,
        op_id,
        worker_id,
      );
    mirrorAcpJobSession(getAcpJobByOpId(op_id));
    return changes > 0;
  }
  const { changes } = db
    .prepare(
      `UPDATE ${TABLE}
      SET state = ?,
          error = COALESCE(?, error),
          recovery_code = COALESCE(?, recovery_code),
          recovery_detail = COALESCE(?, recovery_detail),
          outcome_json = COALESCE(?, outcome_json),
          updated_at = ?,
          finished_at = ?
      WHERE op_id = ?${onlyIfRunning ? " AND state = 'running'" : ""}`,
    )
    .run(
      state,
      error ?? null,
      recovery_code ?? null,
      recovery_detail ?? null,
      outcome_json,
      now,
      now,
      op_id,
    );
  mirrorAcpJobSession(getAcpJobByOpId(op_id));
  return changes > 0;
}

/** How a job ended, for the paths that end it without running it. */
export function recordAcpJobOutcome(op_id: string, outcome: TurnOutcome): void {
  ensureInit();
  getAcpDatabase()
    .prepare(`UPDATE ${TABLE} SET outcome_json = ? WHERE op_id = ?`)
    .run(JSON.stringify(outcome), op_id);
}

export function listAcpJobsWithRecoveryIntent(limit = 100): AcpJobRow[] {
  ensureInit();
  return getAcpDatabase()
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE state = 'error'
         AND recovery_code IS NOT NULL
         AND substr(recovery_code, 1, ${ACP_FENCE_INTENT_PREFIX.length}) != ?
       ORDER BY finished_at ASC, created_at ASC
       LIMIT ?`,
    )
    .all(
      ACP_FENCE_INTENT_PREFIX,
      Math.max(1, Math.floor(limit)),
    ) as AcpJobRow[];
}

/** Fence intents with work to do now, least recently attempted first: a
 * pending resume only until its chat shows the interruption (or it expires),
 * and a claimed resume only once its claim is stale. */
export function listAcpJobsWithFenceIntent({
  limit = 100,
  now = Date.now(),
  pendingMaxAgeMs,
  resumingStaleMs,
}: {
  limit?: number;
  now?: number;
  pendingMaxAgeMs: number;
  resumingStaleMs: number;
}): AcpJobRow[] {
  ensureInit();
  return getAcpDatabase()
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE recovery_code IN (?, ?)
          OR (recovery_code = ? AND updated_at < ?)
          OR (recovery_code = ?
              AND (recovery_detail IS NULL OR finished_at < ?))
       ORDER BY updated_at ASC, op_id ASC
       LIMIT ?`,
    )
    .all(
      ACP_FENCE_INTENT_RESUME_READY,
      ACP_FENCE_INTENT_STOPPED,
      ACP_FENCE_INTENT_RESUMING,
      now - Math.max(0, resumingStaleMs),
      ACP_FENCE_INTENT_RESUME_PENDING,
      now - Math.max(0, pendingMaxAgeMs),
      Math.max(1, Math.floor(limit)),
    ) as AcpJobRow[];
}

/** Whether a restart still holds this job to resume it. */
export function acpJobHasLiveFenceResume(
  job: Pick<AcpJobRow, "recovery_code"> | undefined,
): boolean {
  return ACP_FENCE_LIVE_RESUME_INTENTS.includes(`${job?.recovery_code ?? ""}`);
}

/** Old workers fence without intents: adopt the rows this fence just
 * terminalized (its reason, since it started) so they are not lost. */
export function adoptAcpJobsFencedWithoutIntent({
  project_id,
  reason,
  since,
  resume = false,
}: {
  project_id: string;
  reason: string;
  since: number;
  resume?: boolean;
}): number {
  ensureInit();
  return getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET recovery_code = ?,
           recovery_detail = CASE WHEN ? AND state = 'canceled' THEN ? ELSE NULL END,
           updated_at = ?
       WHERE project_id = ?
         AND error = ?
         AND recovery_code IS NULL
         AND finished_at >= ?
         AND state IN ('canceled', 'interrupted', 'error')`,
    )
    .run(
      resume ? ACP_FENCE_INTENT_RESUME_PENDING : ACP_FENCE_INTENT_STOPPED,
      resume ? 1 : 0,
      ACP_FENCE_CHAT_FINALIZED,
      Date.now(),
      project_id,
      reason,
      since,
    ).changes;
}

/** Atomically move a job's fence intent; false if another pass moved it. */
export function moveAcpJobFenceIntent({
  op_id,
  from,
  to,
  detail,
}: {
  op_id: string;
  from: string;
  to: string | null;
  detail?: string | null;
}): boolean {
  ensureInit();
  return (
    getAcpDatabase()
      .prepare(
        `UPDATE ${TABLE}
         SET recovery_code = ?,
             recovery_detail = CASE WHEN ? THEN ? ELSE recovery_detail END,
             updated_at = ?
         WHERE op_id = ? AND recovery_code = ?`,
      )
      .run(
        to,
        detail === undefined ? 0 : 1,
        detail ?? null,
        Date.now(),
        op_id,
        from,
      ).changes === 1
  );
}

/**
 * A fenced turn's resume found newer messages that run instead.  The check ran
 * before the chat was updated, so recheck it in the same transaction that
 * ends the resume: if those messages were canceled meanwhile, hand the resume
 * back ("resume") instead of ending it.  "lost": the claim is no longer ours.
 */
export function finishSupersededFencedResume({
  op_id,
  project_id,
  path,
  thread_id,
  guard,
}: {
  op_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  guard: AcpJobSupersessionGuard;
}): "finished" | "resume" | "lost" {
  ensureInit();
  const db = getAcpDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare(`SELECT recovery_code FROM ${TABLE} WHERE op_id = ?`)
      .get(op_id) as { recovery_code?: string | null } | undefined;
    if (current?.recovery_code !== ACP_FENCE_INTENT_RESUMING) {
      db.exec("COMMIT");
      return "lost";
    }
    const superseded = hasNewerNonRecoveryAcpJobInDatabase({
      db,
      project_id,
      path,
      thread_id,
      guard,
    });
    db.prepare(
      `UPDATE ${TABLE}
       SET recovery_code = ?, updated_at = ?
       WHERE op_id = ? AND recovery_code = ?`,
    ).run(
      superseded ? null : ACP_FENCE_INTENT_RESUME_READY,
      Date.now(),
      op_id,
      ACP_FENCE_INTENT_RESUMING,
    );
    db.exec("COMMIT");
    return superseded ? "finished" : "resume";
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** The project runs again: resumes fenced within maxAgeMs become ready. */
export function releaseAcpProjectFenceResumes({
  project_id,
  maxAgeMs,
  now = Date.now(),
}: {
  project_id: string;
  maxAgeMs: number;
  now?: number;
}): number {
  ensureInit();
  return getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET recovery_code = ?,
           updated_at = ?
       WHERE project_id = ?
         AND recovery_code = ?
         AND finished_at >= ?`,
    )
    .run(
      ACP_FENCE_INTENT_RESUME_READY,
      now,
      project_id,
      ACP_FENCE_INTENT_RESUME_PENDING,
      now - Math.max(0, maxAgeMs),
    ).changes;
}

/** An interrupt in this thread: work a restart left to resume stays
 * stopped, and a resumed turn already queued for it is canceled. One
 * transaction, so it serializes with the guarded continuation insert. */
export function stopAcpFenceResumesForThread({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): number {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  let changes = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    changes += db
      .prepare(
        `UPDATE ${TABLE}
         SET recovery_code = ?,
             updated_at = ?
         WHERE project_id = ? AND path = ? AND thread_id = ?
           AND recovery_code IN (${LIVE_RESUME_PLACEHOLDERS})`,
      )
      .run(
        ACP_FENCE_INTENT_STOPPED,
        now,
        project_id,
        path,
        thread_id,
        ...ACP_FENCE_LIVE_RESUME_INTENTS,
      ).changes;
    changes += db
      .prepare(
        `UPDATE ${TABLE}
         SET state = 'canceled',
             error = ?,
             updated_at = ?,
             finished_at = ?
         WHERE project_id = ? AND path = ? AND thread_id = ?
           AND state = 'queued'
           AND recovery_parent_op_id IN (
             SELECT op_id FROM ${TABLE}
             WHERE project_id = ? AND path = ? AND thread_id = ?
               AND error IN (?, ?)
           )`,
      )
      .run(
        "interrupted before it resumed",
        now,
        now,
        project_id,
        path,
        thread_id,
        project_id,
        path,
        thread_id,
        ACP_PROJECT_RESUME_FENCE_REASON,
        ACP_PROJECT_RUNTIME_LOST_FENCE_REASON,
      ).changes;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return changes;
}

/** Queue again a message the fence held back from a restarting project. */
export function requeueFencedAcpJob(op_id: string): AcpJobRow | undefined {
  ensureInit();
  const db = getAcpDatabase();
  const updated = db
    .prepare(
      `UPDATE ${TABLE}
       SET state = 'queued',
           error = NULL,
           available_at = NULL,
           updated_at = ?,
           started_at = NULL,
           finished_at = NULL,
           worker_id = NULL,
           worker_bundle_version = NULL,
           recovery_code = NULL,
           recovery_detail = NULL
       WHERE op_id = ?
         AND state = 'canceled'
         AND recovery_code IN (?, ?)`,
    )
    .run(
      Date.now(),
      op_id,
      ACP_FENCE_INTENT_RESUME_READY,
      ACP_FENCE_INTENT_RESUMING,
    );
  if (updated.changes !== 1) return undefined;
  const job = getAcpJobByOpId(op_id);
  mirrorAcpJobSession(job);
  return job;
}

export function clearAcpJobRecoveryIntent(op_id: string): void {
  ensureInit();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET recovery_code = NULL,
           recovery_detail = NULL,
           updated_at = ?
       WHERE op_id = ?`,
    )
    .run(Date.now(), op_id);
}

export function requeueRunningAcpJob({
  op_id,
  error,
  worker_id,
}: {
  op_id: string;
  error?: string;
  worker_id?: string;
}): void {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  if (`${worker_id ?? ""}`.trim()) {
    db.prepare(
      `UPDATE ${TABLE}
        SET state = 'queued',
            available_at = NULL,
            error = COALESCE(?, error),
            updated_at = ?,
            started_at = NULL,
            finished_at = NULL,
            worker_id = NULL,
            worker_bundle_version = NULL
        WHERE op_id = ?
          AND state = 'running'
          AND (
            worker_id IS NULL
            OR worker_id = ?
          )`,
    ).run(error ?? null, now, op_id, worker_id);
    mirrorAcpJobSession(getAcpJobByOpId(op_id));
    return;
  }
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'queued',
          available_at = NULL,
          error = COALESCE(?, error),
          updated_at = ?,
          started_at = NULL,
          finished_at = NULL,
          worker_id = NULL,
          worker_bundle_version = NULL
      WHERE op_id = ?
        AND state = 'running'`,
  ).run(error ?? null, now, op_id);
  mirrorAcpJobSession(getAcpJobByOpId(op_id));
}

export function clearQueuedAcpJobWorkerAffinity({
  op_id,
  worker_id,
}: {
  op_id: string;
  worker_id: string;
}): boolean {
  ensureInit();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET worker_id = NULL,
           worker_bundle_version = NULL,
           updated_at = ?
       WHERE op_id = ?
         AND state = 'queued'
         AND worker_id = ?`,
    )
    .run(Date.now(), op_id, worker_id);
  const changed = Number(result?.changes ?? 0) > 0;
  if (changed) {
    mirrorAcpJobSession(getAcpJobByOpId(op_id));
  }
  return changed;
}

// User controls (cancel, send now, resend) act only on the caller's own turn
// in the named thread: a queued turn runs as, and is funded by, the account
// that sent it, and other collaborators can see its message ids.
type AcpJobOwner = { account_id: string; thread_id: string };

export function getOwnedAcpJob({
  project_id,
  path,
  user_message_id,
  account_id,
  thread_id,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
} & AcpJobOwner): AcpJobRow | undefined {
  const job = getAcpJob({ project_id, path, user_message_id });
  if (!account_id || !thread_id) return undefined;
  return job?.account_id === account_id && job.thread_id === thread_id
    ? job
    : undefined;
}

export function reprioritizeAcpJobImmediate({
  project_id,
  path,
  user_message_id,
  account_id,
  thread_id,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
} & AcpJobOwner): AcpJobRow | undefined {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET send_mode = 'immediate',
          priority = 1,
          available_at = NULL,
          updated_at = ?
      WHERE project_id = ?
        AND path = ?
        AND user_message_id = ?
        AND account_id = ?
        AND thread_id = ?
        AND state = 'queued'`,
  ).run(now, project_id, path, user_message_id, account_id, thread_id);
  const job = getOwnedAcpJob({
    project_id,
    path,
    user_message_id,
    account_id,
    thread_id,
  });
  mirrorAcpJobSession(job);
  return job;
}

export function cancelQueuedAcpJob(
  owner: {
    project_id: string;
    path: string;
    user_message_id: string;
  } & AcpJobOwner,
): AcpJobRow | undefined {
  return cancelQueuedAcpJobReportingChange(owner).job;
}

/** Cancel a queued (or restart-held) message; `canceled` is whether this
 * call canceled it, not an earlier cancel or a fence. */
export function cancelQueuedAcpJobReportingChange({
  project_id,
  path,
  user_message_id,
  account_id,
  thread_id,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
} & AcpJobOwner): { job: AcpJobRow | undefined; canceled: boolean } {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  let canceled = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    // A message a restart is holding is canceled too: it must not resume.
    const released = db
      .prepare(
        `UPDATE ${TABLE}
        SET recovery_code = NULL,
            recovery_detail = NULL,
            error = ?,
            updated_at = ?
        WHERE project_id = ?
          AND path = ?
          AND user_message_id = ?
          AND account_id = ?
          AND thread_id = ?
          AND state = 'canceled'
          AND recovery_code IN (${LIVE_RESUME_PLACEHOLDERS})`,
      )
      .run(
        ACP_FENCED_JOB_CANCELED_ERROR,
        now,
        project_id,
        path,
        user_message_id,
        account_id,
        thread_id,
        ...ACP_FENCE_LIVE_RESUME_INTENTS,
      );
    const taken = takeQueuedAcpJob(db, now, {
      project_id,
      path,
      user_message_id,
      account_id,
      thread_id,
    });
    canceled = Number(released.changes) > 0 || taken;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const job = getOwnedAcpJob({
    project_id,
    path,
    user_message_id,
    account_id,
    thread_id,
  });
  mirrorAcpJobSession(job);
  return { job, canceled };
}

function takeQueuedAcpJob(
  db: ReturnType<typeof getAcpDatabase>,
  now: number,
  {
    project_id,
    path,
    user_message_id,
    account_id,
    thread_id,
  }: {
    project_id: string;
    path: string;
    user_message_id: string;
  } & AcpJobOwner,
): boolean {
  return (
    Number(
      db
        .prepare(
          `UPDATE ${TABLE}
        SET state = 'canceled',
            updated_at = ?,
            finished_at = ?
        WHERE project_id = ?
          AND path = ?
          AND user_message_id = ?
          AND account_id = ?
          AND thread_id = ?
          AND state = 'queued'`,
        )
        .run(now, now, project_id, path, user_message_id, account_id, thread_id)
        .changes,
    ) > 0
  );
}

// Take a queued job out of the queue for a control that acts on the message
// (send now). Unlike an explicit cancel it changes nothing else (a job a
// restart is holding keeps its resume intent), and it reports whether this
// call took the job: the control owns the message only if it did.
export function cancelQueuedAcpJobForControl(
  owner: {
    project_id: string;
    path: string;
    user_message_id: string;
  } & AcpJobOwner,
): { job: AcpJobRow | undefined; canceled: boolean } {
  ensureInit();
  const canceled = takeQueuedAcpJob(getAcpDatabase(), Date.now(), owner);
  const job = getOwnedAcpJob(owner);
  mirrorAcpJobSession(job);
  return { job, canceled };
}

function cancelQueuedRecoveryJobsForThreadInDatabase({
  db,
  project_id,
  path,
  thread_id,
  now,
}: {
  db: ReturnType<typeof getAcpDatabase>;
  project_id: string;
  path: string;
  thread_id: string;
  now: number;
}): AcpJobRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ?
         AND path = ?
         AND thread_id = ?
         AND state = 'queued'
         AND recovery_parent_op_id IS NOT NULL`,
    )
    .all(project_id, path, thread_id) as AcpJobRow[];
  if (rows.length) {
    db.prepare(
      `UPDATE ${TABLE}
       SET state = 'canceled',
           error = 'superseded by a newer user turn',
           updated_at = ?,
           finished_at = ?
       WHERE project_id = ?
         AND path = ?
         AND thread_id = ?
         AND state = 'queued'
         AND recovery_parent_op_id IS NOT NULL`,
    ).run(now, now, project_id, path, thread_id);
  }
  return rows.map((row) => ({
    ...row,
    state: "canceled",
    error: "superseded by a newer user turn",
    updated_at: now,
    finished_at: now,
  }));
}

export function cancelQueuedRecoveryJobsForThread({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): AcpJobRow[] {
  ensureInit();
  const db = getAcpDatabase();
  let rows: AcpJobRow[] = [];
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    rows = cancelQueuedRecoveryJobsForThreadInDatabase({
      db,
      project_id,
      path,
      thread_id,
      now,
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  if (!rows.length) return [];
  for (const row of rows) {
    mirrorAcpJobSession(getAcpJobByOpId(row.op_id));
  }
  return rows;
}

export function enqueueAcpJobCancelingQueuedRecoveries(
  request: AcpJobRequest,
  opts: Pick<EnqueueAcpJobOptions, "preferred_worker_id"> = {},
): { job: AcpJobRow; canceled: AcpJobRow[] } {
  ensureInit();
  const db = getAcpDatabase();
  const { project_id, path, thread_id, user_message_id } =
    assertChatIdentity(request);
  const now = Date.now();
  let canceled: AcpJobRow[] = [];
  let job: AcpJobRow | undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        `SELECT 1 FROM ${TABLE}
         WHERE project_id = ? AND path = ? AND user_message_id = ?
         LIMIT 1`,
      )
      .get(project_id, path, user_message_id);
    if (existing == null) {
      canceled = cancelQueuedRecoveryJobsForThreadInDatabase({
        db,
        project_id,
        path,
        thread_id,
        now,
      });
    }
    job = enqueueAcpJob(request, opts);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  if (!job) {
    throw new Error("failed to enqueue ACP user job");
  }
  mirrorAcpJobSession(job);
  for (const row of canceled) {
    mirrorAcpJobSession(getAcpJobByOpId(row.op_id));
  }
  return { job, canceled };
}

export function resendCanceledAcpJob({
  project_id,
  path,
  user_message_id,
  account_id,
  thread_id,
  modelRecovery,
  fundingRecovery,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
  account_id: string;
  thread_id: string;
  modelRecovery?: {
    model: string;
    expected_model: string;
    account_id: string;
    thread_id: string;
  };
  fundingRecovery?: {
    account_id: string;
    thread_id: string;
    expected_request: string;
    payment_source: CodexPaymentSourcePreference;
    credential_id?: string;
  };
}): AcpJobRow | undefined {
  if (modelRecovery && fundingRecovery) return undefined;
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  let replacement: string | null = null;
  let expectedRequest: string | null = null;
  if (modelRecovery) {
    const current = getAcpJob({ project_id, path, user_message_id });
    if (
      !current ||
      current.state !== "error" ||
      current.account_id !== modelRecovery.account_id ||
      current.thread_id !== modelRecovery.thread_id ||
      unavailableChatGptCodexModel(current.error ?? "") !==
        modelRecovery.expected_model ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(modelRecovery.model) ||
      modelRecovery.model === modelRecovery.expected_model
    )
      return undefined;
    const request = decodeAcpJobRequest(current);
    if (
      request.config?.model !== modelRecovery.expected_model ||
      ![undefined, "auto", "subscription"].includes(
        request.config?.paymentSource,
      )
    )
      return undefined;
    expectedRequest = current.request_json;
    replacement = JSON.stringify({
      ...request,
      config: codexModelRecoveryConfig(request.config, modelRecovery.model),
    });
  }
  if (fundingRecovery) {
    const current = getAcpJob({ project_id, path, user_message_id });
    if (
      !current ||
      current.state !== "error" ||
      current.account_id !== fundingRecovery.account_id ||
      current.thread_id !== fundingRecovery.thread_id ||
      current.request_json !== fundingRecovery.expected_request
    )
      return undefined;
    const original = decodeAcpJobRequest(current);
    expectedRequest = current.request_json;
    replacement = JSON.stringify({
      ...original,
      config: {
        ...original.config,
        paymentSource: fundingRecovery.payment_source,
        credentialId: fundingRecovery.credential_id,
      },
    });
  }
  // Historical name: this also retries terminal error jobs, which keep the
  // original request_json needed to resubmit the same user turn.
  const updated = db
    .prepare(
      `UPDATE ${TABLE}
      SET state = 'queued',
          request_json = COALESCE(?, request_json),
          available_at = NULL,
          priority = CASE
            WHEN send_mode = 'immediate' THEN 1
            ELSE 0
          END,
          updated_at = ?,
          started_at = NULL,
          finished_at = NULL,
          worker_id = NULL,
          worker_bundle_version = NULL,
          recovery_code = NULL,
          recovery_detail = NULL
      WHERE project_id = ?
        AND path = ?
        AND user_message_id = ?
        AND account_id = ?
        AND thread_id = ?
        AND state IN ('canceled', 'error')
        AND (recovery_code IS NULL
          OR recovery_code NOT IN (${LIVE_RESUME_PLACEHOLDERS}))
        AND (? IS NULL OR (state = 'error' AND request_json = ?))`,
    )
    .run(
      replacement,
      now,
      project_id,
      path,
      user_message_id,
      account_id,
      thread_id,
      ...ACP_FENCE_LIVE_RESUME_INTENTS,
      expectedRequest,
      expectedRequest,
    );
  if ((modelRecovery || fundingRecovery) && updated.changes !== 1)
    return undefined;
  const job = getOwnedAcpJob({
    project_id,
    path,
    user_message_id,
    account_id,
    thread_id,
  });
  mirrorAcpJobSession(job);
  return job;
}

export function markRunningAcpJobsInterrupted(reason = "server restart"): void {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  const rows = db
    .prepare(`SELECT op_id FROM ${TABLE} WHERE state = 'running'`)
    .all() as Array<{ op_id: string }>;
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'interrupted',
          error = COALESCE(error, ?),
          updated_at = ?,
          finished_at = COALESCE(finished_at, ?)
      WHERE state = 'running'`,
  ).run(reason, now, now);
  for (const row of rows) {
    mirrorAcpJobSession(getAcpJobByOpId(row.op_id));
  }
}

export function fenceAcpJobsForProject({
  project_id,
  reason,
  resume = false,
}: {
  project_id: string;
  reason: string;
  /** Restart or lost runtime: resume the work once the project runs again
   * (releaseAcpProjectFenceResumes). Otherwise the work stays stopped and
   * its chat and senders are told so. Nothing runs before then either way. */
  resume?: boolean;
}): { queued: number; running: number } {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  const intent = resume
    ? ACP_FENCE_INTENT_RESUME_PENDING
    : ACP_FENCE_INTENT_STOPPED;
  let queued = 0;
  let running = 0;
  // One transaction: a resume being enqueued either commits first (and its
  // queued child is fenced here) or finds its claim gone and inserts nothing.
  db.exec("BEGIN IMMEDIATE");
  try {
    // Earlier resumes not yet running: a stop ends them; another restart
    // makes them wait for the next start again.
    db.prepare(
      `UPDATE ${TABLE}
       SET recovery_code = ?,
           updated_at = ?
       WHERE project_id = ? AND recovery_code IN (${LIVE_RESUME_PLACEHOLDERS})`,
    ).run(intent, now, project_id, ...ACP_FENCE_LIVE_RESUME_INTENTS);
    queued = db
      .prepare(
        `UPDATE ${TABLE}
         SET state = 'canceled',
             error = ?,
             recovery_code = ?,
             recovery_detail = ?,
             updated_at = ?,
             finished_at = ?
         WHERE project_id = ? AND state = 'queued'`,
      )
      // A held message has no chat to finalize while it waits.
      .run(
        reason,
        intent,
        resume ? ACP_FENCE_CHAT_FINALIZED : null,
        now,
        now,
        project_id,
      ).changes;
    running = db
      .prepare(
        `UPDATE ${TABLE}
         SET state = CASE
               WHEN json_extract(request_json, '$.runtime.kind') = 'acp'
               THEN 'error'
               ELSE 'interrupted'
             END,
             error = ?,
             recovery_code = ?,
             recovery_detail = NULL,
             updated_at = ?,
             finished_at = ?
         WHERE project_id = ? AND state = 'running'`,
      )
      .run(reason, intent, now, now, project_id).changes;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  for (const row of db
    .prepare(`SELECT * FROM ${TABLE} WHERE project_id = ?`)
    .all(project_id) as AcpJobRow[]) {
    mirrorAcpJobSession(row);
  }
  return { queued, running };
}

export function decodeAcpJobRequest(row: AcpJobRow): AcpJobRequest {
  const parsed = JSON.parse(row.request_json ?? "{}") as AcpJobRequest;
  return {
    ...parsed,
    request_kind: parsed.request_kind ?? "codex",
    runtime_env: undefined,
  };
}
