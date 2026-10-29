/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

// Rolling reservations: a turn is admitted with one chunk and extended chunk
// by chunk while the account's allowance, the pools and its ceiling allow.

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
  expireAbandonedSiteFundedCodexReservations,
  extendSiteFundedCodexTurn,
  finishSiteFundedCodexTurn,
  heartbeatSiteFundedCodexTurn,
  reserveSiteFundedCodexTurn,
} from "./site-funded-codex-reservations";

beforeAll(async () => {
  await before({ noConat: true });
  await ensureAiSessionsSchema();
}, 15_000);

afterAll(after);

const CHUNK = 10_000;
const CEILING = 45_000;

const policy: SiteFundedCodexPolicy = {
  ...DEFAULT_SITE_FUNDED_CODEX_POLICY,
  model: "gpt-5.6-luna",
  maxTurnCostMicrousd: CEILING,
  reservationChunkMicrousd: CHUNK,
  idleTimeoutMs: 15 * 60_000,
  contextWindowTokens: 10_000,
  autoCompactTokenLimit: 7_500,
  maxOutputTokensPerRequest: 1_000,
};
const HEADROOM = siteFundedCodexFinalRequestHeadroomMicrousd(policy);

function admission({
  accountId = uuid(),
  rolling = true,
  poolLimitMicrousd = 10_000_000,
  remaining5h,
  remaining7d,
}: {
  accountId?: string;
  rolling?: boolean;
  poolLimitMicrousd?: number;
  remaining5h?: number;
  remaining7d?: number;
} = {}) {
  const fundedTurnId = uuid();
  return {
    fundedTurnId,
    idempotencyKey: fundedTurnId,
    poolId: "site-funded-codex-free" as const,
    poolLimitMicrousd,
    globalPoolLimitMicrousd: poolLimitMicrousd,
    globalConcurrency: 100,
    accountId,
    projectId: uuid(),
    hostId: uuid(),
    membershipTier: "free",
    policy: { ...policy, maxConcurrentTurnsPerAccount: 5 },
    accountRemaining5hMicrousd: remaining5h,
    accountRemaining7dMicrousd: remaining7d,
    rolling,
  };
}

async function admit(opts: ReturnType<typeof admission>) {
  const result = await reserveSiteFundedCodexTurn(opts);
  if (!result.allowed) throw new Error(`not admitted: ${result.code}`);
  return result.reservation;
}

function extension(
  opts: ReturnType<typeof admission>,
  reservationId: string,
  sequence: number,
  extra: { remaining5h?: number; remaining7d?: number } = {},
) {
  return {
    reservationId,
    hostId: opts.hostId,
    accountId: opts.accountId,
    fundedTurnId: opts.fundedTurnId,
    sequence,
    accountRemaining5hMicrousd:
      extra.remaining5h ?? opts.accountRemaining5hMicrousd,
    accountRemaining7dMicrousd:
      extra.remaining7d ?? opts.accountRemaining7dMicrousd,
  };
}

async function periodReserved(): Promise<number[]> {
  const { rows } = await getPool().query(
    `SELECT reserved_microusd FROM site_ai_funding_periods ORDER BY pool_id`,
  );
  return rows.map((row) => Number(row.reserved_microusd));
}

async function accountReserved(accountId: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(reserved_microusd), 0) AS reserved
     FROM site_ai_turn_reservations
     WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
  return Number(rows[0].reserved);
}

describe("rolling site-funded reservations", () => {
  beforeEach(async () => {
    await getPool().query("DELETE FROM site_ai_turn_reservations");
    await getPool().query("DELETE FROM site_ai_funding_periods");
    await getPool().query("DELETE FROM site_ai_account_holds");
    await getPool().query("DELETE FROM ai_sessions");
  });

  it("admits a rolling turn with one chunk and keeps its ceiling", async () => {
    const opts = admission();
    const reservation = await admit(opts);
    expect(reservation).toMatchObject({
      rolling: true,
      reservedMicrousd: CHUNK,
      poolReservedMicrousd: CHUNK + HEADROOM,
    });
    expect(reservation.policy.maxTurnCostMicrousd).toBe(CEILING);
    expect(await periodReserved()).toEqual([
      CHUNK + HEADROOM,
      CHUNK + HEADROOM,
    ]);
  });

  it("reserves the whole turn up front when the host does not extend", async () => {
    const reservation = await admit(admission({ rolling: false }));
    expect(reservation.rolling).toBeUndefined();
    expect(reservation.reservedMicrousd).toBe(CEILING);
    expect(reservation.policy.maxTurnCostMicrousd).toBe(CEILING);
  });

  it("extends by one chunk, adding only the grant, and grants a repeated request once", async () => {
    const opts = admission();
    const { reservationId } = await admit(opts);
    const first = await extendSiteFundedCodexTurn(
      extension(opts, reservationId, 1),
    );
    expect(first).toEqual({
      granted: true,
      grantedMicrousd: CHUNK,
      reservedMicrousd: 2 * CHUNK,
    });
    // The same request again (its reply was lost, say): nothing more.
    await expect(
      extendSiteFundedCodexTurn(extension(opts, reservationId, 1)),
    ).resolves.toEqual(first);
    expect(await periodReserved()).toEqual([
      2 * CHUNK + HEADROOM,
      2 * CHUNK + HEADROOM,
    ]);
    // Out of order: refused.
    await expect(
      extendSiteFundedCodexTurn(extension(opts, reservationId, 3)),
    ).rejects.toThrow("follows 1");
  });

  it("grants concurrent duplicates of one extension once", async () => {
    const opts = admission();
    const { reservationId } = await admit(opts);
    const results = await Promise.all(
      [1, 1, 1].map((sequence) =>
        extendSiteFundedCodexTurn(extension(opts, reservationId, sequence)),
      ),
    );
    expect(results.every((result) => result.granted)).toBe(true);
    expect(await accountReserved(opts.accountId)).toBe(2 * CHUNK);
  });

  it("extends up to the turn's ceiling less one request, so it never spends more than the ceiling", async () => {
    const opts = admission();
    const { reservationId } = await admit(opts);
    const limit = CEILING - HEADROOM;
    const grants: number[] = [];
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      const result = await extendSiteFundedCodexTurn(
        extension(opts, reservationId, sequence),
      );
      if (!result.granted) {
        expect(result).toMatchObject({
          code: "turn_limit",
          reservedMicrousd: limit,
        });
        expect(result.reason).toContain("cost limit");
        break;
      }
      grants.push(result.grantedMicrousd);
    }
    expect(grants).toEqual([CHUNK, CHUNK, limit - 3 * CHUNK]);
    // A request starts only while the turn has spent less than it holds, and
    // costs at most HEADROOM: the turn can't spend more than CEILING.
    expect(limit + HEADROOM).toBe(CEILING);
  });

  it("reserves the ceiling once when it leaves no room for a rolling reservation", async () => {
    const opts = admission();
    opts.policy = { ...opts.policy, maxTurnCostMicrousd: HEADROOM };
    const reservation = await admit(opts);
    expect(reservation.rolling).toBeUndefined();
    expect(reservation.reservedMicrousd).toBe(HEADROOM);
  });

  it("does not report a repeated extension of an ended turn as granted", async () => {
    const opts = admission();
    const { reservationId } = await admit(opts);
    await expect(
      extendSiteFundedCodexTurn(extension(opts, reservationId, 1)),
    ).resolves.toMatchObject({ granted: true });
    await finishSiteFundedCodexTurn({ reservationId, status: "committed" });
    await expect(
      extendSiteFundedCodexTurn(extension(opts, reservationId, 1)),
    ).resolves.toMatchObject({ granted: false, code: "inactive" });
  });

  it("stops at the account's 5-hour and weekly allowance mid-turn", async () => {
    const opts = admission({ remaining5h: 25_000, remaining7d: 100_000 });
    const { reservationId } = await admit(opts);
    const second = await extendSiteFundedCodexTurn(
      extension(opts, reservationId, 1),
    );
    const third = await extendSiteFundedCodexTurn(
      extension(opts, reservationId, 2),
    );
    expect(second).toMatchObject({ granted: true, grantedMicrousd: CHUNK });
    // Only 5 000 of the 5-hour allowance is left.
    expect(third).toMatchObject({ granted: true, grantedMicrousd: 5_000 });
    const fourth = await extendSiteFundedCodexTurn(
      extension(opts, reservationId, 3),
    );
    expect(fourth).toMatchObject({
      granted: false,
      code: "account_limit_5h",
      reservedMicrousd: 25_000,
    });
    expect((fourth as any).reason).toContain("5-hour included AI allowance");
    const weekly = await extendSiteFundedCodexTurn(
      extension(opts, reservationId, 3, {
        remaining5h: 1_000_000,
        remaining7d: 25_000,
      }),
    );
    expect(weekly).toMatchObject({ granted: false, code: "account_limit_7d" });
  });

  it("never lets two concurrent turns of one account reserve more than its allowance", async () => {
    const accountId = uuid();
    const allowance = 35_000;
    const a = admission({ accountId, remaining5h: allowance });
    const b = admission({ accountId, remaining5h: allowance });
    const ra = await admit(a);
    const rb = await admit(b);
    // Both keep extending, concurrently, until refused (the sequence moves
    // on only with a grant).
    const extendUntilRefused = async (
      opts: ReturnType<typeof admission>,
      reservationId: string,
    ) => {
      let sequence = 1;
      for (;;) {
        const result = await extendSiteFundedCodexTurn(
          extension(opts, reservationId, sequence),
        );
        if (!result.granted) return result;
        sequence += 1;
      }
    };
    const refusals = await Promise.all([
      extendUntilRefused(a, ra.reservationId),
      extendUntilRefused(b, rb.reservationId),
    ]);
    expect(refusals.map((refusal) => refusal.code)).toEqual([
      "account_limit_5h",
      "account_limit_5h",
    ]);
    expect(await accountReserved(accountId)).toBe(allowance);
  });

  it("shares the allowance between an extension and a new admission racing it", async () => {
    const accountId = uuid();
    const allowance = 15_000;
    const a = admission({ accountId, remaining5h: allowance });
    const ra = await admit(a);
    const [extended, admitted] = await Promise.all([
      extendSiteFundedCodexTurn(extension(a, ra.reservationId, 1)),
      reserveSiteFundedCodexTurn(
        admission({ accountId, remaining5h: allowance }),
      ),
    ]);
    expect(extended.granted || admitted.allowed).toBe(true);
    expect(await accountReserved(accountId)).toBeLessThanOrEqual(allowance);
  });

  it("stops at the pool", async () => {
    const opts = admission({ poolLimitMicrousd: CHUNK + HEADROOM + 2_000 });
    const { reservationId } = await admit(opts);
    const first = await extendSiteFundedCodexTurn(
      extension(opts, reservationId, 1),
    );
    expect(first).toMatchObject({ granted: true, grantedMicrousd: 2_000 });
    await expect(
      extendSiteFundedCodexTurn(extension(opts, reservationId, 2)),
    ).resolves.toMatchObject({ granted: false, code: "global_pool" });
  });

  it("extends only for the host, account and turn it belongs to", async () => {
    const opts = admission();
    const { reservationId } = await admit(opts);
    for (const wrong of [
      { hostId: uuid() },
      { accountId: uuid() },
      { fundedTurnId: uuid() },
    ]) {
      await expect(
        extendSiteFundedCodexTurn({
          ...extension(opts, reservationId, 1),
          ...wrong,
        }),
      ).rejects.toThrow("does not belong to host");
    }
    expect(await accountReserved(opts.accountId)).toBe(CHUNK);
  });

  it("never extends a finished or non-rolling reservation", async () => {
    const opts = admission();
    const { reservationId } = await admit(opts);
    await finishSiteFundedCodexTurn({ reservationId, status: "committed" });
    await expect(
      extendSiteFundedCodexTurn(extension(opts, reservationId, 1)),
    ).resolves.toMatchObject({ granted: false, code: "inactive" });
    const fixed = admission({ rolling: false });
    const reservation = await admit(fixed);
    await expect(
      extendSiteFundedCodexTurn(extension(fixed, reservation.reservationId, 1)),
    ).resolves.toMatchObject({ granted: false, code: "inactive" });
    expect(await periodReserved()).toEqual([
      CEILING + HEADROOM,
      CEILING + HEADROOM,
    ]);
  });

  it("expires a rolling turn whose host stopped heartbeating, and it stays ended", async () => {
    const opts = admission();
    const { reservationId } = await admit(opts);
    await expect(heartbeatSiteFundedCodexTurn({ reservationId })).resolves.toBe(
      true,
    );
    await getPool().query(
      `UPDATE site_ai_turn_reservations
       SET heartbeat_at = NOW() - INTERVAL '16 minutes'
       WHERE reservation_id = $1`,
      [reservationId],
    );
    // A late heartbeat cannot revive it, nor an extension.
    await expect(heartbeatSiteFundedCodexTurn({ reservationId })).resolves.toBe(
      false,
    );
    await expect(
      extendSiteFundedCodexTurn(extension(opts, reservationId, 1)),
    ).resolves.toMatchObject({ granted: false, code: "inactive" });
    await expect(expireAbandonedSiteFundedCodexReservations()).resolves.toBe(1);
    const { rows } = await getPool().query(
      `SELECT status, outcome FROM site_ai_turn_reservations
       WHERE reservation_id = $1`,
      [reservationId],
    );
    expect(rows[0]).toEqual({
      status: "expired",
      outcome: "turn reservation idle: no heartbeat",
    });
    expect(await periodReserved()).toEqual([0, 0]);
  });

  it("keeps a heartbeating rolling turn alive past an hour", async () => {
    const opts = admission();
    const { reservationId } = await admit(opts);
    await getPool().query(
      `UPDATE site_ai_turn_reservations
       SET started_at = NOW() - INTERVAL '3 hours',
           heartbeat_at = NOW() - INTERVAL '30 seconds'
       WHERE reservation_id = $1`,
      [reservationId],
    );
    await expect(expireAbandonedSiteFundedCodexReservations()).resolves.toBe(0);
    await expect(heartbeatSiteFundedCodexTurn({ reservationId })).resolves.toBe(
      true,
    );
  });

  it("settles consistently when an extension races finish and expiry", async () => {
    for (let round = 0; round < 5; round += 1) {
      await getPool().query("DELETE FROM site_ai_turn_reservations");
      await getPool().query("DELETE FROM site_ai_funding_periods");
      const opts = admission();
      const { reservationId } = await admit(opts);
      await getPool().query(
        `UPDATE site_ai_turn_reservations
         SET expires_at = NOW() + INTERVAL '50 milliseconds'
         WHERE reservation_id = $1`,
        [reservationId],
      );
      const results = await Promise.allSettled([
        extendSiteFundedCodexTurn(extension(opts, reservationId, 1)),
        finishSiteFundedCodexTurn({ reservationId, status: "committed" }),
        new Promise((resolve) => setTimeout(resolve, 60)).then(() =>
          expireAbandonedSiteFundedCodexReservations(),
        ),
      ]);
      expect(results.map(({ status }) => status)).toEqual([
        "fulfilled",
        "fulfilled",
        "fulfilled",
      ]);
      // Whatever ran first, the turn ended and nothing is still held.
      const { rows } = await getPool().query(
        `SELECT status FROM site_ai_turn_reservations
         WHERE reservation_id = $1`,
        [reservationId],
      );
      expect(rows[0].status).not.toBe("active");
      expect(await periodReserved()).toEqual([0, 0]);
    }
  });
});
