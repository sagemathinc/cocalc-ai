/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { assertProjectCollaboratorAccessAllowRemote } from "@cocalc/server/conat/project-remote-access";
import type {
  AiSessionRecord,
  AiSessionsListOptions,
  AiSessionState,
} from "@cocalc/conat/hub/api/ai-sessions";
import { isValidUUID } from "@cocalc/util/misc";

const TABLE = "ai_sessions";
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const MAX_TEXT_BYTES = 8192;

const TERMINAL_STATES = new Set<AiSessionState>([
  "completed",
  "failed",
  "interrupted",
  "canceled",
  "host_stopped",
]);

let schemaReady: Promise<void> | undefined;

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
