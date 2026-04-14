/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AcpAutomationConfig,
  AcpAutomationRecord,
  AcpAutomationState,
} from "@cocalc/conat/ai/acp/types";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_automations";

export interface AcpAutomationRow {
  automation_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  account_id: string;
  enabled: boolean;
  title?: string | null;
  run_kind?: "codex" | "command" | null;
  prompt?: string | null;
  command?: string | null;
  command_cwd?: string | null;
  command_timeout_ms?: number | null;
  command_max_output_bytes?: number | null;
  schedule_type?: "daily" | "interval" | null;
  days_of_week?: number[] | null;
  local_time?: string | null;
  interval_minutes?: number | null;
  window_start_local_time?: string | null;
  window_end_local_time?: string | null;
  timezone?: string | null;
  pause_after_unacknowledged_runs?: number | null;
  status: "active" | "running" | "paused" | "error";
  next_run_at?: number | null;
  last_run_started_at?: number | null;
  last_run_finished_at?: number | null;
  last_acknowledged_at?: number | null;
  unacknowledged_runs: number;
  paused_reason?: string | null;
  last_error?: string | null;
  last_job_op_id?: string | null;
  last_message_id?: string | null;
  created_at: number;
  updated_at: number;
}

function init(): void {
  const db = getAcpDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      title TEXT,
      run_kind TEXT,
      prompt TEXT,
      command TEXT,
      command_cwd TEXT,
      command_timeout_ms INTEGER,
      command_max_output_bytes INTEGER,
      schedule_type TEXT,
      days_of_week TEXT,
      local_time TEXT,
      interval_minutes INTEGER,
      window_start_local_time TEXT,
      window_end_local_time TEXT,
      timezone TEXT,
      pause_after_unacknowledged_runs INTEGER,
      status TEXT NOT NULL,
      next_run_at INTEGER,
      last_run_started_at INTEGER,
      last_run_finished_at INTEGER,
      last_acknowledged_at INTEGER,
      unacknowledged_runs INTEGER NOT NULL DEFAULT 0,
      paused_reason TEXT,
      last_error TEXT,
      last_job_op_id TEXT,
      last_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(project_id, path, thread_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_automations_due_idx ON ${TABLE}(enabled, status, next_run_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_automations_project_idx ON ${TABLE}(project_id, path, thread_id)`,
  );
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const hasColumn = (name: string): boolean =>
    columns.some((x) => x?.name === name);
  if (!hasColumn("days_of_week")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN days_of_week TEXT`);
  }
  if (!hasColumn("interval_minutes")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN interval_minutes INTEGER`);
  }
  if (!hasColumn("window_start_local_time")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN window_start_local_time TEXT`);
  }
  if (!hasColumn("window_end_local_time")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN window_end_local_time TEXT`);
  }
  if (!hasColumn("run_kind")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN run_kind TEXT`);
  }
  if (!hasColumn("command")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN command TEXT`);
  }
  if (!hasColumn("command_cwd")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN command_cwd TEXT`);
  }
  if (!hasColumn("command_timeout_ms")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN command_timeout_ms INTEGER`);
  }
  if (!hasColumn("command_max_output_bytes")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN command_max_output_bytes INTEGER`);
  }
  ensureAcpTableMigrated(TABLE);
}

let initialized = false;

function ensureInit(): void {
  if (!initialized) {
    init();
    initialized = true;
  }
}

function encodeBool(value: boolean | undefined): number {
  return value === false ? 0 : 1;
}

function decodeRow(row: any): AcpAutomationRow | undefined {
  if (!row) return undefined;
  return {
    ...row,
    enabled: !!row.enabled,
    run_kind:
      row.run_kind === "command"
        ? "command"
        : row.run_kind === "codex"
          ? "codex"
          : null,
    days_of_week: decodeDaysOfWeek(row.days_of_week) ?? null,
    command_timeout_ms:
      row.command_timeout_ms == null ? null : Number(row.command_timeout_ms),
    command_max_output_bytes:
      row.command_max_output_bytes == null
        ? null
        : Number(row.command_max_output_bytes),
    pause_after_unacknowledged_runs:
      row.pause_after_unacknowledged_runs == null
        ? null
        : Number(row.pause_after_unacknowledged_runs),
    interval_minutes:
      row.interval_minutes == null ? null : Number(row.interval_minutes),
    next_run_at: row.next_run_at == null ? null : Number(row.next_run_at),
    last_run_started_at:
      row.last_run_started_at == null ? null : Number(row.last_run_started_at),
    last_run_finished_at:
      row.last_run_finished_at == null
        ? null
        : Number(row.last_run_finished_at),
    last_acknowledged_at:
      row.last_acknowledged_at == null
        ? null
        : Number(row.last_acknowledged_at),
    unacknowledged_runs: Number(row.unacknowledged_runs ?? 0),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  } as AcpAutomationRow;
}

function encodeDaysOfWeek(value?: number[] | null): string | null {
  return Array.isArray(value) && value.length > 0
    ? JSON.stringify(value)
    : null;
}

function decodeDaysOfWeek(value?: string | null): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .map((day) => Number(day))
          .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      : undefined;
  } catch {
    return undefined;
  }
}

export function getAcpAutomationByThread(opts: {
  project_id: string;
  path: string;
  thread_id: string;
}): AcpAutomationRow | undefined {
  ensureInit();
  const db = getAcpDatabase();
  return decodeRow(
    db
      .prepare(
        `SELECT * FROM ${TABLE}
         WHERE project_id = ? AND path = ? AND thread_id = ?`,
      )
      .get(opts.project_id, opts.path, opts.thread_id),
  );
}

export function getAcpAutomationById(
  automation_id: string,
): AcpAutomationRow | undefined {
  ensureInit();
  const db = getAcpDatabase();
  return decodeRow(
    db
      .prepare(`SELECT * FROM ${TABLE} WHERE automation_id = ?`)
      .get(automation_id),
  );
}

export function upsertAcpAutomation(
  row: Omit<AcpAutomationRow, "created_at" | "updated_at"> & {
    created_at?: number;
    updated_at?: number;
  },
): AcpAutomationRow {
  ensureInit();
  const db = getAcpDatabase();
  const now = row.updated_at ?? Date.now();
  const created_at = row.created_at ?? now;
  db.prepare(
    `INSERT INTO ${TABLE}
      (automation_id, project_id, path, thread_id, account_id, enabled, title, run_kind, prompt, command, command_cwd, command_timeout_ms, command_max_output_bytes, schedule_type, days_of_week, local_time, interval_minutes, window_start_local_time, window_end_local_time, timezone, pause_after_unacknowledged_runs, status, next_run_at, last_run_started_at, last_run_finished_at, last_acknowledged_at, unacknowledged_runs, paused_reason, last_error, last_job_op_id, last_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(automation_id) DO UPDATE SET
        project_id=excluded.project_id,
        path=excluded.path,
        thread_id=excluded.thread_id,
        account_id=excluded.account_id,
        enabled=excluded.enabled,
        title=excluded.title,
        run_kind=excluded.run_kind,
        prompt=excluded.prompt,
        command=excluded.command,
        command_cwd=excluded.command_cwd,
        command_timeout_ms=excluded.command_timeout_ms,
        command_max_output_bytes=excluded.command_max_output_bytes,
        schedule_type=excluded.schedule_type,
        days_of_week=excluded.days_of_week,
        local_time=excluded.local_time,
        interval_minutes=excluded.interval_minutes,
        window_start_local_time=excluded.window_start_local_time,
        window_end_local_time=excluded.window_end_local_time,
        timezone=excluded.timezone,
        pause_after_unacknowledged_runs=excluded.pause_after_unacknowledged_runs,
        status=excluded.status,
        next_run_at=excluded.next_run_at,
        last_run_started_at=excluded.last_run_started_at,
        last_run_finished_at=excluded.last_run_finished_at,
        last_acknowledged_at=excluded.last_acknowledged_at,
        unacknowledged_runs=excluded.unacknowledged_runs,
        paused_reason=excluded.paused_reason,
        last_error=excluded.last_error,
        last_job_op_id=excluded.last_job_op_id,
        last_message_id=excluded.last_message_id,
        updated_at=excluded.updated_at`,
  ).run(
    row.automation_id,
    row.project_id,
    row.path,
    row.thread_id,
    row.account_id,
    encodeBool(row.enabled),
    row.title ?? null,
    row.run_kind ?? null,
    row.prompt ?? null,
    row.command ?? null,
    row.command_cwd ?? null,
    row.command_timeout_ms ?? null,
    row.command_max_output_bytes ?? null,
    row.schedule_type ?? null,
    encodeDaysOfWeek(row.days_of_week),
    row.local_time ?? null,
    row.interval_minutes ?? null,
    row.window_start_local_time ?? null,
    row.window_end_local_time ?? null,
    row.timezone ?? null,
    row.pause_after_unacknowledged_runs ?? null,
    row.status,
    row.next_run_at ?? null,
    row.last_run_started_at ?? null,
    row.last_run_finished_at ?? null,
    row.last_acknowledged_at ?? null,
    row.unacknowledged_runs ?? 0,
    row.paused_reason ?? null,
    row.last_error ?? null,
    row.last_job_op_id ?? null,
    row.last_message_id ?? null,
    created_at,
    now,
  );
  return getAcpAutomationById(row.automation_id)!;
}

export function deleteAcpAutomationByThread(opts: {
  project_id: string;
  path: string;
  thread_id: string;
}): void {
  ensureInit();
  getAcpDatabase()
    .prepare(
      `DELETE FROM ${TABLE}
       WHERE project_id = ? AND path = ? AND thread_id = ?`,
    )
    .run(opts.project_id, opts.path, opts.thread_id);
}

export function listDueAcpAutomations(
  dueAt: number = Date.now(),
): AcpAutomationRow[] {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE enabled = 1
         AND status IN ('active', 'error')
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC, updated_at ASC`,
    )
    .all(dueAt)
    .map((row) => decodeRow(row)!)
    .filter(Boolean);
}

export function listAcpAutomationsForProject(
  project_id: string,
): AcpAutomationRow[] {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(project_id)
    .map((row) => decodeRow(row)!)
    .filter(Boolean);
}

export function deleteAcpAutomationsForProject(project_id: string): void {
  ensureInit();
  getAcpDatabase()
    .prepare(
      `DELETE FROM ${TABLE}
       WHERE project_id = ?`,
    )
    .run(project_id);
}

export function listAllAcpAutomations(): AcpAutomationRow[] {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       ORDER BY updated_at DESC`,
    )
    .all()
    .map((row) => decodeRow(row)!)
    .filter(Boolean);
}

export function toAutomationConfig(
  row?: AcpAutomationRow,
): AcpAutomationConfig | undefined {
  if (!row) return undefined;
  return {
    enabled: row.enabled,
    automation_id: row.automation_id,
    title: row.title ?? undefined,
    run_kind: row.run_kind ?? undefined,
    prompt: row.prompt ?? undefined,
    command: row.command ?? undefined,
    command_cwd: row.command_cwd ?? undefined,
    command_timeout_ms: row.command_timeout_ms ?? undefined,
    command_max_output_bytes: row.command_max_output_bytes ?? undefined,
    schedule_type: row.schedule_type ?? undefined,
    days_of_week: row.days_of_week ?? undefined,
    local_time: row.local_time ?? undefined,
    interval_minutes: row.interval_minutes ?? undefined,
    window_start_local_time: row.window_start_local_time ?? undefined,
    window_end_local_time: row.window_end_local_time ?? undefined,
    timezone: row.timezone ?? undefined,
    pause_after_unacknowledged_runs:
      row.pause_after_unacknowledged_runs ?? undefined,
  };
}

export function toAutomationState(
  row?: AcpAutomationRow,
): AcpAutomationState | undefined {
  if (!row) return undefined;
  return {
    automation_id: row.automation_id,
    status: row.status,
    next_run_at_ms: row.next_run_at ?? undefined,
    last_run_started_at_ms: row.last_run_started_at ?? undefined,
    last_run_finished_at_ms: row.last_run_finished_at ?? undefined,
    last_acknowledged_at_ms: row.last_acknowledged_at ?? undefined,
    unacknowledged_runs: row.unacknowledged_runs ?? undefined,
    paused_reason: row.paused_reason ?? undefined,
    last_error: row.last_error ?? undefined,
    last_job_op_id: row.last_job_op_id ?? undefined,
    last_message_id: row.last_message_id ?? undefined,
  };
}

export function toAutomationRecord(
  row?: AcpAutomationRow,
): AcpAutomationRecord | undefined {
  if (!row) return undefined;
  return {
    automation_id: row.automation_id,
    project_id: row.project_id,
    path: row.path,
    thread_id: row.thread_id,
    account_id: row.account_id,
    title: row.title ?? undefined,
    run_kind: row.run_kind ?? undefined,
    prompt: row.prompt ?? undefined,
    command: row.command ?? undefined,
    command_cwd: row.command_cwd ?? undefined,
    command_timeout_ms: row.command_timeout_ms ?? undefined,
    command_max_output_bytes: row.command_max_output_bytes ?? undefined,
    schedule_type: row.schedule_type ?? undefined,
    days_of_week: row.days_of_week ?? undefined,
    local_time: row.local_time ?? undefined,
    interval_minutes: row.interval_minutes ?? undefined,
    window_start_local_time: row.window_start_local_time ?? undefined,
    window_end_local_time: row.window_end_local_time ?? undefined,
    timezone: row.timezone ?? undefined,
    pause_after_unacknowledged_runs:
      row.pause_after_unacknowledged_runs ?? undefined,
    status: row.status,
    enabled: row.enabled,
    next_run_at_ms: row.next_run_at ?? undefined,
    last_run_started_at_ms: row.last_run_started_at ?? undefined,
    last_run_finished_at_ms: row.last_run_finished_at ?? undefined,
    last_acknowledged_at_ms: row.last_acknowledged_at ?? undefined,
    unacknowledged_runs: row.unacknowledged_runs ?? undefined,
    paused_reason: row.paused_reason ?? undefined,
    last_error: row.last_error ?? undefined,
    last_job_op_id: row.last_job_op_id ?? undefined,
    last_message_id: row.last_message_id ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
