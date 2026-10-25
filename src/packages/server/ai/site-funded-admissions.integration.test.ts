/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { DEFAULT_SITE_FUNDED_CODEX_POLICY } from "@cocalc/util/ai/site-funded-codex";
import { uuid } from "@cocalc/util/misc";
import {
  getSiteFundedFunnel,
  pruneSiteFundedAdmissions,
  recordSiteFundedAdmissionLocal,
  SITE_FUNDED_ADMISSION_RETENTION_DAYS,
} from "./site-funded-admissions";
import {
  finishSiteFundedCodexTurn,
  reserveSiteFundedCodexTurn,
} from "./site-funded-codex-reservations";

beforeAll(async () => {
  await before({ noConat: true });
}, 15_000);

afterAll(after);

beforeEach(async () => {
  await getPool().query("DELETE FROM site_ai_admission_attempts");
  await getPool().query("DELETE FROM site_ai_turn_reservations");
  await getPool().query("DELETE FROM site_ai_funding_periods");
});

const attempt = (
  accountId: string,
  outcome: Parameters<typeof recordSiteFundedAdmissionLocal>[0]["outcome"],
  fundedTurnId = uuid(),
) =>
  recordSiteFundedAdmissionLocal({
    fundedTurnId,
    accountId,
    provider: "openai",
    outcome,
    membershipTier: "free",
    surface: "chat",
  });

describe("site-funded admission funnel", () => {
  it("counts attempts and accounts by outcome", async () => {
    const [a, b, c] = [uuid(), uuid(), uuid()];
    await attempt(a, "allowed");
    await attempt(a, "allowed");
    await attempt(b, "unverified_email");
    await attempt(b, "unverified_email");
    await attempt(c, "no_allowance");
    await attempt(c, "allowed");
    const funnel = await getSiteFundedFunnel();
    expect(funnel).toMatchObject({
      attempts: 6,
      accounts: 3,
      admittedAccounts: 2,
    });
    expect(funnel.outcomes).toEqual([
      { outcome: "allowed", attempts: 3, accounts: 2 },
      { outcome: "unverified_email", attempts: 2, accounts: 1 },
      { outcome: "no_allowance", attempts: 1, accounts: 1 },
    ]);
  });

  it("keeps one row per funded turn: a retry updates its outcome", async () => {
    const account = uuid();
    const turn = uuid();
    await attempt(account, "unavailable", turn);
    await attempt(account, "allowed", turn);
    const funnel = await getSiteFundedFunnel();
    expect(funnel.attempts).toBe(1);
    expect(funnel.outcomes).toEqual([
      { outcome: "allowed", attempts: 1, accounts: 1 },
    ]);
  });

  it("records a Claude turn refused because every site key is at its limit", async () => {
    const accountId = uuid();
    await recordSiteFundedAdmissionLocal({
      fundedTurnId: uuid(),
      accountId,
      provider: "anthropic",
      outcome: "provider_keys_exhausted",
      membershipTier: "free",
      surface: "chat",
    });
    const funnel = await getSiteFundedFunnel();
    expect(funnel.outcomes).toEqual([
      { outcome: "provider_keys_exhausted", attempts: 1, accounts: 1 },
    ]);
  });

  it("refuses malformed records", async () => {
    await expect(attempt("not-a-uuid", "allowed")).rejects.toThrow(
      "invalid site-funded admission record",
    );
    await expect(attempt(uuid(), "made_up" as any)).rejects.toThrow(
      "invalid site-funded admission record",
    );
  });

  it("reports how admitted turns ended", async () => {
    const reserve = (accountId: string) => {
      const fundedTurnId = uuid();
      return reserveSiteFundedCodexTurn({
        fundedTurnId,
        idempotencyKey: fundedTurnId,
        poolId: "site-funded-codex-free",
        poolLimitMicrousd: 100_000_000,
        globalPoolLimitMicrousd: 100_000_000,
        globalConcurrency: 100,
        accountId,
        projectId: uuid(),
        hostId: uuid(),
        membershipTier: "free",
        policy: {
          ...DEFAULT_SITE_FUNDED_CODEX_POLICY,
          contextWindowTokens: 10_000,
          maxOutputTokensPerRequest: 1_000,
        },
      });
    };
    const done = await reserve(uuid());
    const running = await reserve(uuid());
    if (!done.allowed || !running.allowed) {
      throw new Error("expected reservations");
    }
    await finishSiteFundedCodexTurn({
      reservationId: done.reservation.reservationId,
      status: "committed",
    });
    const { turns } = await getSiteFundedFunnel();
    expect(turns).toEqual(
      expect.arrayContaining([
        { status: "committed", turns: 1, accounts: 1, committedMicrousd: 0 },
        { status: "active", turns: 1, accounts: 1, committedMicrousd: 0 },
      ]),
    );
  });

  it("only counts the last 7 days, and prunes beyond retention", async () => {
    const account = uuid();
    await attempt(account, "allowed");
    const old = uuid();
    await attempt(account, "global_pool", old);
    await getPool().query(
      "UPDATE site_ai_admission_attempts SET attempted_at = NOW() - interval '8 days' WHERE funded_turn_id = $1",
      [old],
    );
    expect((await getSiteFundedFunnel()).attempts).toBe(1);
    await getPool().query(
      "UPDATE site_ai_admission_attempts SET attempted_at = NOW() - make_interval(days => $2) WHERE funded_turn_id = $1",
      [old, SITE_FUNDED_ADMISSION_RETENTION_DAYS + 1],
    );
    expect(await pruneSiteFundedAdmissions()).toBe(1);
    const { rows } = await getPool().query(
      "SELECT count(*) AS n FROM site_ai_admission_attempts",
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
