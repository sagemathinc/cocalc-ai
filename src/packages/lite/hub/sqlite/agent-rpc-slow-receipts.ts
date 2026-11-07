/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Agent messages whose launch acknowledgment timed out although admission
// had started: the turn may well be queued. One row per such attempt, so the
// reconcile poll (agent-rpc-slow-receipts in ../acp) can find the turn later
// and settle the chat's receipt, also after a restart. A row is written
// before the receipt says "slow", and removed only once the receipt was made
// final (or already was), so a receipt is never left "slow" without a row.

import type { AgentRpcSource, AgentRpcTarget } from "@cocalc/conat/agents/rpc";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_agent_rpc_slow_receipts";
/** At most this many rows; a further slow receipt gets no row (and so is not
 * marked slow). Rows are never evicted for it. */
export const SLOW_RECEIPT_MAX_ROWS = 1000;
/** No turn by then: the receipt becomes plain unknown. */
export const SLOW_RECEIPT_EXPIRY_MS = 30 * 60_000;
/** Due again this long after each check (the last one repeats). */
const SLOW_RECEIPT_BACKOFF_MS = [5_000, 30_000, 2 * 60_000, 5 * 60_000];

/** What a row is about. All of it comes from the authorized envelope and the
 * saved message, never from message content. */
export interface SlowReceiptBinding {
  attempt_id: string;
  agent_network_id: string;
  source: AgentRpcSource;
  target: AgentRpcTarget;
  /** The envelope's authorized principal (the turn's account). */
  account_id: string;
  /** The chat, and its message (primary key fields). */
  project_id: string;
  path: string;
  message_date: string;
  sender_id: string;
  message_id: string;
}

export interface SlowReceiptRow extends SlowReceiptBinding {
  created_at: number;
  next_check_at: number;
  checks: number;
}

// Compared on a conflicting insert: a row for this attempt id is this row
// only if all of these are equal.
const BINDING_COLUMNS = [
  "agent_network_id",
  "source_json",
  "target_json",
  "account_id",
  "project_id",
  "path",
  "message_date",
  "sender_id",
  "message_id",
] as const;

let initializedDatabase: ReturnType<typeof getAcpDatabase> | undefined;
function ensureInit(): void {
  const db = getAcpDatabase();
  if (initializedDatabase === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      attempt_id TEXT PRIMARY KEY,
      agent_network_id TEXT NOT NULL,
      source_json TEXT NOT NULL,
      target_json TEXT NOT NULL,
      account_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_date TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      next_check_at INTEGER NOT NULL,
      checks INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_due_idx ON ${TABLE}(next_check_at)`,
  );
  ensureAcpTableMigrated(TABLE);
  initializedDatabase = db;
}

// Sources and targets are flat records; sorted keys make equal ones compare
// equal however they were built.
function canonical(value: object): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

function columns(b: SlowReceiptBinding) {
  return {
    agent_network_id: b.agent_network_id,
    source_json: canonical(b.source),
    target_json: canonical(b.target),
    account_id: b.account_id,
    project_id: b.project_id,
    path: b.path,
    message_date: b.message_date,
    sender_id: b.sender_id,
    message_id: b.message_id,
  };
}

function fromRow(row: any): SlowReceiptRow {
  const { source_json, target_json, ...rest } = row;
  return {
    ...rest,
    source: JSON.parse(source_json),
    target: JSON.parse(target_json),
  };
}

/**
 * Record a slow receipt before the chat says so. "recorded": this attempt's
 * row is in place (inserted now, or already there with the same binding);
 * "full": no row, the table is at its cap; "conflict": a row for this attempt
 * id with another binding exists, and is left as it is.
 */
export function recordSlowReceipt(
  binding: SlowReceiptBinding,
  now = Date.now(),
): "recorded" | "full" | "conflict" {
  ensureInit();
  const db = getAcpDatabase();
  const values = columns(binding);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(`SELECT * FROM ${TABLE} WHERE attempt_id = ?`)
      .get(binding.attempt_id) as Record<string, unknown> | undefined;
    let result: "recorded" | "full" | "conflict";
    if (existing) {
      result = BINDING_COLUMNS.every((key) => existing[key] === values[key])
        ? "recorded"
        : "conflict";
    } else {
      const { count } = db
        .prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`)
        .get() as { count: number };
      if (Number(count) >= SLOW_RECEIPT_MAX_ROWS) {
        result = "full";
      } else {
        db.prepare(
          `INSERT INTO ${TABLE}
             (attempt_id, ${BINDING_COLUMNS.join(", ")}, created_at, next_check_at, checks)
           VALUES (?, ${BINDING_COLUMNS.map(() => "?").join(", ")}, ?, ?, 0)`,
        ).run(
          binding.attempt_id,
          ...BINDING_COLUMNS.map((key) => values[key]),
          now,
          now + SLOW_RECEIPT_BACKOFF_MS[0],
        );
        result = "recorded";
      }
    }
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Claim the rows due now, oldest first: each is due again only after its
 * next backoff (never later than its expiry), so a pass that fails or a
 * process that dies leaves it to a later pass, and two passes never get the
 * same row.
 */
export function claimDueSlowReceipts(
  now = Date.now(),
  limit = 50,
): SlowReceiptRow[] {
  ensureInit();
  const db = getAcpDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = (
      db
        .prepare(
          `SELECT * FROM ${TABLE} WHERE next_check_at <= ?
           ORDER BY created_at ASC, attempt_id ASC LIMIT ?`,
        )
        .all(now, limit) as any[]
    ).map(fromRow);
    const update = db.prepare(
      `UPDATE ${TABLE} SET checks = ?, next_check_at = ? WHERE attempt_id = ?`,
    );
    for (const row of rows) {
      const checks = row.checks + 1;
      const delay =
        SLOW_RECEIPT_BACKOFF_MS[
          Math.min(checks, SLOW_RECEIPT_BACKOFF_MS.length - 1)
        ];
      const expiry = row.created_at + SLOW_RECEIPT_EXPIRY_MS;
      const next = now < expiry ? Math.min(now + delay, expiry) : now + delay;
      update.run(checks, next, row.attempt_id);
      row.checks = checks;
      row.next_check_at = next;
    }
    db.exec("COMMIT");
    return rows;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Remove this attempt's row, only if it still has this binding. */
export function deleteSlowReceipt(binding: SlowReceiptBinding): boolean {
  ensureInit();
  const values = columns(binding);
  const result = getAcpDatabase()
    .prepare(
      `DELETE FROM ${TABLE} WHERE attempt_id = ? AND ${BINDING_COLUMNS.map((key) => `${key} = ?`).join(" AND ")}`,
    )
    .run(binding.attempt_id, ...BINDING_COLUMNS.map((key) => values[key]));
  return Number(result?.changes ?? 0) === 1;
}

/** Rows (for tests and diagnostics). */
export function listSlowReceipts(): SlowReceiptRow[] {
  ensureInit();
  return (
    getAcpDatabase()
      .prepare(`SELECT * FROM ${TABLE} ORDER BY created_at ASC`)
      .all() as any[]
  ).map(fromRow);
}

export function countSlowReceipts(): number {
  ensureInit();
  const { count } = getAcpDatabase()
    .prepare(`SELECT COUNT(*) AS count FROM ${TABLE}`)
    .get() as { count: number };
  return Number(count);
}
