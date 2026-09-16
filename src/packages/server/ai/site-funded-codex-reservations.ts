/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import {
  computeSiteFundedCodexRequestCost,
  siteFundedCodexFinalRequestHeadroomMicrousd,
  type SiteFundedCodexAdmission,
  type SiteFundedCodexPoolId,
  type SiteFundedCodexPoolStatus,
  type SiteFundedCodexPolicy,
  type SiteFundedCodexReservation,
  type SiteFundedCodexReservationStatus,
  type SiteFundedCodexUsageEvent,
  type SiteFundedCodexUsageRecordResult,
} from "@cocalc/util/ai/site-funded-codex";
import { uuid } from "@cocalc/util/misc";
import { ensureAiSessionsSchema } from "./acp-sessions";

const logger = getLogger("server:ai:site-funded-codex-reservations");
const HEARTBEAT_INTERVAL_MS = 30_000;
const GLOBAL_POOL_ID = "site-funded-codex-global" as const;
export const SITE_AI_GLOBAL_POOL_ID = GLOBAL_POOL_ID;
const TERMINAL_SESSION_GRACE_MS = 60_000;
const STALE_RESERVATION_HEARTBEAT_MS = 2 * 60_000;
const ORPHANED_RESERVATION_HEARTBEAT_MS = 5 * 60_000;

type DbClient = PoolClient;

export type ReserveSiteFundedCodexTurnOptions = {
  fundedTurnId: string;
  idempotencyKey: string;
  poolId: SiteFundedCodexPoolId;
  poolLimitMicrousd: number;
  globalPoolLimitMicrousd: number;
  globalConcurrency: number;
  accountId: string;
  projectId: string;
  hostId: string;
  homeBayId?: string;
  owningBayId?: string;
  membershipTier: string;
  policy: SiteFundedCodexPolicy;
  accountRemaining5hMicrousd?: number | null;
  accountRemaining7dMicrousd?: number | null;
  surface?: string;
};

export type FinishSiteFundedCodexTurnOptions = {
  reservationId: string;
  status: Extract<
    SiteFundedCodexReservationStatus,
    "committed" | "interrupted" | "failed" | "released"
  >;
  outcome?: string;
};

function int(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid database integer '${value}'`);
  }
  return parsed;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(`${value}`).toISOString();
}

function periodBounds(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - ((day + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

export function siteAiFundingPeriodBounds(now = new Date()): {
  start: Date;
  end: Date;
} {
  return periodBounds(now);
}

function reservationFromRow(row: any): SiteFundedCodexReservation {
  return {
    reservationId: row.reservation_id,
    fundedTurnId: row.funded_turn_id,
    accountId: row.account_id,
    projectId: row.project_id,
    homeBayId: row.home_bay_id ?? undefined,
    poolId: row.pool_id,
    policy: row.policy,
    reservedMicrousd: int(row.reserved_microusd),
    poolReservedMicrousd: int(
      row.pool_reserved_microusd ?? row.reserved_microusd,
    ),
    committedMicrousd: int(row.committed_microusd),
    completedAt: row.completed_at ? iso(row.completed_at) : undefined,
    expiresAt: iso(row.expires_at),
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    status: row.status,
  };
}

export async function ensureSiteFundedCodexReservationTables(): Promise<void> {
  const statements = [
    `
    CREATE TABLE IF NOT EXISTS site_ai_funding_periods (
      pool_id TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      limit_microusd BIGINT NOT NULL CHECK (limit_microusd >= 0),
      reserved_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
      committed_microusd BIGINT NOT NULL DEFAULT 0 CHECK (committed_microusd >= 0),
      policy_version INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (pool_id, period_start)
    )`,
    `
    CREATE TABLE IF NOT EXISTS site_ai_turn_reservations (
      reservation_id UUID PRIMARY KEY,
      funded_turn_id UUID NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      pool_id TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      account_id UUID NOT NULL,
      project_id UUID NOT NULL,
      host_id UUID NOT NULL,
      home_bay_id TEXT,
      owning_bay_id TEXT,
      membership_tier TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      model TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      service_tier TEXT NOT NULL,
      policy JSONB NOT NULL,
      surface TEXT,
      reserved_microusd BIGINT NOT NULL CHECK (reserved_microusd >= 0),
      pool_reserved_microusd BIGINT NOT NULL CHECK (pool_reserved_microusd >= 0),
      committed_microusd BIGINT NOT NULL DEFAULT 0 CHECK (committed_microusd >= 0),
      last_request_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_request_sequence >= 0),
      last_event_id UUID,
      last_event_cost_microusd BIGINT NOT NULL DEFAULT 0 CHECK (last_event_cost_microusd >= 0),
      last_event_price_version TEXT,
      last_event_long_context BOOLEAN,
      status TEXT NOT NULL CHECK (status IN ('active','committed','released','expired','interrupted','failed')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      outcome TEXT,
      FOREIGN KEY (pool_id, period_start)
        REFERENCES site_ai_funding_periods(pool_id, period_start)
    )`,
    `
    CREATE INDEX IF NOT EXISTS site_ai_turn_reservations_account_started_idx
      ON site_ai_turn_reservations(account_id, started_at DESC)`,
    `ALTER TABLE site_ai_turn_reservations
       ADD COLUMN IF NOT EXISTS pool_reserved_microusd BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE site_ai_turn_reservations
       ADD COLUMN IF NOT EXISTS last_request_sequence INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE site_ai_turn_reservations
       ADD COLUMN IF NOT EXISTS last_event_id UUID`,
    `ALTER TABLE site_ai_turn_reservations
       ADD COLUMN IF NOT EXISTS last_event_cost_microusd BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE site_ai_turn_reservations
       ADD COLUMN IF NOT EXISTS last_event_price_version TEXT`,
    `ALTER TABLE site_ai_turn_reservations
       ADD COLUMN IF NOT EXISTS last_event_long_context BOOLEAN`,
    `UPDATE site_ai_turn_reservations
       SET pool_reserved_microusd = reserved_microusd
       WHERE status = 'active' AND pool_reserved_microusd = 0`,
    `
    CREATE INDEX IF NOT EXISTS site_ai_turn_reservations_active_idx
      ON site_ai_turn_reservations(status, expires_at)
      WHERE status = 'active'`,
    `
    CREATE TABLE IF NOT EXISTS site_ai_speech_reservations (
      request_id UUID PRIMARY KEY,
      account_id UUID NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      reserved_microusd BIGINT NOT NULL CHECK (reserved_microusd > 0),
      committed_microusd BIGINT NOT NULL DEFAULT 0
        CHECK (committed_microusd >= 0),
      status TEXT NOT NULL
        CHECK (status IN ('active', 'committed', 'released', 'expired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )`,
    `
    CREATE INDEX IF NOT EXISTS site_ai_speech_reservations_active_idx
      ON site_ai_speech_reservations(status, expires_at)
      WHERE status = 'active'`,
    `
    CREATE TABLE IF NOT EXISTS site_ai_account_holds (
      account_id UUID PRIMARY KEY,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by UUID,
      expires_at TIMESTAMPTZ
    )`,
  ];
  for (const statement of statements) {
    await getPool().query(statement);
  }
}

async function expireCurrentPeriodSpeechReservations({
  client,
  periodStart,
}: {
  client: DbClient;
  periodStart: Date;
}): Promise<void> {
  const { rows } = await client.query(
    `UPDATE site_ai_speech_reservations SET
       status='expired', completed_at=NOW()
     WHERE period_start=$1 AND status='active' AND expires_at<=NOW()
     RETURNING reserved_microusd`,
    [periodStart],
  );
  const released = rows.reduce(
    (sum, row) => sum + int(row.reserved_microusd),
    0,
  );
  if (released > 0) {
    await client.query(
      `UPDATE site_ai_funding_periods SET
         reserved_microusd=GREATEST(0, reserved_microusd-$3),
         updated_at=NOW()
       WHERE pool_id=$1 AND period_start=$2`,
      [GLOBAL_POOL_ID, periodStart, released],
    );
  }
}

async function expireCurrentPeriodReservations({
  client,
  poolId,
  periodStart,
}: {
  client: DbClient;
  poolId: SiteFundedCodexPoolId;
  periodStart: Date;
}): Promise<void> {
  const { rows } = await client.query(
    `
      SELECT reservation_id, reserved_microusd, pool_reserved_microusd,
             committed_microusd
      FROM site_ai_turn_reservations
      WHERE pool_id = $1 AND period_start = $2 AND status = 'active'
        AND expires_at <= NOW()
      FOR UPDATE
    `,
    [poolId, periodStart],
  );
  let released = 0;
  let committed = 0;
  for (const row of rows) {
    const reservationCommitted = int(row.committed_microusd);
    released += int(row.pool_reserved_microusd ?? row.reserved_microusd);
    committed += reservationCommitted;
    await client.query(
      `UPDATE site_ai_turn_reservations
       SET status = 'expired', committed_microusd = $2,
           completed_at = NOW(), outcome = 'turn reservation expired'
       WHERE reservation_id = $1`,
      [row.reservation_id, reservationCommitted],
    );
  }
  if (rows.length > 0) {
    await client.query(
      `
        UPDATE site_ai_funding_periods
        SET reserved_microusd = GREATEST(0, reserved_microusd - $3),
            committed_microusd = committed_microusd + $4,
            updated_at = NOW()
        WHERE pool_id = ANY($1::TEXT[]) AND period_start = $2
      `,
      [[poolId, GLOBAL_POOL_ID], periodStart, released, committed],
    );
  }
}

function terminalReservationStatus(
  state: string,
): FinishSiteFundedCodexTurnOptions["status"] {
  if (state === "completed") return "committed";
  if (state === "interrupted" || state === "canceled") {
    return "interrupted";
  }
  return "failed";
}

async function reconcileTerminalReservationsForPeriod({
  client,
  poolId,
  periodStart,
  terminalGraceMs = TERMINAL_SESSION_GRACE_MS,
  staleHeartbeatMs = STALE_RESERVATION_HEARTBEAT_MS,
  orphanedHeartbeatMs = ORPHANED_RESERVATION_HEARTBEAT_MS,
}: {
  client: DbClient;
  poolId: SiteFundedCodexPoolId;
  periodStart: Date;
  terminalGraceMs?: number;
  staleHeartbeatMs?: number;
  orphanedHeartbeatMs?: number;
}): Promise<number> {
  const now = Date.now();
  const terminalCutoff = new Date(now - Math.max(0, terminalGraceMs));
  const heartbeatCutoff = new Date(now - Math.max(0, staleHeartbeatMs));
  const orphanedHeartbeatCutoff = new Date(
    now - Math.max(0, orphanedHeartbeatMs),
  );
  // Terminal session publication may beat the durable usage outbox, so exact
  // matches wait briefly. Timing matches support old hosts during rollout;
  // reservations with no session require a longer stale-heartbeat threshold.
  const { rows } = await client.query(
    `
      SELECT r.reservation_id, r.reserved_microusd,
             r.pool_reserved_microusd, r.committed_microusd,
             terminal_session.state AS session_state,
             terminal_session.exact_match
      FROM site_ai_turn_reservations r
      LEFT JOIN LATERAL (
        SELECT s.state,
               (s.site_funded_reservation_id = r.reservation_id) AS exact_match,
               COALESCE(s.finished_at, s.updated_at) AS terminal_at
        FROM ai_sessions s
        WHERE s.terminal IS TRUE
          AND (
            s.site_funded_reservation_id = r.reservation_id
            OR (
              s.site_funded_reservation_id IS NULL
              AND s.account_id = r.account_id
              AND s.project_id = r.project_id
              AND (s.host_id = r.host_id OR s.host_id IS NULL)
              AND s.started_at >= r.started_at - INTERVAL '10 seconds'
              AND s.started_at <= r.started_at + INTERVAL '2 minutes'
              AND COALESCE(s.finished_at, s.updated_at) >= r.heartbeat_at
            )
          )
        ORDER BY (s.site_funded_reservation_id = r.reservation_id) DESC,
                 COALESCE(s.finished_at, s.updated_at) DESC
        LIMIT 1
      ) AS terminal_session ON TRUE
      WHERE r.pool_id = $1 AND r.period_start = $2 AND r.status = 'active'
        AND (
          (
            terminal_session.terminal_at <= $3::TIMESTAMPTZ
            AND (
              terminal_session.exact_match
              OR (
                r.heartbeat_at <= $4::TIMESTAMPTZ
                AND NOT EXISTS (
                  SELECT 1 FROM ai_sessions live
                  WHERE live.account_id = r.account_id
                    AND live.terminal IS NOT TRUE
                    AND COALESCE(live.last_heartbeat_at, live.updated_at) >
                        $4::TIMESTAMPTZ
                )
              )
            )
          )
          OR (
            terminal_session.terminal_at IS NULL
            AND r.heartbeat_at <= $5::TIMESTAMPTZ
            AND NOT EXISTS (
              SELECT 1 FROM ai_sessions live
              WHERE live.account_id = r.account_id
                AND live.terminal IS NOT TRUE
                AND COALESCE(live.last_heartbeat_at, live.updated_at) >
                    $4::TIMESTAMPTZ
            )
          )
        )
      FOR UPDATE OF r
    `,
    [
      poolId,
      periodStart,
      terminalCutoff,
      heartbeatCutoff,
      orphanedHeartbeatCutoff,
    ],
  );
  let released = 0;
  let committed = 0;
  let reconciled = 0;
  for (const row of rows) {
    const reservationCommitted = int(row.committed_microusd);
    const status = terminalReservationStatus(`${row.session_state ?? ""}`);
    const result = await client.query(
      `UPDATE site_ai_turn_reservations
       SET status = $2, completed_at = NOW(), heartbeat_at = NOW(), outcome = $3
       WHERE reservation_id = $1 AND status = 'active'`,
      [
        row.reservation_id,
        status,
        row.session_state == null
          ? "stale reservation had no live AI session"
          : row.exact_match
            ? "reconciled from terminal AI session"
            : "reconciled from terminal AI session during reservation rollout",
      ],
    );
    if ((result.rowCount ?? 0) === 0) continue;
    released += int(row.pool_reserved_microusd ?? row.reserved_microusd);
    committed += reservationCommitted;
    reconciled += 1;
  }
  if (reconciled > 0) {
    await client.query(
      `
        UPDATE site_ai_funding_periods
        SET reserved_microusd = GREATEST(0, reserved_microusd - $3),
            committed_microusd = committed_microusd + $4,
            updated_at = NOW()
        WHERE pool_id = ANY($1::TEXT[]) AND period_start = $2
      `,
      [[poolId, GLOBAL_POOL_ID], periodStart, released, committed],
    );
  }
  return reconciled;
}

function denied(
  code: Exclude<SiteFundedCodexAdmission, { allowed: true }>["code"],
  reason: string,
): SiteFundedCodexAdmission {
  return { allowed: false, code, reason };
}

export async function reserveSiteFundedCodexTurn(
  opts: ReserveSiteFundedCodexTurnOptions,
): Promise<SiteFundedCodexAdmission> {
  await Promise.all([
    ensureSiteFundedCodexReservationTables(),
    ensureAiSessionsSchema(),
  ]);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM site_ai_turn_reservations WHERE idempotency_key = $1`,
      [opts.idempotencyKey],
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return {
        allowed: true,
        reservation: reservationFromRow(existing.rows[0]),
      };
    }

    const hold = await client.query(
      `
        SELECT reason FROM site_ai_account_holds
        WHERE account_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
      `,
      [opts.accountId],
    );
    if (hold.rows[0]) {
      await client.query("ROLLBACK");
      return denied(
        "account_hold",
        `Site-funded Codex is unavailable for this account: ${hold.rows[0].reason}`,
      );
    }

    const { start, end } = periodBounds();
    for (const [poolId, limit] of [
      [GLOBAL_POOL_ID, opts.globalPoolLimitMicrousd],
      [opts.poolId, opts.poolLimitMicrousd],
    ] as const) {
      await client.query(
        `
          INSERT INTO site_ai_funding_periods
            (pool_id, period_start, period_end, limit_microusd,
             reserved_microusd, committed_microusd, policy_version)
          SELECT $1, $2, $3, $4,
            CASE WHEN $1 = $6 THEN COALESCE(SUM(reserved_microusd), 0) ELSE 0 END,
            CASE WHEN $1 = $6 THEN COALESCE(SUM(committed_microusd), 0) ELSE 0 END,
            $5
          FROM site_ai_funding_periods
          WHERE period_start = $2 AND pool_id <> $6
          ON CONFLICT (pool_id, period_start) DO UPDATE SET
            limit_microusd = EXCLUDED.limit_microusd,
            policy_version = EXCLUDED.policy_version,
            updated_at = NOW()
        `,
        [poolId, start, end, limit, opts.policy.version, GLOBAL_POOL_ID],
      );
    }
    // Every reservation locks the parent first, so free and paid admissions
    // cannot race past the combined site budget.
    for (const poolId of [GLOBAL_POOL_ID, opts.poolId]) {
      await client.query(
        `
          SELECT pool_id FROM site_ai_funding_periods
          WHERE pool_id = $1 AND period_start = $2
          FOR UPDATE
        `,
        [poolId, start],
      );
    }
    await expireCurrentPeriodSpeechReservations({
      client,
      periodStart: start,
    });
    await expireCurrentPeriodReservations({
      client,
      poolId: opts.poolId,
      periodStart: start,
    });
    await reconcileTerminalReservationsForPeriod({
      client,
      poolId: opts.poolId,
      periodStart: start,
    });

    const periods = await client.query(
      `
        SELECT * FROM site_ai_funding_periods
        WHERE pool_id = ANY($1::TEXT[]) AND period_start = $2
      `,
      [[GLOBAL_POOL_ID, opts.poolId], start],
    );
    const periodRows = new Map(
      periods.rows.map((row) => [`${row.pool_id}`, row] as const),
    );
    const globalPeriodRow = periodRows.get(GLOBAL_POOL_ID);
    const periodRow = periodRows.get(opts.poolId);
    if (!globalPeriodRow || !periodRow) {
      throw new Error("site-funded Codex funding period was not initialized");
    }
    const active = await client.query(
      `
        SELECT
          COUNT(*)::int AS global_active,
          COUNT(*) FILTER (WHERE account_id = $1)::int AS account_active
        FROM site_ai_turn_reservations
        WHERE status = 'active'
      `,
      [opts.accountId],
    );
    if (
      int(active.rows[0]?.account_active) >=
      opts.policy.maxConcurrentTurnsPerAccount
    ) {
      await client.query("ROLLBACK");
      return denied(
        "account_concurrency",
        "Another site-funded Codex turn is already active for this account.",
      );
    }
    if (int(active.rows[0]?.global_active) >= opts.globalConcurrency) {
      await client.query("ROLLBACK");
      return denied(
        "global_concurrency",
        "Site-funded Codex is temporarily at its global concurrency limit.",
      );
    }
    const remaining5h =
      opts.accountRemaining5hMicrousd == null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, opts.accountRemaining5hMicrousd);
    const remaining7d =
      opts.accountRemaining7dMicrousd == null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, opts.accountRemaining7dMicrousd);
    const requested = Math.min(
      opts.policy.maxTurnCostMicrousd,
      remaining5h,
      remaining7d,
    );
    if (requested <= 0) {
      await client.query("ROLLBACK");
      const weeklyExhausted = remaining7d <= 0;
      return denied(
        weeklyExhausted ? "account_limit_7d" : "account_limit_5h",
        weeklyExhausted
          ? "You have used your weekly included Codex allowance. Wait for usage to reset, upgrade your CoCalc membership, or connect a ChatGPT plan or personal OpenAI API key."
          : "You have used your 5-hour included Codex allowance. Wait for usage to reset, upgrade your CoCalc membership, or connect a ChatGPT plan or personal OpenAI API key.",
      );
    }
    const effectivePolicy: SiteFundedCodexPolicy = {
      ...opts.policy,
      maxTurnCostMicrousd: requested,
    };
    const poolRequested =
      requested + siteFundedCodexFinalRequestHeadroomMicrousd(effectivePolicy);
    if (
      int(globalPeriodRow.committed_microusd) +
        int(globalPeriodRow.reserved_microusd) +
        poolRequested >
      int(globalPeriodRow.limit_microusd)
    ) {
      await client.query("ROLLBACK");
      return denied(
        "global_pool",
        "CoCalc's included Codex capacity is temporarily exhausted. Try again after the weekly pool resets, upgrade your CoCalc membership for more included Luna usage, or connect a ChatGPT plan or personal OpenAI API key.",
      );
    }
    if (
      int(periodRow.committed_microusd) +
        int(periodRow.reserved_microusd) +
        poolRequested >
      int(periodRow.limit_microusd)
    ) {
      await client.query("ROLLBACK");
      return denied(
        "global_pool",
        opts.poolId === "site-funded-codex-free"
          ? "Free included Codex capacity is temporarily exhausted. Try again after the weekly pool resets, upgrade your CoCalc membership for more included Luna usage, or connect a ChatGPT plan or personal OpenAI API key."
          : "Included Codex capacity for paid memberships is temporarily exhausted. Try again after the weekly pool resets or connect a ChatGPT plan or personal OpenAI API key.",
      );
    }

    const reservationId = uuid();
    const expiresAt = new Date(Date.now() + effectivePolicy.maxTurnDurationMs);
    const inserted = await client.query(
      `
        INSERT INTO site_ai_turn_reservations (
          reservation_id, funded_turn_id, idempotency_key, pool_id,
          period_start, account_id, project_id, host_id, home_bay_id,
          owning_bay_id, membership_tier, policy_version, model, reasoning,
          service_tier, policy, surface, reserved_microusd,
          pool_reserved_microusd, status, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16::jsonb, $17, $18, $19, 'active', $20
        )
        RETURNING *
      `,
      [
        reservationId,
        opts.fundedTurnId,
        opts.idempotencyKey,
        opts.poolId,
        start,
        opts.accountId,
        opts.projectId,
        opts.hostId,
        opts.homeBayId ?? null,
        opts.owningBayId ?? null,
        opts.membershipTier,
        effectivePolicy.version,
        effectivePolicy.model,
        effectivePolicy.reasoning,
        effectivePolicy.serviceTier,
        JSON.stringify(effectivePolicy),
        opts.surface ?? null,
        requested,
        poolRequested,
        expiresAt,
      ],
    );
    await client.query(
      `
        UPDATE site_ai_funding_periods
        SET reserved_microusd = reserved_microusd + $3, updated_at = NOW()
        WHERE pool_id = ANY($1::TEXT[]) AND period_start = $2
      `,
      [[opts.poolId, GLOBAL_POOL_ID], start, poolRequested],
    );
    await client.query("COMMIT");
    return {
      allowed: true,
      reservation: reservationFromRow(inserted.rows[0]),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function heartbeatSiteFundedCodexTurn({
  reservationId,
}: {
  reservationId: string;
}): Promise<boolean> {
  await ensureSiteFundedCodexReservationTables();
  const { rowCount } = await getPool().query(
    `
      UPDATE site_ai_turn_reservations
      SET heartbeat_at = NOW()
      WHERE reservation_id = $1 AND status = 'active' AND expires_at > NOW()
    `,
    [reservationId],
  );
  return (rowCount ?? 0) > 0;
}

export async function assertSiteFundedCodexReservationHost({
  reservationId,
  hostId,
}: {
  reservationId: string;
  hostId: string;
}): Promise<void> {
  await ensureSiteFundedCodexReservationTables();
  const { rows } = await getPool().query(
    `SELECT host_id FROM site_ai_turn_reservations WHERE reservation_id = $1`,
    [reservationId],
  );
  if (`${rows[0]?.host_id ?? ""}` !== hostId) {
    throw new Error("site-funded Codex reservation does not belong to host");
  }
}

export async function recordSiteFundedCodexUsageEvent(
  event: SiteFundedCodexUsageEvent,
): Promise<SiteFundedCodexUsageRecordResult> {
  await ensureSiteFundedCodexReservationTables();
  if (
    !Number.isSafeInteger(event.requestSequence) ||
    event.requestSequence < 1
  ) {
    throw new Error("site-funded Codex request sequence must be positive");
  }
  const cost = computeSiteFundedCodexRequestCost({
    model: event.model,
    usage: event,
  });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT * FROM site_ai_turn_reservations
       WHERE reservation_id = $1 FOR UPDATE`,
      [event.reservationId],
    );
    const row = found.rows[0];
    if (!row) throw new Error("site-funded Codex reservation not found");
    const lastRequestSequence = int(row.last_request_sequence);
    const result = (inserted: boolean): SiteFundedCodexUsageRecordResult => ({
      costMicrousd:
        !inserted && event.requestSequence === lastRequestSequence
          ? int(row.last_event_cost_microusd)
          : cost.costMicrousd,
      inserted,
      priceVersion:
        !inserted && event.requestSequence === lastRequestSequence
          ? (row.last_event_price_version ?? cost.priceVersion)
          : cost.priceVersion,
      longContext:
        !inserted && event.requestSequence === lastRequestSequence
          ? (row.last_event_long_context ?? cost.longContext)
          : cost.longContext,
      fundedTurnId: row.funded_turn_id,
      accountId: row.account_id,
      projectId: row.project_id,
      homeBayId: row.home_bay_id ?? undefined,
    });
    if (event.requestSequence === lastRequestSequence) {
      // The monotonically increasing request sequence is the canonical
      // idempotency key. Older project hosts generated a fresh event UUID when
      // redelivering the same request, so requiring both keys to match could
      // strand the reservation without protecting against double charging.
      await client.query("COMMIT");
      return result(false);
    }
    if (row.status !== "active") {
      throw new Error(
        `site-funded Codex reservation is not active (${row.status})`,
      );
    }
    if (event.requestSequence < lastRequestSequence) {
      throw new Error("site-funded Codex usage event sequence is stale");
    }
    if (event.requestSequence !== lastRequestSequence + 1) {
      throw new Error(
        `site-funded Codex usage event sequence ${event.requestSequence} follows ${lastRequestSequence}`,
      );
    }
    const committedMicrousd = int(row.committed_microusd) + cost.costMicrousd;
    const hardBoundMicrousd = int(
      row.pool_reserved_microusd ?? row.reserved_microusd,
    );
    if (committedMicrousd > hardBoundMicrousd) {
      // The provider liability already exists. Preserve exact accounting so
      // the pool fails closed for later admissions instead of hiding the
      // overrun and allowing it to be repeated.
      logger.error("site-funded Codex usage exceeded its reservation", {
        reservationId: event.reservationId,
        committedMicrousd,
        hardBoundMicrousd,
      });
    }
    await client.query(
      `UPDATE site_ai_turn_reservations
       SET committed_microusd = $2, last_request_sequence = $3,
           last_event_id = $4, last_event_cost_microusd = $5,
           last_event_price_version = $6, last_event_long_context = $7,
           heartbeat_at = NOW()
       WHERE reservation_id = $1`,
      [
        event.reservationId,
        committedMicrousd,
        event.requestSequence,
        event.eventId,
        cost.costMicrousd,
        cost.priceVersion,
        cost.longContext,
      ],
    );
    await client.query("COMMIT");
    return result(true);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function finishSiteFundedCodexTurn(
  opts: FinishSiteFundedCodexTurnOptions,
): Promise<SiteFundedCodexReservation> {
  await ensureSiteFundedCodexReservationTables();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT * FROM site_ai_turn_reservations WHERE reservation_id = $1 FOR UPDATE`,
      [opts.reservationId],
    );
    const row = found.rows[0];
    if (!row) throw new Error("site-funded Codex reservation not found");
    if (row.status !== "active") {
      await client.query("COMMIT");
      return reservationFromRow(row);
    }
    const committed = int(row.committed_microusd);
    const updated = await client.query(
      `
        UPDATE site_ai_turn_reservations
        SET status = $2, committed_microusd = $3, completed_at = NOW(),
            outcome = $4, heartbeat_at = NOW()
        WHERE reservation_id = $1
        RETURNING *
      `,
      [opts.reservationId, opts.status, committed, opts.outcome ?? null],
    );
    await client.query(
      `
        UPDATE site_ai_funding_periods
        SET reserved_microusd = GREATEST(0, reserved_microusd - $3),
            committed_microusd = committed_microusd + $4,
            updated_at = NOW()
        WHERE pool_id = ANY($1::TEXT[]) AND period_start = $2
      `,
      [
        [row.pool_id, GLOBAL_POOL_ID],
        row.period_start,
        row.pool_reserved_microusd ?? row.reserved_microusd,
        committed,
      ],
    );
    await client.query("COMMIT");
    if (committed > int(row.pool_reserved_microusd ?? row.reserved_microusd)) {
      logger.error("site-funded Codex reservation exceeded its hard bound", {
        reservationId: opts.reservationId,
        reservedMicrousd: int(
          row.pool_reserved_microusd ?? row.reserved_microusd,
        ),
        committedMicrousd: committed,
      });
    }
    return reservationFromRow(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getSiteFundedCodexPoolStatus(): Promise<
  SiteFundedCodexPoolStatus[]
> {
  await ensureSiteFundedCodexReservationTables();
  const { start } = periodBounds();
  const { rows } = await getPool().query(
    `
      SELECT p.*,
        CASE WHEN p.pool_id = $2 THEN (
          SELECT COUNT(*)::int FROM site_ai_turn_reservations r
          WHERE r.period_start = p.period_start AND r.status = 'active'
        ) + (
          SELECT COUNT(*)::int FROM site_ai_speech_reservations s
          WHERE s.period_start = p.period_start AND s.status = 'active'
        ) ELSE (
          SELECT COUNT(*)::int FROM site_ai_turn_reservations r
          WHERE r.pool_id = p.pool_id AND r.period_start = p.period_start
            AND r.status = 'active'
        ) END AS active_reservations
      FROM site_ai_funding_periods p
      WHERE p.period_start = $1
      ORDER BY CASE WHEN p.pool_id = $2 THEN 0 ELSE 1 END, p.pool_id
    `,
    [start, GLOBAL_POOL_ID],
  );
  return rows.map((row) => {
    const limit = int(row.limit_microusd);
    const reserved = int(row.reserved_microusd);
    const committed = int(row.committed_microusd);
    return {
      poolId: row.pool_id,
      periodStart: iso(row.period_start),
      periodEnd: iso(row.period_end),
      limitMicrousd: limit,
      reservedMicrousd: reserved,
      committedMicrousd: committed,
      activeReservations: int(row.active_reservations),
      utilization: limit > 0 ? (reserved + committed) / limit : 1,
    };
  });
}

export async function reconcileTerminalSiteFundedCodexReservations({
  terminalGraceMs = TERMINAL_SESSION_GRACE_MS,
  staleHeartbeatMs = STALE_RESERVATION_HEARTBEAT_MS,
  orphanedHeartbeatMs = ORPHANED_RESERVATION_HEARTBEAT_MS,
}: {
  terminalGraceMs?: number;
  staleHeartbeatMs?: number;
  orphanedHeartbeatMs?: number;
} = {}): Promise<number> {
  await Promise.all([
    ensureSiteFundedCodexReservationTables(),
    ensureAiSessionsSchema(),
  ]);
  const { rows } = await getPool().query(
    `SELECT DISTINCT pool_id, period_start
     FROM site_ai_turn_reservations
     WHERE status = 'active'`,
  );
  let reconciled = 0;
  for (const row of rows) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      for (const poolId of [GLOBAL_POOL_ID, row.pool_id]) {
        await client.query(
          `SELECT pool_id FROM site_ai_funding_periods
           WHERE pool_id = $1 AND period_start = $2 FOR UPDATE`,
          [poolId, row.period_start],
        );
      }
      reconciled += await reconcileTerminalReservationsForPeriod({
        client,
        poolId: row.pool_id,
        periodStart: row.period_start,
        terminalGraceMs,
        staleHeartbeatMs,
        orphanedHeartbeatMs,
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return reconciled;
}

export async function expireAbandonedSiteFundedCodexReservations(): Promise<number> {
  await ensureSiteFundedCodexReservationTables();
  const { rows } = await getPool().query(
    `SELECT DISTINCT pool_id, period_start FROM site_ai_turn_reservations
     WHERE status = 'active' AND expires_at <= NOW()`,
  );
  let expired = 0;
  for (const row of rows) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      for (const poolId of [GLOBAL_POOL_ID, row.pool_id]) {
        await client.query(
          `SELECT pool_id FROM site_ai_funding_periods
           WHERE pool_id = $1 AND period_start = $2 FOR UPDATE`,
          [poolId, row.period_start],
        );
      }
      const before = await client.query(
        `SELECT COUNT(*)::int AS count FROM site_ai_turn_reservations
         WHERE pool_id = $1 AND period_start = $2 AND status = 'active'
           AND expires_at <= NOW()`,
        [row.pool_id, row.period_start],
      );
      await expireCurrentPeriodReservations({
        client,
        poolId: row.pool_id,
        periodStart: row.period_start,
      });
      expired += int(before.rows[0]?.count);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return expired;
}
