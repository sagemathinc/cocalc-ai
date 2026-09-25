/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import {
  DEFAULT_SITE_FUNDED_CODEX_POLICY,
  siteFundedCodexFinalRequestHeadroomMicrousd,
  type SiteFundedCodexPolicy,
} from "@cocalc/util/ai/site-funded-codex";
import { uuid } from "@cocalc/util/misc";
import { ensureAiSessionsSchema } from "./acp-sessions";
import {
  ensureSiteFundedCodexReservationTables,
  expireAbandonedSiteFundedCodexReservations,
  finishSiteFundedCodexTurn,
  getSiteFundedCodexAccountReservationStatus,
  getSiteFundedCodexPoolStatus,
  recordSiteFundedCodexUsageEvent,
  reconcileTerminalSiteFundedCodexReservations,
  reserveSiteFundedCodexTurn,
} from "./site-funded-codex-reservations";

beforeAll(async () => {
  await before({ noConat: true });
  await ensureSiteFundedCodexReservationTables();
  await ensureAiSessionsSchema();
}, 15_000);

afterAll(after);

function options({
  accountId = uuid(),
  poolId = "site-funded-codex-free",
  poolLimitMicrousd = 100_000,
  globalPoolLimitMicrousd = poolLimitMicrousd,
  maxTurnCostMicrousd = 60_000,
}: {
  accountId?: string;
  poolId?: "site-funded-codex-free" | "site-funded-codex-paid";
  poolLimitMicrousd?: number;
  globalPoolLimitMicrousd?: number;
  maxTurnCostMicrousd?: number;
} = {}) {
  const fundedTurnId = uuid();
  const policy: SiteFundedCodexPolicy = {
    ...DEFAULT_SITE_FUNDED_CODEX_POLICY,
    maxTurnCostMicrousd,
    contextWindowTokens: 10_000,
    autoCompactTokenLimit: 7_500,
    maxOutputTokensPerRequest: 1_000,
  };
  return {
    fundedTurnId,
    idempotencyKey: fundedTurnId,
    poolId,
    poolLimitMicrousd,
    globalPoolLimitMicrousd,
    globalConcurrency: 100,
    accountId,
    projectId: uuid(),
    hostId: uuid(),
    membershipTier: "free",
    policy,
  };
}

function poolReservation(opts: ReturnType<typeof options>): number {
  return (
    opts.policy.maxTurnCostMicrousd +
    siteFundedCodexFinalRequestHeadroomMicrousd(opts.policy)
  );
}

describe("site-funded Codex reservations", () => {
  beforeEach(async () => {
    await getPool().query("DELETE FROM site_ai_turn_reservations");
    await getPool().query("DELETE FROM site_ai_funding_periods");
    await getPool().query("DELETE FROM site_ai_account_holds");
    await getPool().query("DELETE FROM ai_sessions");
  });

  it("atomically refuses reservations beyond the global pool", async () => {
    const expectedReservation = poolReservation(options());
    const attempts = await Promise.all(
      [uuid(), uuid(), uuid()].map((accountId) =>
        reserveSiteFundedCodexTurn(options({ accountId })),
      ),
    );
    expect(attempts.filter(({ allowed }) => allowed)).toHaveLength(1);
    expect(
      attempts
        .filter(({ allowed }) => !allowed)
        .map((entry: any) => entry.code),
    ).toEqual(["global_pool", "global_pool"]);
    const status = await getSiteFundedCodexPoolStatus();
    expect(status[0]).toMatchObject({
      poolId: "site-funded-codex-global",
      limitMicrousd: 100_000,
      reservedMicrousd: expectedReservation,
      committedMicrousd: 0,
      activeReservations: 1,
    });
  });

  it("shares one hard parent budget across free and paid sub-pools", async () => {
    const expectedReservation = poolReservation(options());
    const [free, paid] = await Promise.all([
      reserveSiteFundedCodexTurn(
        options({
          poolId: "site-funded-codex-free",
          poolLimitMicrousd: 200_000,
          globalPoolLimitMicrousd: 100_000,
        }),
      ),
      reserveSiteFundedCodexTurn(
        options({
          poolId: "site-funded-codex-paid",
          poolLimitMicrousd: 200_000,
          globalPoolLimitMicrousd: 100_000,
        }),
      ),
    ]);
    expect([free, paid].filter(({ allowed }) => allowed)).toHaveLength(1);
    expect([free, paid].filter(({ allowed }) => !allowed)[0]).toMatchObject({
      code: "global_pool",
    });
    expect((await getSiteFundedCodexPoolStatus())[0]).toMatchObject({
      poolId: "site-funded-codex-global",
      reservedMicrousd: expectedReservation,
    });
  });

  it("makes reservation and usage retries idempotent", async () => {
    const opts = options({ maxTurnCostMicrousd: 50_000 });
    const first = await reserveSiteFundedCodexTurn(opts);
    const second = await reserveSiteFundedCodexTurn(opts);
    expect(first.allowed).toBe(true);
    expect(second).toEqual(first);
    if (!first.allowed) throw new Error("expected reservation");

    const event = {
      eventId: uuid(),
      reservationId: first.reservation.reservationId,
      requestSequence: 1,
      model: "gpt-5.6-luna",
      inputTokens: 10_000,
      cachedInputTokens: 6_000,
      outputTokens: 500,
    };
    await expect(recordSiteFundedCodexUsageEvent(event)).resolves.toMatchObject(
      {
        costMicrousd: 1_520,
        inserted: true,
        fundedTurnId: opts.fundedTurnId,
        accountId: opts.accountId,
        projectId: opts.projectId,
      },
    );
    await expect(recordSiteFundedCodexUsageEvent(event)).resolves.toMatchObject(
      { costMicrousd: 1_520, inserted: false },
    );
    await expect(
      recordSiteFundedCodexUsageEvent({ ...event, eventId: uuid() }),
    ).resolves.toMatchObject({ costMicrousd: 1_520, inserted: false });

    const finished = await finishSiteFundedCodexTurn({
      reservationId: first.reservation.reservationId,
      status: "committed",
      outcome: "completed",
    });
    expect(finished).toMatchObject({
      status: "committed",
      reservedMicrousd: 50_000,
      poolReservedMicrousd: poolReservation(opts),
      committedMicrousd: 1_520,
    });
    await expect(
      finishSiteFundedCodexTurn({
        reservationId: first.reservation.reservationId,
        status: "committed",
      }),
    ).resolves.toEqual(finished);
    await expect(
      recordSiteFundedCodexUsageEvent({
        ...event,
        eventId: uuid(),
        requestSequence: 3,
      }),
    ).rejects.toThrow("reservation is not active (committed)");
    expect((await getSiteFundedCodexPoolStatus())[0]).toMatchObject({
      reservedMicrousd: 0,
      committedMicrousd: 1_520,
      activeReservations: 0,
    });
  });

  it("records real provider liability when usage exceeds its reservation", async () => {
    const opts = options({
      maxTurnCostMicrousd: 1_000,
      poolLimitMicrousd: 10_000_000,
      globalPoolLimitMicrousd: 10_000_000,
    });
    const admission = await reserveSiteFundedCodexTurn(opts);
    if (!admission.allowed) throw new Error("expected reservation");
    const usage = await recordSiteFundedCodexUsageEvent({
      eventId: uuid(),
      reservationId: admission.reservation.reservationId,
      requestSequence: 1,
      model: "gpt-5.6-luna",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(usage.costMicrousd).toBeGreaterThan(
      admission.reservation.poolReservedMicrousd,
    );
    await finishSiteFundedCodexTurn({
      reservationId: admission.reservation.reservationId,
      status: "committed",
    });
    expect((await getSiteFundedCodexPoolStatus())[0]).toMatchObject({
      reservedMicrousd: 0,
      committedMicrousd: usage.costMicrousd,
    });
  });

  it("admits at most two simultaneous turns per account across projects and hosts", async () => {
    const accountId = uuid();
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        reserveSiteFundedCodexTurn(
          options({ accountId, poolLimitMicrousd: 1_000_000 }),
        ),
      ),
    );
    const admitted = attempts.filter((entry) => entry.allowed);
    expect(admitted).toHaveLength(2);
    expect(attempts.filter((entry) => !entry.allowed)).toEqual([
      expect.objectContaining({ allowed: false, code: "account_concurrency" }),
      expect.objectContaining({ allowed: false, code: "account_concurrency" }),
    ]);
    const first = admitted[0];
    if (!first.allowed) throw new Error("expected reservation");
    await finishSiteFundedCodexTurn({
      reservationId: first.reservation.reservationId,
      status: "released",
    });
    const replacement = await reserveSiteFundedCodexTurn(
      options({ accountId, poolLimitMicrousd: 1_000_000 }),
    );
    expect(replacement.allowed).toBe(true);
  });

  it("still enforces the operator's global concurrency limit", async () => {
    const first = await reserveSiteFundedCodexTurn({
      ...options({ poolLimitMicrousd: 1_000_000 }),
      globalConcurrency: 1,
    });
    expect(first.allowed).toBe(true);
    const second = await reserveSiteFundedCodexTurn({
      ...options({ poolLimitMicrousd: 1_000_000 }),
      globalConcurrency: 1,
    });
    expect(second).toMatchObject({
      allowed: false,
      code: "global_concurrency",
    });
  });

  it("enforces canonical remaining allowance", async () => {
    const accountId = uuid();
    const first = await reserveSiteFundedCodexTurn(
      options({ accountId, maxTurnCostMicrousd: 10_000 }),
    );
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("expected reservation");
    await recordSiteFundedCodexUsageEvent({
      eventId: uuid(),
      reservationId: first.reservation.reservationId,
      requestSequence: 1,
      model: "gpt-5.6-luna",
      inputTokens: 10_000,
      outputTokens: 0,
    });
    await finishSiteFundedCodexTurn({
      reservationId: first.reservation.reservationId,
      status: "committed",
    });
    const limited = await reserveSiteFundedCodexTurn({
      ...options({ accountId, maxTurnCostMicrousd: 10_000 }),
      accountRemaining5hMicrousd: 3_000,
    });
    expect(limited).toMatchObject({
      allowed: true,
      reservation: {
        reservedMicrousd: 3_000,
        policy: { maxTurnCostMicrousd: 3_000 },
      },
    });
    if (!limited.allowed) throw new Error("expected a partial reservation");
    await finishSiteFundedCodexTurn({
      reservationId: limited.reservation.reservationId,
      status: "released",
    });
    const exhausted = await reserveSiteFundedCodexTurn({
      ...options({ accountId, maxTurnCostMicrousd: 10_000 }),
      accountRemaining5hMicrousd: 0,
    });
    expect(exhausted).toMatchObject({
      allowed: false,
      code: "account_limit_5h",
    });
  });

  it("atomically shares remaining allowance across parallel reservations", async () => {
    const accountId = uuid();
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        reserveSiteFundedCodexTurn({
          ...options({
            accountId,
            maxTurnCostMicrousd: 3_000,
            poolLimitMicrousd: 1_000_000,
            globalPoolLimitMicrousd: 1_000_000,
          }),
          policy: {
            ...options().policy,
            maxConcurrentTurnsPerAccount: 20,
            maxTurnCostMicrousd: 3_000,
          },
          accountRemaining5hMicrousd: 5_000,
          accountRemaining7dMicrousd: 8_000,
        }),
      ),
    );
    const admitted = attempts.filter((entry) => entry.allowed);
    expect(admitted).toHaveLength(2);
    expect(
      admitted.reduce(
        (total, entry) =>
          total + (entry.allowed ? entry.reservation.reservedMicrousd : 0),
        0,
      ),
    ).toBe(5_000);
    await expect(
      getSiteFundedCodexAccountReservationStatus({ accountId }),
    ).resolves.toEqual({
      accountId,
      activeCount: 2,
      reservedMicrousd: 5_000,
    });
    expect(
      attempts
        .filter((entry) => !entry.allowed)
        .every((entry) => !entry.allowed && entry.code === "account_limit_5h"),
    ).toBe(true);
  });

  it("subtracts only active reservation liability absent from the canonical snapshot", async () => {
    const accountId = uuid();
    const firstOptions = {
      ...options({
        accountId,
        maxTurnCostMicrousd: 3_000,
        poolLimitMicrousd: 1_000_000,
        globalPoolLimitMicrousd: 1_000_000,
      }),
      policy: {
        ...options().policy,
        maxConcurrentTurnsPerAccount: 20,
        maxTurnCostMicrousd: 3_000,
      },
      accountRemaining5hMicrousd: 5_000,
      accountRemaining7dMicrousd: 8_000,
    };
    const first = await reserveSiteFundedCodexTurn(firstOptions);
    if (!first.allowed) throw new Error("expected first reservation");

    const second = await reserveSiteFundedCodexTurn({
      ...firstOptions,
      fundedTurnId: uuid(),
      idempotencyKey: uuid(),
      accountRemaining5hMicrousd: 2_500,
      accountCredited5hMicrousdByFundedTurn: {
        [firstOptions.fundedTurnId]: 2_500,
      },
    });
    if (!second.allowed) throw new Error("expected partial reservation");
    expect(second.reservation.reservedMicrousd).toBe(2_000);
  });

  it("reserves uncredited committed spend during home-bay propagation lag", async () => {
    const accountId = uuid();
    const firstOptions = {
      ...options({
        accountId,
        maxTurnCostMicrousd: 3_000,
        poolLimitMicrousd: 1_000_000,
        globalPoolLimitMicrousd: 1_000_000,
      }),
      policy: {
        ...options().policy,
        maxConcurrentTurnsPerAccount: 20,
        maxTurnCostMicrousd: 3_000,
      },
      accountRemaining5hMicrousd: 5_000,
      accountRemaining7dMicrousd: 8_000,
    };
    const first = await reserveSiteFundedCodexTurn(firstOptions);
    if (!first.allowed) throw new Error("expected first reservation");
    await getPool().query(
      `UPDATE site_ai_turn_reservations SET committed_microusd = 2500
       WHERE reservation_id = $1`,
      [first.reservation.reservationId],
    );

    const second = await reserveSiteFundedCodexTurn({
      ...firstOptions,
      fundedTurnId: uuid(),
      idempotencyKey: uuid(),
      accountCredited5hMicrousdByFundedTurn: {},
    });
    if (!second.allowed) throw new Error("expected partial reservation");
    expect(second.reservation.reservedMicrousd).toBe(2_000);
  });

  it("commits recorded usage when an active reservation expires", async () => {
    const admission = await reserveSiteFundedCodexTurn(
      options({ maxTurnCostMicrousd: 50_000 }),
    );
    if (!admission.allowed) throw new Error("expected reservation");
    await recordSiteFundedCodexUsageEvent({
      eventId: uuid(),
      reservationId: admission.reservation.reservationId,
      requestSequence: 1,
      model: "gpt-5.6-luna",
      inputTokens: 10_000,
      cachedInputTokens: 6_000,
      outputTokens: 500,
    });
    await getPool().query(
      `UPDATE site_ai_turn_reservations SET expires_at = NOW() - INTERVAL '1 second'
       WHERE reservation_id = $1`,
      [admission.reservation.reservationId],
    );

    await expect(expireAbandonedSiteFundedCodexReservations()).resolves.toBe(1);
    expect((await getSiteFundedCodexPoolStatus())[0]).toMatchObject({
      reservedMicrousd: 0,
      committedMicrousd: 1_520,
      activeReservations: 0,
    });
    const { rows } = await getPool().query(
      `SELECT status, committed_microusd FROM site_ai_turn_reservations
       WHERE reservation_id = $1`,
      [admission.reservation.reservationId],
    );
    expect(rows[0]?.status).toBe("expired");
    expect(Number(rows[0]?.committed_microusd)).toBe(1_520);
  });

  it("reconciles a linked terminal AI session after the delivery grace period", async () => {
    const opts = options({ maxTurnCostMicrousd: 50_000 });
    const admission = await reserveSiteFundedCodexTurn(opts);
    if (!admission.allowed) throw new Error("expected reservation");
    await recordSiteFundedCodexUsageEvent({
      eventId: uuid(),
      reservationId: admission.reservation.reservationId,
      requestSequence: 1,
      model: "gpt-5.6-luna",
      inputTokens: 10_000,
      cachedInputTokens: 6_000,
      outputTokens: 500,
    });
    await getPool().query(
      `INSERT INTO ai_sessions
         (session_key, project_id, account_id, host_id, state, terminal,
          payment_source_kind, site_funded_reservation_id, started_at,
          updated_at, finished_at, source_bay_id)
       VALUES ($1, $2, $3, $4, 'completed', TRUE, 'site_api_key', $5,
               NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '2 minutes',
               NOW() - INTERVAL '2 minutes', 'bay-0')`,
      [
        `linked-${uuid()}`,
        opts.projectId,
        opts.accountId,
        opts.hostId,
        admission.reservation.reservationId,
      ],
    );

    await expect(reconcileTerminalSiteFundedCodexReservations()).resolves.toBe(
      1,
    );
    expect((await getSiteFundedCodexPoolStatus())[0]).toMatchObject({
      reservedMicrousd: 0,
      committedMicrousd: 1_520,
      activeReservations: 0,
    });
    const { rows } = await getPool().query(
      `SELECT status, outcome FROM site_ai_turn_reservations
       WHERE reservation_id = $1`,
      [admission.reservation.reservationId],
    );
    expect(rows[0]).toMatchObject({
      status: "committed",
      outcome: "reconciled from terminal AI session",
    });
  });

  it("does not reconcile a newly terminal session before usage delivery grace", async () => {
    const opts = options();
    const admission = await reserveSiteFundedCodexTurn(opts);
    if (!admission.allowed) throw new Error("expected reservation");
    await getPool().query(
      `INSERT INTO ai_sessions
         (session_key, project_id, account_id, host_id, state, terminal,
          payment_source_kind, site_funded_reservation_id, started_at,
          updated_at, finished_at, source_bay_id)
       VALUES ($1, $2, $3, $4, 'completed', TRUE, 'site_api_key', $5,
               NOW(), NOW(), NOW(), 'bay-0')`,
      [
        `fresh-${uuid()}`,
        opts.projectId,
        opts.accountId,
        opts.hostId,
        admission.reservation.reservationId,
      ],
    );

    await expect(reconcileTerminalSiteFundedCodexReservations()).resolves.toBe(
      0,
    );
  });

  it("admits the next turn after reconciling its linked terminal session", async () => {
    const accountId = uuid();
    const firstOpts = options({ accountId });
    const first = await reserveSiteFundedCodexTurn(firstOpts);
    if (!first.allowed) throw new Error("expected reservation");
    await getPool().query(
      `INSERT INTO ai_sessions
         (session_key, project_id, account_id, host_id, state, terminal,
          payment_source_kind, site_funded_reservation_id, started_at,
          updated_at, finished_at, source_bay_id)
       VALUES ($1, $2, $3, $4, 'completed', TRUE, 'site_api_key', $5,
               NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '2 minutes',
               NOW() - INTERVAL '2 minutes', 'bay-0')`,
      [
        `next-${uuid()}`,
        firstOpts.projectId,
        accountId,
        firstOpts.hostId,
        first.reservation.reservationId,
      ],
    );

    await expect(
      reserveSiteFundedCodexTurn(options({ accountId })),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("recovers a stale legacy reservation using a terminal session match", async () => {
    const opts = options();
    const admission = await reserveSiteFundedCodexTurn(opts);
    if (!admission.allowed) throw new Error("expected reservation");
    await getPool().query(
      `UPDATE site_ai_turn_reservations
       SET started_at = NOW() - INTERVAL '3 minutes',
           heartbeat_at = NOW() - INTERVAL '150 seconds'
       WHERE reservation_id = $1`,
      [admission.reservation.reservationId],
    );
    await getPool().query(
      `INSERT INTO ai_sessions
         (session_key, project_id, account_id, host_id, state, terminal,
          payment_source_kind, started_at, updated_at, finished_at,
          source_bay_id)
       VALUES ($1, $2, $3, $4, 'completed', TRUE, 'site_api_key',
               NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '2 minutes',
               NOW() - INTERVAL '2 minutes', 'bay-0')`,
      [`legacy-${uuid()}`, opts.projectId, opts.accountId, opts.hostId],
    );

    await expect(reconcileTerminalSiteFundedCodexReservations()).resolves.toBe(
      1,
    );
    const { rows } = await getPool().query(
      `SELECT status, outcome FROM site_ai_turn_reservations
       WHERE reservation_id = $1`,
      [admission.reservation.reservationId],
    );
    expect(rows[0]).toMatchObject({
      status: "committed",
      outcome: "reconciled from terminal AI session during reservation rollout",
    });
  });

  it("releases an orphaned reservation with no live AI session", async () => {
    const opts = options();
    const admission = await reserveSiteFundedCodexTurn(opts);
    if (!admission.allowed) throw new Error("expected reservation");
    await getPool().query(
      `UPDATE site_ai_turn_reservations
       SET heartbeat_at = NOW() - INTERVAL '6 minutes'
       WHERE reservation_id = $1`,
      [admission.reservation.reservationId],
    );

    await expect(reconcileTerminalSiteFundedCodexReservations()).resolves.toBe(
      1,
    );
    const { rows } = await getPool().query(
      `SELECT status, outcome FROM site_ai_turn_reservations
       WHERE reservation_id = $1`,
      [admission.reservation.reservationId],
    );
    expect(rows[0]).toMatchObject({
      status: "failed",
      outcome: "stale reservation had no live AI session",
    });
  });

  it("keeps a legacy reservation while the account has a healthy live session", async () => {
    const opts = options();
    const admission = await reserveSiteFundedCodexTurn(opts);
    if (!admission.allowed) throw new Error("expected reservation");
    await getPool().query(
      `UPDATE site_ai_turn_reservations
       SET started_at = NOW() - INTERVAL '3 minutes',
           heartbeat_at = NOW() - INTERVAL '150 seconds'
       WHERE reservation_id = $1`,
      [admission.reservation.reservationId],
    );
    await getPool().query(
      `INSERT INTO ai_sessions
         (session_key, project_id, account_id, host_id, state, terminal,
          payment_source_kind, started_at, updated_at, last_heartbeat_at,
          finished_at, source_bay_id)
       VALUES
         ($1, $3, $4, $5, 'completed', TRUE, 'site_api_key',
          NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '2 minutes', NULL,
          NOW() - INTERVAL '2 minutes', 'bay-0'),
         ($2, $3, $4, $5, 'running', FALSE, 'site_api_key',
          NOW() - INTERVAL '30 seconds', NOW(), NOW(), NULL, 'bay-0')`,
      [
        `legacy-terminal-${uuid()}`,
        `legacy-live-${uuid()}`,
        opts.projectId,
        opts.accountId,
        opts.hostId,
      ],
    );

    await expect(reconcileTerminalSiteFundedCodexReservations()).resolves.toBe(
      0,
    );
    const { rows } = await getPool().query(
      `SELECT status FROM site_ai_turn_reservations WHERE reservation_id = $1`,
      [admission.reservation.reservationId],
    );
    expect(rows[0]?.status).toBe("active");
  });
});
