/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  ensureSiteFundedCodexReservationTables,
  siteAiFundingPeriodBounds,
  SITE_AI_GLOBAL_POOL_ID,
} from "./site-funded-codex-reservations";
import { getSiteFundedAIGlobalPoolLimitMicrousd } from "./site-funded-codex-policy";

const RESERVATION_TTL_MS = 5 * 60_000;

export interface SiteFundedSpeechGlobalReservation {
  requestId: string;
  reservedMicrousd: number;
  created: boolean;
}

export async function ensureSiteFundedSpeechReservationTable(): Promise<void> {
  await ensureSiteFundedCodexReservationTables();
}

function codedError(message: string, code: number): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

function integer(value: unknown): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new Error("invalid funding amount");
  return result;
}

export async function reserveSiteFundedSpeechGlobalLocal({
  requestId,
  accountId,
  reservedMicrousd,
}: {
  requestId: string;
  accountId: string;
  reservedMicrousd: number;
}): Promise<SiteFundedSpeechGlobalReservation> {
  if (!Number.isSafeInteger(reservedMicrousd) || reservedMicrousd <= 0) {
    throw new Error("reservedMicrousd must be a positive safe integer");
  }
  await ensureSiteFundedSpeechReservationTable();
  const globalPoolLimitMicrousd =
    await getSiteFundedAIGlobalPoolLimitMicrousd();
  const { start, end } = siteAiFundingPeriodBounds();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO site_ai_funding_periods
         (pool_id, period_start, period_end, limit_microusd,
          reserved_microusd, committed_microusd, policy_version)
       SELECT $1, $2, $3, $4,
         COALESCE(SUM(reserved_microusd), 0),
         COALESCE(SUM(committed_microusd), 0), $5
       FROM site_ai_funding_periods
       WHERE period_start=$2 AND pool_id<>$1
       ON CONFLICT (pool_id, period_start) DO UPDATE SET
         limit_microusd=EXCLUDED.limit_microusd,
         policy_version=EXCLUDED.policy_version,
         updated_at=NOW()`,
      [SITE_AI_GLOBAL_POOL_ID, start, end, globalPoolLimitMicrousd, 1],
    );
    await client.query(
      `SELECT pool_id FROM site_ai_funding_periods
       WHERE pool_id=$1 AND period_start=$2 FOR UPDATE`,
      [SITE_AI_GLOBAL_POOL_ID, start],
    );
    const expired = await client.query(
      `UPDATE site_ai_speech_reservations SET
         status='expired', completed_at=NOW()
       WHERE period_start=$1 AND status='active' AND expires_at<=NOW()
       RETURNING reserved_microusd`,
      [start],
    );
    const expiredMicrousd = expired.rows.reduce(
      (sum, row) => sum + integer(row.reserved_microusd),
      0,
    );
    if (expiredMicrousd > 0) {
      await client.query(
        `UPDATE site_ai_funding_periods SET
           reserved_microusd=GREATEST(0, reserved_microusd-$3),
           updated_at=NOW()
         WHERE pool_id=$1 AND period_start=$2`,
        [SITE_AI_GLOBAL_POOL_ID, start, expiredMicrousd],
      );
    }
    const existing = await client.query(
      `SELECT account_id, status, reserved_microusd
       FROM site_ai_speech_reservations
       WHERE request_id=$1`,
      [requestId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].status !== "active") {
        throw codedError("This speech request has already completed.", 409);
      }
      if (
        existing.rows[0].account_id !== accountId ||
        integer(existing.rows[0].reserved_microusd) !== reservedMicrousd
      ) {
        throw codedError(
          "This speech request identifier is already in use.",
          409,
        );
      }
      await client.query("COMMIT");
      return {
        requestId,
        reservedMicrousd: integer(existing.rows[0].reserved_microusd),
        created: false,
      };
    }
    const period = await client.query(
      `SELECT limit_microusd, reserved_microusd, committed_microusd
       FROM site_ai_funding_periods
       WHERE pool_id=$1 AND period_start=$2`,
      [SITE_AI_GLOBAL_POOL_ID, start],
    );
    const row = period.rows[0];
    if (
      !row ||
      integer(row.reserved_microusd) +
        integer(row.committed_microusd) +
        reservedMicrousd >
        integer(row.limit_microusd)
    ) {
      throw codedError(
        "CoCalc's included AI capacity is temporarily exhausted.",
        403,
      );
    }
    await client.query(
      `INSERT INTO site_ai_speech_reservations
         (request_id, account_id, period_start, reserved_microusd,
          status, expires_at)
       VALUES($1, $2, $3, $4, 'active', $5)`,
      [
        requestId,
        accountId,
        start,
        reservedMicrousd,
        new Date(Date.now() + RESERVATION_TTL_MS),
      ],
    );
    await client.query(
      `UPDATE site_ai_funding_periods SET
         reserved_microusd=reserved_microusd+$3, updated_at=NOW()
       WHERE pool_id=$1 AND period_start=$2`,
      [SITE_AI_GLOBAL_POOL_ID, start, reservedMicrousd],
    );
    await client.query("COMMIT");
    return { requestId, reservedMicrousd, created: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function finishSiteFundedSpeechGlobalLocal({
  requestId,
  status,
  costMicrousd = 0,
}: {
  requestId: string;
  status: "committed" | "released";
  costMicrousd?: number;
}): Promise<void> {
  if (!Number.isSafeInteger(costMicrousd) || costMicrousd < 0) {
    throw new Error("costMicrousd must be a nonnegative safe integer");
  }
  await ensureSiteFundedSpeechReservationTable();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reservation = await client.query(
      `SELECT period_start, reserved_microusd, status
       FROM site_ai_speech_reservations WHERE request_id=$1 FOR UPDATE`,
      [requestId],
    );
    const row = reservation.rows[0];
    if (!row) throw new Error("speech global reservation was not found");
    if (row.status !== "active") {
      await client.query("COMMIT");
      return;
    }
    const reservedMicrousd = integer(row.reserved_microusd);
    if (status === "committed" && costMicrousd > reservedMicrousd) {
      throw new Error("speech settlement exceeds its global reservation");
    }
    await client.query(
      `SELECT pool_id FROM site_ai_funding_periods
       WHERE pool_id=$1 AND period_start=$2 FOR UPDATE`,
      [SITE_AI_GLOBAL_POOL_ID, row.period_start],
    );
    await client.query(
      `UPDATE site_ai_speech_reservations SET status=$2,
         committed_microusd=$3, completed_at=NOW()
       WHERE request_id=$1`,
      [requestId, status, status === "committed" ? costMicrousd : 0],
    );
    await client.query(
      `UPDATE site_ai_funding_periods SET
         reserved_microusd=GREATEST(0, reserved_microusd-$3),
         committed_microusd=committed_microusd+$4,
         updated_at=NOW()
       WHERE pool_id=$1 AND period_start=$2`,
      [
        SITE_AI_GLOBAL_POOL_ID,
        row.period_start,
        reservedMicrousd,
        status === "committed" ? costMicrousd : 0,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function reserveSiteFundedSpeechGlobal(
  opts: Parameters<typeof reserveSiteFundedSpeechGlobalLocal>[0],
): Promise<SiteFundedSpeechGlobalReservation> {
  const seedBayId = getConfiguredClusterSeedBayId();
  if (getConfiguredBayId() === seedBayId) {
    return await reserveSiteFundedSpeechGlobalLocal(opts);
  }
  return await getInterBayBridge()
    .bayOps(seedBayId, { timeout_ms: 15_000 })
    .reserveSiteFundedSpeech(opts);
}

export async function finishSiteFundedSpeechGlobal(
  opts: Parameters<typeof finishSiteFundedSpeechGlobalLocal>[0],
): Promise<void> {
  const seedBayId = getConfiguredClusterSeedBayId();
  if (getConfiguredBayId() === seedBayId) {
    return await finishSiteFundedSpeechGlobalLocal(opts);
  }
  await getInterBayBridge()
    .bayOps(seedBayId, { timeout_ms: 15_000 })
    .finishSiteFundedSpeech(opts);
}
