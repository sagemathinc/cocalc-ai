/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Outbox of delivery reports (see conat/agents/rpc-reports.ts): written when
// a turn another agent's message started ends in an error, sent to the hub
// until it is delivered, refused or a day old. One report per failed job.

import type { AgentRpcTurnFailureReport } from "@cocalc/conat/agents/rpc-reports";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_agent_rpc_reports";
/** A report older than this is no longer useful to the sender. */
export const AGENT_RPC_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface AgentRpcReportRow {
  report_id: string;
  op_id: string;
  account_id: string;
  report: AgentRpcTurnFailureReport;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
}

let initializedDatabase: ReturnType<typeof getAcpDatabase> | undefined;
function ensureInit(): void {
  const db = getAcpDatabase();
  if (initializedDatabase === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      report_id TEXT PRIMARY KEY,
      op_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      report_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_due_idx ON ${TABLE}(next_attempt_at)`,
  );
  ensureAcpTableMigrated(TABLE);
  initializedDatabase = db;
}

/** Queue a report for a failed job; a job is reported at most once. */
export function enqueueAgentRpcReport(opts: {
  op_id: string;
  account_id: string;
  report: AgentRpcTurnFailureReport;
  now?: number;
}): boolean {
  ensureInit();
  const now = opts.now ?? Date.now();
  const result = getAcpDatabase()
    .prepare(
      `INSERT OR IGNORE INTO ${TABLE}
         (report_id, op_id, account_id, report_json, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      opts.report.report_id,
      opts.op_id,
      opts.account_id,
      JSON.stringify(opts.report),
      now,
      now,
    );
  return Number(result?.changes ?? 0) === 1;
}

/** Reports to send now; those past their age are dropped first. */
export function listDueAgentRpcReports(
  now = Date.now(),
  limit = 20,
): AgentRpcReportRow[] {
  ensureInit();
  const db = getAcpDatabase();
  db.prepare(`DELETE FROM ${TABLE} WHERE created_at < ?`).run(
    now - AGENT_RPC_REPORT_MAX_AGE_MS,
  );
  const rows = db
    .prepare(
      `SELECT report_id, op_id, account_id, report_json, attempts, next_attempt_at, created_at
         FROM ${TABLE} WHERE next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ?`,
    )
    .all(now, limit) as any[];
  return rows.map(({ report_json, ...row }) => ({
    ...row,
    report: JSON.parse(report_json),
  }));
}

/** Drop a queued report by its job key (e.g. a held report, once the
 * final one is queued: it would only arrive out of date). */
export function deleteAgentRpcReportByOpId(op_id: string): void {
  ensureInit();
  getAcpDatabase().prepare(`DELETE FROM ${TABLE} WHERE op_id = ?`).run(op_id);
}

/** Done: delivered, refused, or the sender already had a reply. */
export function deleteAgentRpcReport(report_id: string): void {
  ensureInit();
  getAcpDatabase()
    .prepare(`DELETE FROM ${TABLE} WHERE report_id = ?`)
    .run(report_id);
}

/** Try again later: 1, 2, 4, ... minutes, at most 30 between tries. */
export function retryAgentRpcReport(
  report_id: string,
  error: string,
  now = Date.now(),
): void {
  ensureInit();
  const db = getAcpDatabase();
  const row = db
    .prepare(`SELECT attempts FROM ${TABLE} WHERE report_id = ?`)
    .get(report_id) as { attempts?: number } | undefined;
  const attempts = Number(row?.attempts ?? 0) + 1;
  const delay = Math.min(30, 2 ** (attempts - 1)) * 60_000;
  db.prepare(
    `UPDATE ${TABLE} SET attempts = ?, next_attempt_at = ?, last_error = ?
       WHERE report_id = ?`,
  ).run(attempts, now + delay, error.slice(0, 500), report_id);
}
