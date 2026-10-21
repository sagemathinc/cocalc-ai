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

/** Being sent now (see claimAgentRpcReport), until its lease ends. */
const IN_FLIGHT = "in flight";
/** A claim this old was lost (its process died): the report is due again. */
export const AGENT_RPC_REPORT_CLAIM_MS = 5 * 60_000;

/** Claim a due report before sending it; false if it is gone (withdrawn,
 * say) or another process is sending it. */
export function claimAgentRpcReport(
  report_id: string,
  now = Date.now(),
): boolean {
  ensureInit();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE} SET next_attempt_at = ?, last_error = ?
         WHERE report_id = ? AND next_attempt_at <= ?`,
    )
    .run(now + AGENT_RPC_REPORT_CLAIM_MS, IN_FLIGHT, report_id, now);
  return Number(result?.changes ?? 0) === 1;
}

/**
 * Take a report back before it is sent: the row, once removed (put it back
 * with restoreAgentRpcReport if the reason for taking it goes away);
 * "in-flight" if it is being sent right now; undefined if there is none.
 */
export function takeAgentRpcReportByOpId(
  op_id: string,
  now = Date.now(),
): AgentRpcReportRow | "in-flight" | undefined {
  ensureInit();
  const db = getAcpDatabase();
  const row = db
    .prepare(
      `SELECT report_id, op_id, account_id, report_json, attempts, next_attempt_at, created_at
         FROM ${TABLE} WHERE op_id = ?`,
    )
    .get(op_id) as any;
  if (!row) return;
  // One statement, so a claim in another process either came first (and
  // this deletes nothing) or never happens.
  const result = db
    .prepare(
      `DELETE FROM ${TABLE}
         WHERE report_id = ?
           AND NOT (last_error IS ? AND next_attempt_at > ?)`,
    )
    .run(row.report_id, IN_FLIGHT, now);
  if (Number(result?.changes ?? 0) !== 1) return "in-flight";
  const { report_json, ...rest } = row;
  return { ...rest, report: JSON.parse(report_json) };
}

/**
 * Put back a report taken with takeAgentRpcReportByOpId, but only while one
 * of `whileQueued` (the held turn) is still queued, checked in the same
 * statement: once that turn started or ended, its own report supersedes
 * this one, which would only arrive out of date.
 */
export function restoreAgentRpcReport(
  row: AgentRpcReportRow,
  whileQueued: string[],
): boolean {
  ensureInit();
  if (whileQueued.length === 0) return false;
  const result = getAcpDatabase()
    .prepare(
      `INSERT OR IGNORE INTO ${TABLE}
         (report_id, op_id, account_id, report_json, attempts, next_attempt_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM acp_jobs
         WHERE state = 'queued'
           AND op_id IN (${whileQueued.map(() => "?").join(", ")})
       )`,
    )
    .run(
      row.report_id,
      row.op_id,
      row.account_id,
      JSON.stringify(row.report),
      row.attempts,
      row.next_attempt_at,
      row.created_at,
      ...whileQueued,
    );
  return Number(result?.changes ?? 0) === 1;
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
