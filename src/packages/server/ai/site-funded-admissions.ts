/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

// Every site-funded admission attempt and how it ended, on the seed bay, so
// admins can see who tries included AI and why it is refused. One row per
// funded turn: a host's retries of the same turn update it, never add rows.

import getPool from "@cocalc/database/pool";
import {
  SITE_FUNDED_ADMISSION_OUTCOMES,
  type SiteFundedAdmissionRecord,
  type SiteFundedFunnel,
} from "@cocalc/util/ai/site-funded-codex";
import { isValidUUID } from "@cocalc/util/misc";
import { ensureSiteFundedCodexReservationTables } from "./site-funded-codex-reservations";

export const SITE_FUNDED_ADMISSION_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;

let tableReady: Promise<void> | undefined;

export async function ensureSiteFundedAdmissionTable(): Promise<void> {
  tableReady ??= (async () => {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_ai_admission_attempts (
        funded_turn_id UUID PRIMARY KEY,
        account_id UUID NOT NULL,
        provider TEXT NOT NULL,
        outcome TEXT NOT NULL,
        membership_tier TEXT,
        surface TEXT,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS site_ai_admission_attempts_attempted_idx
        ON site_ai_admission_attempts(attempted_at)`);
  })().catch((err) => {
    tableReady = undefined;
    throw err;
  });
  await tableReady;
}

function shortText(value: unknown): string | null {
  const text = `${value ?? ""}`.trim();
  return text ? text.slice(0, 64) : null;
}

export async function recordSiteFundedAdmissionLocal(
  record: SiteFundedAdmissionRecord,
): Promise<void> {
  if (
    !isValidUUID(record.fundedTurnId) ||
    !isValidUUID(record.accountId) ||
    (record.provider !== "openai" && record.provider !== "anthropic") ||
    !SITE_FUNDED_ADMISSION_OUTCOMES.includes(record.outcome)
  ) {
    throw new Error("invalid site-funded admission record");
  }
  await ensureSiteFundedAdmissionTable();
  await getPool().query(
    `INSERT INTO site_ai_admission_attempts
       (funded_turn_id, account_id, provider, outcome, membership_tier, surface)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (funded_turn_id) DO UPDATE
       SET outcome = EXCLUDED.outcome,
           membership_tier = COALESCE(EXCLUDED.membership_tier,
             site_ai_admission_attempts.membership_tier),
           decided_at = NOW()`,
    [
      record.fundedTurnId,
      record.accountId,
      record.provider,
      record.outcome,
      shortText(record.membershipTier),
      shortText(record.surface),
    ],
  );
}

export async function pruneSiteFundedAdmissions(): Promise<number> {
  await ensureSiteFundedAdmissionTable();
  const { rowCount } = await getPool().query(
    `DELETE FROM site_ai_admission_attempts
     WHERE attempted_at < NOW() - make_interval(days => $1)`,
    [SITE_FUNDED_ADMISSION_RETENTION_DAYS],
  );
  return rowCount ?? 0;
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export async function getSiteFundedFunnel({
  days = 7,
  now = new Date(),
}: { days?: number; now?: Date } = {}): Promise<SiteFundedFunnel> {
  await Promise.all([
    ensureSiteFundedAdmissionTable(),
    ensureSiteFundedCodexReservationTables(),
  ]);
  const periodStart = new Date(now.valueOf() - days * DAY_MS);
  // Exclusive, one millisecond past now: the database stamps rows to the
  // microsecond, so a row from now's own millisecond would otherwise fall
  // after it.
  const periodEnd = new Date(now.valueOf() + 1);
  const pool = getPool();
  const [totals, outcomes, turns] = await Promise.all([
    pool.query(
      `SELECT count(*) AS attempts,
              count(DISTINCT account_id) AS accounts,
              count(DISTINCT account_id) FILTER (WHERE outcome = 'allowed')
                AS admitted_accounts
       FROM site_ai_admission_attempts
       WHERE attempted_at >= $1 AND attempted_at < $2`,
      [periodStart, periodEnd],
    ),
    pool.query(
      `SELECT outcome, count(*) AS attempts,
              count(DISTINCT account_id) AS accounts
       FROM site_ai_admission_attempts
       WHERE attempted_at >= $1 AND attempted_at < $2
       GROUP BY outcome
       ORDER BY attempts DESC, outcome`,
      [periodStart, periodEnd],
    ),
    pool.query(
      `SELECT status, count(*) AS turns,
              count(DISTINCT account_id) AS accounts,
              COALESCE(sum(committed_microusd), 0) AS committed_microusd
       FROM site_ai_turn_reservations
       WHERE started_at >= $1 AND started_at < $2
       GROUP BY status
       ORDER BY turns DESC, status`,
      [periodStart, periodEnd],
    ),
  ]);
  const total = totals.rows[0] ?? {};
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: now.toISOString(),
    attempts: count(total.attempts),
    accounts: count(total.accounts),
    admittedAccounts: count(total.admitted_accounts),
    outcomes: outcomes.rows.map((row) => ({
      outcome: `${row.outcome}`,
      attempts: count(row.attempts),
      accounts: count(row.accounts),
    })),
    turns: turns.rows.map((row) => ({
      status: `${row.status}`,
      turns: count(row.turns),
      accounts: count(row.accounts),
      committedMicrousd: count(row.committed_microusd),
    })),
  };
}
