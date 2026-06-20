/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import { interruptAcp } from "@cocalc/conat/ai/acp/client";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import type {
  AiSessionIdentity,
  AiSessionInterruptAllOptions,
  AiSessionInterruptAllResponse,
  AiSessionInterruptResponse,
  AiSessionRecord,
  AiSessionsListOptions,
  AiSessionState,
} from "@cocalc/conat/hub/api/ai-sessions";
import { isValidUUID } from "@cocalc/util/misc";

const TABLE = "ai_sessions";
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MAX_TEXT_BYTES = 8192;
const logger = getLogger("server:ai:acp-sessions");
const RECONCILIATION_ENABLED =
  `${process.env.COCALC_AI_SESSION_RECONCILIATION_ENABLED ?? "true"}`
    .trim()
    .toLowerCase() !== "false";
const RECONCILIATION_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.COCALC_AI_SESSION_RECONCILIATION_INTERVAL_MS ?? 60_000),
);

const TERMINAL_STATES = new Set<AiSessionState>([
  "completed",
  "failed",
  "interrupted",
  "canceled",
  "host_stopped",
]);

let schemaReady: Promise<void> | undefined;
let reconciliationTimer: NodeJS.Timeout | undefined;
let reconciliationRunning = false;

export async function ensureAiSessionsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        session_key TEXT PRIMARY KEY,
        session_id TEXT,
        op_id TEXT,
        project_id UUID NOT NULL,
        account_id UUID,
        approver_account_id UUID,
        host_id UUID,
        path TEXT,
        thread_id TEXT,
        message_id TEXT,
        parent_message_id TEXT,
        state TEXT NOT NULL,
        terminal BOOLEAN NOT NULL DEFAULT FALSE,
        payment_source_kind TEXT NOT NULL DEFAULT 'unknown',
        payment_source_id TEXT,
        payment_source_label TEXT,
        payment_source_owner_account_id UUID,
        model TEXT,
        agent_kind TEXT NOT NULL DEFAULT 'codex',
        run_kind TEXT,
        title TEXT,
        prompt_snippet TEXT,
        queued_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_heartbeat_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        error TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        source_bay_id TEXT NOT NULL
      )
    `);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_account_state_updated_idx
         ON ${TABLE} (account_id, terminal, updated_at DESC)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_project_updated_idx
         ON ${TABLE} (project_id, updated_at DESC)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_host_state_updated_idx
         ON ${TABLE} (host_id, terminal, updated_at DESC)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_payment_state_updated_idx
         ON ${TABLE} (payment_source_kind, payment_source_id, terminal, updated_at DESC)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_state_updated_idx
         ON ${TABLE} (state, updated_at DESC)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_op_id_idx
         ON ${TABLE} (op_id) WHERE op_id IS NOT NULL`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_session_id_idx
         ON ${TABLE} (session_id) WHERE session_id IS NOT NULL`,
    );
  })();
  return schemaReady;
}

function cleanText(value: unknown, max = 512): string | null {
  const text = `${value ?? ""}`.trim();
  if (!text) return null;
  return text.slice(0, max);
}

function cleanUuid(value: unknown, label: string): string | null {
  const text = cleanText(value, 80);
  if (!text) return null;
  if (!isValidUUID(text)) {
    throw Error(`invalid ${label} '${value ?? ""}'`);
  }
  return text;
}

function cleanRequiredUuid(value: unknown, label: string): string {
  const uuid = cleanUuid(value, label);
  if (!uuid) {
    throw Error(`${label} is required`);
  }
  return uuid;
}

function timestamp(value: unknown, fallback?: Date): Date | null {
  if (value == null || value === "") {
    return fallback ?? null;
  }
  const d =
    typeof value === "number"
      ? new Date(value)
      : value instanceof Date
        ? value
        : new Date(`${value}`);
  if (!Number.isFinite(d.getTime())) {
    return fallback ?? null;
  }
  return d;
}

function cleanMetadata(record: AiSessionRecord): Record<string, unknown> {
  let metadata: unknown = {};
  try {
    metadata =
      record.metadata != null
        ? record.metadata
        : record.metadata_json
          ? JSON.parse(record.metadata_json)
          : {};
  } catch {
    metadata = {};
  }
  if (
    metadata == null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return {};
  }
  const json = JSON.stringify(metadata);
  if (json.length > MAX_TEXT_BYTES) {
    return { truncated: true };
  }
  return JSON.parse(json);
}

function terminalFromRecord(record: AiSessionRecord): boolean {
  if (typeof record.terminal === "boolean") {
    return record.terminal;
  }
  if (record.terminal === 0 || record.terminal === 1) {
    return record.terminal === 1;
  }
  return TERMINAL_STATES.has(record.state);
}

function isTerminalState(state: string | null | undefined): boolean {
  return TERMINAL_STATES.has(`${state ?? ""}` as AiSessionState);
}

async function assertHostCanReportSession({
  host_id,
  project_id,
}: {
  host_id: string;
  project_id: string;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `
      SELECT 1
      FROM projects
      WHERE project_id=$1
        AND host_id=$2
        AND deleted IS NOT true
      LIMIT 1
    `,
    [project_id, host_id],
  );
  if (!rowCount) {
    throw Error("host is not authorized for this project session");
  }
}

export async function upsertProjectHostAiSession({
  record,
  authenticated_host_id,
  authenticated_project_id,
}: {
  record: AiSessionRecord;
  authenticated_host_id?: string;
  authenticated_project_id?: string;
}): Promise<void> {
  if (!authenticated_host_id && !authenticated_project_id) {
    throw Error(
      "AI session publication requires project or host authentication",
    );
  }
  const project_id = cleanRequiredUuid(
    record.project_id ?? authenticated_project_id,
    "project_id",
  );
  const host_id =
    cleanUuid(authenticated_host_id, "host_id") ??
    cleanUuid(record.host_id, "host_id");
  if (!host_id && !authenticated_project_id) {
    throw Error("host_id is required for project-host AI session publication");
  }
  if (authenticated_host_id) {
    await assertHostCanReportSession({
      host_id: authenticated_host_id,
      project_id,
    });
  } else if (
    authenticated_project_id &&
    authenticated_project_id !== project_id
  ) {
    throw Error("project-authenticated session publication project mismatch");
  }

  const session_key = cleanText(record.session_key, 512);
  if (!session_key) {
    throw Error("session_key is required");
  }
  const now = new Date();
  const updated_at = timestamp(record.updated_at, now)!;
  const terminal = terminalFromRecord(record);
  await ensureAiSessionsSchema();
  await getPool().query(
    `
      INSERT INTO ${TABLE}
        (session_key, session_id, op_id, project_id, account_id, approver_account_id,
         host_id, path, thread_id, message_id, parent_message_id, state, terminal,
         payment_source_kind, payment_source_id, payment_source_label,
         payment_source_owner_account_id, model, agent_kind, run_kind, title,
         prompt_snippet, queued_at, started_at, updated_at, last_heartbeat_at,
         finished_at, error, metadata, source_bay_id)
      VALUES
        ($1, $2, $3, $4::UUID, $5::UUID, $6::UUID, $7::UUID, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17::UUID, $18, $19, $20, $21, $22,
         $23::TIMESTAMPTZ, $24::TIMESTAMPTZ, $25::TIMESTAMPTZ,
         $26::TIMESTAMPTZ, $27::TIMESTAMPTZ, $28, $29::jsonb, $30)
      ON CONFLICT (session_key) DO UPDATE SET
        session_id = COALESCE(EXCLUDED.session_id, ${TABLE}.session_id),
        op_id = COALESCE(EXCLUDED.op_id, ${TABLE}.op_id),
        project_id = EXCLUDED.project_id,
        account_id = COALESCE(EXCLUDED.account_id, ${TABLE}.account_id),
        approver_account_id = COALESCE(EXCLUDED.approver_account_id, ${TABLE}.approver_account_id),
        host_id = COALESCE(EXCLUDED.host_id, ${TABLE}.host_id),
        path = COALESCE(EXCLUDED.path, ${TABLE}.path),
        thread_id = COALESCE(EXCLUDED.thread_id, ${TABLE}.thread_id),
        message_id = COALESCE(EXCLUDED.message_id, ${TABLE}.message_id),
        parent_message_id = COALESCE(EXCLUDED.parent_message_id, ${TABLE}.parent_message_id),
        state = EXCLUDED.state,
        terminal = EXCLUDED.terminal,
        payment_source_kind = COALESCE(EXCLUDED.payment_source_kind, ${TABLE}.payment_source_kind),
        payment_source_id = COALESCE(EXCLUDED.payment_source_id, ${TABLE}.payment_source_id),
        payment_source_label = COALESCE(EXCLUDED.payment_source_label, ${TABLE}.payment_source_label),
        payment_source_owner_account_id = COALESCE(EXCLUDED.payment_source_owner_account_id, ${TABLE}.payment_source_owner_account_id),
        model = COALESCE(EXCLUDED.model, ${TABLE}.model),
        agent_kind = COALESCE(EXCLUDED.agent_kind, ${TABLE}.agent_kind),
        run_kind = COALESCE(EXCLUDED.run_kind, ${TABLE}.run_kind),
        title = COALESCE(EXCLUDED.title, ${TABLE}.title),
        prompt_snippet = COALESCE(EXCLUDED.prompt_snippet, ${TABLE}.prompt_snippet),
        queued_at = COALESCE(${TABLE}.queued_at, EXCLUDED.queued_at),
        started_at = COALESCE(EXCLUDED.started_at, ${TABLE}.started_at),
        updated_at = EXCLUDED.updated_at,
        last_heartbeat_at = COALESCE(EXCLUDED.last_heartbeat_at, ${TABLE}.last_heartbeat_at),
        finished_at = CASE
          WHEN EXCLUDED.terminal THEN COALESCE(EXCLUDED.finished_at, ${TABLE}.finished_at, EXCLUDED.updated_at)
          ELSE NULL
        END,
        error = COALESCE(EXCLUDED.error, ${TABLE}.error),
        metadata = COALESCE(EXCLUDED.metadata, ${TABLE}.metadata),
        source_bay_id = EXCLUDED.source_bay_id
    `,
    [
      session_key,
      cleanText(record.session_id, 512),
      cleanText(record.op_id, 512),
      project_id,
      cleanUuid(record.account_id, "account_id"),
      cleanUuid(record.approver_account_id, "approver_account_id"),
      host_id,
      cleanText(record.path, 2048),
      cleanText(record.thread_id, 512),
      cleanText(record.message_id, 512),
      cleanText(record.parent_message_id, 512),
      cleanText(record.state, 80) ?? "unknown",
      terminal,
      cleanText(record.payment_source_kind, 80) ?? "unknown",
      cleanText(record.payment_source_id, 256),
      cleanText(record.payment_source_label, 256),
      cleanUuid(
        record.payment_source_owner_account_id,
        "payment_source_owner_account_id",
      ),
      cleanText(record.model, 160),
      cleanText(record.agent_kind, 80) ?? "codex",
      cleanText(record.run_kind, 80),
      cleanText(record.title, 512),
      cleanText(record.prompt_snippet, 2048),
      timestamp(record.queued_at),
      timestamp(record.started_at),
      updated_at,
      timestamp(record.last_heartbeat_at),
      terminal ? timestamp(record.finished_at, updated_at) : null,
      cleanText(record.error, 2048),
      JSON.stringify(cleanMetadata(record)),
      getConfiguredBayId(),
    ],
  );
}

export async function listAiSessionsForAccount({
  account_id,
  opts,
}: {
  account_id: string;
  opts?: AiSessionsListOptions;
}): Promise<AiSessionRecord[]> {
  const caller = cleanRequiredUuid(account_id, "account_id");
  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, Math.floor(Number(opts?.limit ?? DEFAULT_LIMIT))),
  );
  const conditions = ["account_id=$1::UUID"];
  const params: unknown[] = [caller];
  if (opts?.activeOnly) {
    conditions.push("terminal IS NOT TRUE");
  }
  if (opts?.project_id) {
    params.push(cleanRequiredUuid(opts.project_id, "project_id"));
    conditions.push(`project_id=$${params.length}::UUID`);
    await assertProjectCollaboratorAccessAllowRemote({
      account_id: caller,
      project_id: opts.project_id,
    });
  }
  if (opts?.host_id) {
    params.push(cleanRequiredUuid(opts.host_id, "host_id"));
    conditions.push(`host_id=$${params.length}::UUID`);
  }
  params.push(limit);
  await ensureAiSessionsSchema();
  const { rows } = await getPool().query(
    `
      SELECT session_key, session_id, op_id, project_id::TEXT, account_id::TEXT,
             approver_account_id::TEXT, host_id::TEXT, path, thread_id,
             message_id, parent_message_id, state, terminal,
             payment_source_kind, payment_source_id, payment_source_label,
             payment_source_owner_account_id::TEXT, model, agent_kind, run_kind,
             title, prompt_snippet, queued_at, started_at, updated_at,
             last_heartbeat_at, finished_at, error, metadata AS metadata_json
      FROM ${TABLE}
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `,
    params,
  );
  return rows.map((row) => ({
    ...row,
    terminal: !!row.terminal,
    metadata_json: JSON.stringify(row.metadata_json ?? {}),
  })) as AiSessionRecord[];
}

type AiSessionDbRow = AiSessionRecord & {
  metadata_json?: string | null;
};

function identityWhere({
  identity,
  params,
}: {
  identity: AiSessionIdentity;
  params: unknown[];
}): string {
  const clauses: string[] = [];
  const sessionKey = cleanText(identity.session_key, 512);
  if (sessionKey) {
    params.push(sessionKey);
    clauses.push(`session_key=$${params.length}`);
  }
  const sessionId = cleanText(identity.session_id, 512);
  if (sessionId) {
    params.push(sessionId);
    clauses.push(`session_id=$${params.length}`);
  }
  const opId = cleanText(identity.op_id, 512);
  if (opId) {
    params.push(opId);
    clauses.push(`op_id=$${params.length}`);
  }
  if (clauses.length === 0) {
    throw Error("session_key, session_id, or op_id must be specified");
  }
  return `(${clauses.join(" OR ")})`;
}

async function getAiSessionForAccount({
  account_id,
  identity,
}: {
  account_id: string;
  identity: AiSessionIdentity;
}): Promise<AiSessionDbRow | undefined> {
  const params: unknown[] = [cleanRequiredUuid(account_id, "account_id")];
  const where = identityWhere({ identity, params });
  await ensureAiSessionsSchema();
  const { rows } = await getPool().query(
    `
      SELECT session_key, session_id, op_id, project_id::TEXT, account_id::TEXT,
             approver_account_id::TEXT, host_id::TEXT, path, thread_id,
             message_id, parent_message_id, state, terminal,
             payment_source_kind, payment_source_id, payment_source_label,
             payment_source_owner_account_id::TEXT, model, agent_kind, run_kind,
             title, prompt_snippet, queued_at, started_at, updated_at,
             last_heartbeat_at, finished_at, error, metadata AS metadata_json
      FROM ${TABLE}
      WHERE account_id=$1::UUID
        AND ${where}
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    params,
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    ...row,
    terminal: !!row.terminal,
    metadata_json: JSON.stringify(row.metadata_json ?? {}),
  } as AiSessionDbRow;
}

async function updateAiSessionState({
  session_key,
  state,
  terminal,
  error,
  metadata,
}: {
  session_key: string;
  state: AiSessionState;
  terminal: boolean;
  error?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await ensureAiSessionsSchema();
  await getPool().query(
    `
      UPDATE ${TABLE}
      SET state=$2,
          terminal=$3,
          updated_at=NOW(),
          finished_at=CASE WHEN $3::BOOLEAN THEN COALESCE(finished_at, NOW()) ELSE NULL END,
          error=COALESCE($4, error),
          metadata=COALESCE(metadata, '{}'::jsonb) || $5::jsonb
      WHERE session_key=$1
    `,
    [
      session_key,
      state,
      terminal,
      cleanText(error, 2048),
      JSON.stringify(metadata ?? {}),
    ],
  );
}

function interruptRequestFromRow({
  row,
  account_id,
  note,
}: {
  row: AiSessionDbRow;
  account_id: string;
  note?: string | null;
}) {
  const path = cleanText(row.path, 2048) ?? "";
  const threadId = cleanText(row.thread_id, 512) ?? undefined;
  const messageDate = (
    timestamp(row.started_at) ??
    timestamp(row.queued_at) ??
    timestamp(row.updated_at) ??
    new Date()
  ).toISOString();
  return {
    project_id: row.project_id,
    account_id,
    threadId,
    note: cleanText(note, 512) ?? undefined,
    chat:
      path && (threadId || row.message_id)
        ? {
            project_id: row.project_id,
            path,
            thread_id: threadId,
            message_id: cleanText(row.message_id, 512) ?? undefined,
            parent_message_id:
              cleanText(row.parent_message_id, 512) ?? undefined,
            message_date: messageDate,
            sender_id: "openai-codex-agent",
          }
        : undefined,
  };
}

function baseInterruptResponse(
  row: AiSessionDbRow | undefined,
): Pick<
  AiSessionInterruptResponse,
  "session_key" | "session_id" | "op_id" | "project_id"
> {
  return {
    session_key: row?.session_key ?? null,
    session_id: row?.session_id ?? null,
    op_id: row?.op_id ?? null,
    project_id: row?.project_id ?? null,
  };
}

export async function interruptAiSessionForAccount({
  account_id,
  session_key,
  session_id,
  op_id,
  note,
}: {
  account_id: string;
  session_key?: string;
  session_id?: string;
  op_id?: string;
  note?: string;
}): Promise<AiSessionInterruptResponse> {
  const caller = cleanRequiredUuid(account_id, "account_id");
  const row = await getAiSessionForAccount({
    account_id: caller,
    identity: { session_key, session_id, op_id },
  });
  if (!row) {
    return {
      ok: false,
      state: "missing",
      terminal: true,
      message: "session not found",
    };
  }
  if (row.terminal || isTerminalState(row.state)) {
    return {
      ok: true,
      state: "already_terminal",
      terminal: true,
      ...baseInterruptResponse(row),
    };
  }
  await updateAiSessionState({
    session_key: row.session_key,
    state: "interrupting",
    terminal: false,
    metadata: { interrupt_requested_at: new Date().toISOString() },
  });
  try {
    const response = await interruptAcp(
      interruptRequestFromRow({ row, account_id: caller, note }),
      await conat(),
    );
    if (response.state === "interrupted" || response.state === "repaired") {
      await updateAiSessionState({
        session_key: row.session_key,
        state: "interrupted",
        terminal: true,
        metadata: { interrupt_result: response.state },
      });
      return {
        ok: true,
        state: response.state,
        terminal: true,
        ...baseInterruptResponse(row),
      };
    }
    if (response.state === "missing") {
      await updateAiSessionState({
        session_key: row.session_key,
        state: "interrupted",
        terminal: true,
        error: "interrupt reported no live session",
        metadata: { interrupt_result: "missing" },
      });
      return {
        ok: true,
        state: "missing",
        terminal: true,
        ...baseInterruptResponse(row),
        message: "backend reported no live session",
      };
    }
    return {
      ok: true,
      state: "queued",
      terminal: false,
      ...baseInterruptResponse(row),
      message: "interrupt request queued",
    };
  } catch (err) {
    await updateAiSessionState({
      session_key: row.session_key,
      state: "possibly_active",
      terminal: false,
      error: `interrupt transport failed: ${err}`,
      metadata: { interrupt_result: "transport_failed" },
    });
    return {
      ok: false,
      state: "transport_failed",
      terminal: false,
      ...baseInterruptResponse(row),
      message: `${err}`,
    };
  }
}

export async function interruptAllAiSessionsForAccount({
  account_id,
  limit,
  note,
}: AiSessionInterruptAllOptions & {
  account_id: string;
}): Promise<AiSessionInterruptAllResponse> {
  const rows = await listAiSessionsForAccount({
    account_id,
    opts: { activeOnly: true, limit },
  });
  const results: AiSessionInterruptResponse[] = [];
  for (const row of rows) {
    results.push(
      await interruptAiSessionForAccount({
        account_id,
        session_key: row.session_key,
        note,
      }),
    );
  }
  return {
    total: results.length,
    terminal: results.filter((result) => result.terminal).length,
    uncertain: results.filter((result) => !result.terminal).length,
    results,
  };
}

export async function markStaleAiSessionsPossiblyActive({
  olderThanMs = 2 * 60 * 1000,
  limit = 500,
}: {
  olderThanMs?: number;
  limit?: number;
} = {}): Promise<number> {
  const max = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit))));
  const cutoff = new Date(Date.now() - Math.max(0, olderThanMs));
  await ensureAiSessionsSchema();
  const { rowCount } = await getPool().query(
    `
      WITH candidates AS (
        SELECT session_key
        FROM ${TABLE}
        WHERE terminal IS NOT TRUE
          AND state NOT IN ('possibly_active', 'orphaned')
          AND COALESCE(last_heartbeat_at, updated_at) < $1::TIMESTAMPTZ
        ORDER BY updated_at ASC
        LIMIT $2
      )
      UPDATE ${TABLE} AS sessions
      SET state='possibly_active',
          terminal=FALSE,
          updated_at=NOW(),
          metadata=COALESCE(sessions.metadata, '{}'::jsonb) ||
                   jsonb_build_object('reconciliation_reason', 'stale_heartbeat')
      FROM candidates
      WHERE sessions.session_key=candidates.session_key
    `,
    [cutoff, max],
  );
  return rowCount ?? 0;
}

export async function markHostStoppedAiSessions({
  host_id,
  reason = "host stopped",
}: {
  host_id: string;
  reason?: string;
}): Promise<number> {
  const hostId = cleanRequiredUuid(host_id, "host_id");
  await ensureAiSessionsSchema();
  const { rowCount } = await getPool().query(
    `
      UPDATE ${TABLE}
      SET state='host_stopped',
          terminal=TRUE,
          updated_at=NOW(),
          finished_at=COALESCE(finished_at, NOW()),
          error=COALESCE(error, $2),
          metadata=COALESCE(metadata, '{}'::jsonb) ||
                   jsonb_build_object('reconciliation_reason', 'host_stopped')
      WHERE host_id=$1::UUID
        AND terminal IS NOT TRUE
    `,
    [hostId, cleanText(reason, 2048) ?? "host stopped"],
  );
  return rowCount ?? 0;
}

export async function runAiSessionReconciliationMaintenanceTick(): Promise<
  number | null
> {
  if (reconciliationRunning) return null;
  reconciliationRunning = true;
  try {
    const count = await markStaleAiSessionsPossiblyActive();
    if (count > 0) {
      logger.info("AI session reconciliation marked stale sessions", {
        count,
      });
    }
    return count;
  } catch (err) {
    logger.warn("AI session reconciliation failed", { err: `${err}` });
    throw err;
  } finally {
    reconciliationRunning = false;
  }
}

export function startAiSessionReconciliationMaintenance(): void {
  if (!RECONCILIATION_ENABLED) {
    logger.info("AI session reconciliation maintenance disabled");
    return;
  }
  if (reconciliationTimer) return;
  reconciliationTimer = setInterval(() => {
    void runAiSessionReconciliationMaintenanceTick();
  }, RECONCILIATION_INTERVAL_MS);
  reconciliationTimer.unref?.();
  void runAiSessionReconciliationMaintenanceTick();
  logger.info("AI session reconciliation maintenance started", {
    interval_ms: RECONCILIATION_INTERVAL_MS,
  });
}

export function stopAiSessionReconciliationMaintenance(): void {
  if (!reconciliationTimer) return;
  clearInterval(reconciliationTimer);
  reconciliationTimer = undefined;
}

export function resetAiSessionReconciliationMaintenanceStateForTests(): void {
  stopAiSessionReconciliationMaintenance();
  reconciliationRunning = false;
}
