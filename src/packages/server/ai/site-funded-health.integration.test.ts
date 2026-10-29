/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { DEFAULT_SITE_FUNDED_CODEX_POLICY } from "@cocalc/util/ai/site-funded-codex";
import { uuid } from "@cocalc/util/misc";

const adminAlert = jest.fn();
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: any[]) => adminAlert(...args),
}));

import { recordSiteFundedAdmissionLocal } from "./site-funded-admissions";
import {
  finishSiteFundedCodexTurn,
  reserveSiteFundedCodexTurn,
} from "./site-funded-codex-reservations";
import {
  getSiteFundedAiHealth,
  runSiteFundedAiAlertCheck,
  siteFundedAiHealthDetails,
  siteFundedAiHealthLevel,
  siteFundedAiHealthSummary,
} from "./site-funded-health";

beforeAll(async () => {
  await before({ noConat: true });
}, 60_000);

afterAll(after);

beforeEach(async () => {
  adminAlert.mockReset();
  await getPool().query("DELETE FROM site_ai_admission_attempts");
  await getPool().query("DELETE FROM site_ai_turn_reservations");
  await getPool().query("DELETE FROM site_ai_funding_periods");
  await getPool().query(
    "DELETE FROM admin_alert_state WHERE subject = 'Site-funded AI turns are failing'",
  );
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

// A turn of the given provider that ended `minutes` ago.
async function turn({
  provider = "openai",
  status,
  outcome,
  minutes = 5,
}: {
  provider?: "openai" | "anthropic";
  status: "committed" | "failed" | "expired";
  outcome?: string;
  minutes?: number;
}) {
  const fundedTurnId = uuid();
  const admission = await reserveSiteFundedCodexTurn({
    provider,
    fundedTurnId,
    idempotencyKey: fundedTurnId,
    poolId: "site-funded-codex-free",
    poolLimitMicrousd: 100_000_000,
    globalPoolLimitMicrousd: 100_000_000,
    globalConcurrency: 1000,
    accountId: uuid(),
    projectId: uuid(),
    hostId: uuid(),
    membershipTier: "free",
    policy: {
      ...DEFAULT_SITE_FUNDED_CODEX_POLICY,
      contextWindowTokens: 10_000,
      maxOutputTokensPerRequest: 1_000,
    },
  });
  if (!admission.allowed) throw new Error("expected a reservation");
  const { reservationId } = admission.reservation;
  await finishSiteFundedCodexTurn({
    reservationId,
    status: status === "expired" ? "failed" : status,
    outcome,
  });
  await getPool().query(
    `UPDATE site_ai_turn_reservations SET status = $2, completed_at = $3
      WHERE reservation_id = $1`,
    [reservationId, status, minutesAgo(minutes)],
  );
}

async function admitted(provider: "openai" | "anthropic", minutes: number) {
  const fundedTurnId = uuid();
  await recordSiteFundedAdmissionLocal({
    fundedTurnId,
    accountId: uuid(),
    provider,
    outcome: "allowed",
    membershipTier: "free",
    surface: "chat",
  });
  await getPool().query(
    "UPDATE site_ai_admission_attempts SET attempted_at = $2 WHERE funded_turn_id = $1",
    [fundedTurnId, minutesAgo(minutes)],
  );
}

describe("site-funded AI health", () => {
  it("is healthy without turns, and clears the alert", async () => {
    const health = await getSiteFundedAiHealth();
    expect(health.providers.map((p) => p.provider)).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(siteFundedAiHealthLevel(health)).toBe("healthy");
    expect(await runSiteFundedAiAlertCheck()).toBe(0);
    expect(adminAlert).not.toHaveBeenCalled();
  });

  it("warns when over 10% of finished turns fail for reasons other than limits", async () => {
    for (let i = 0; i < 8; i++) await turn({ status: "committed" });
    // Limits by design do not count as failures.
    await turn({
      status: "failed",
      outcome:
        "This included Codex turn reached its emergency cost limit. Start a new turn.",
    });
    await turn({ status: "failed", outcome: "emergency request limit" });
    await turn({ status: "expired", outcome: "turn reservation expired" });
    // An hour ago: outside the window.
    await turn({ status: "failed", outcome: "too old", minutes: 61 });
    // 1 of 12 is not over 10%.
    await turn({
      status: "failed",
      outcome: "Site-funded usage accounting is temporarily unavailable",
    });
    let health = await getSiteFundedAiHealth();
    expect(health.providers.find((p) => p.provider === "openai")).toMatchObject(
      { committed: 8, failed: 1, limited: 3, failure_rate_exceeded: false },
    );
    expect(siteFundedAiHealthLevel(health)).toBe("healthy");

    await turn({
      status: "failed",
      outcome: "Site-funded usage accounting is temporarily unavailable",
    });
    health = await getSiteFundedAiHealth();
    expect(health.providers.find((p) => p.provider === "openai")).toMatchObject(
      {
        committed: 8,
        failed: 2,
        limited: 3,
        failure_rate_exceeded: true,
        nothing_completes: false,
        top_failures: [
          {
            outcome: "Site-funded usage accounting is temporarily unavailable",
            turns: 2,
          },
        ],
      },
    );
    expect(siteFundedAiHealthLevel(health)).toBe("warning");
    expect(siteFundedAiHealthSummary(health)).toBe(
      "anthropic: 0 completed, 0 failed, 0 stopped by limits; openai: 8 completed, 2 failed, 3 stopped by limits (site-funded turns, last 60 minutes).",
    );
    expect(siteFundedAiHealthDetails(health)).toEqual([
      "openai: more than 10% of finished turns failed (not counting limits) in the last 60 minutes",
      "openai failure (2 turns): Site-funded usage accounting is temporarily unavailable",
    ]);

    expect(await runSiteFundedAiAlertCheck()).toBe(1);
    expect(adminAlert).toHaveBeenCalledTimes(1);
    const [{ subject, body }] = adminAlert.mock.calls[0];
    expect(subject).toBe("Site-funded AI turns are failing");
    expect(body).toContain(
      "- openai: more than 10% of finished turns failed (not counting limits)",
    );
    // Stable facts only, so the dedupe recognizes an unchanged condition.
    expect(body).not.toMatch(/\d+ turns|accounting/);
  });

  it("needs at least 5 finished turns", async () => {
    await turn({ status: "committed" });
    for (let i = 0; i < 3; i++) await turn({ status: "failed", outcome: "x" });
    const health = await getSiteFundedAiHealth();
    expect(siteFundedAiHealthLevel(health)).toBe("healthy");
  });

  it("is critical when admitted turns stop completing", async () => {
    // Turns admitted in the last 15 minutes may still be running.
    for (let i = 0; i < 5; i++) await admitted("openai", 5);
    let health = await getSiteFundedAiHealth();
    expect(siteFundedAiHealthLevel(health)).toBe("healthy");

    for (let i = 0; i < 5; i++) await admitted("openai", 30);
    health = await getSiteFundedAiHealth();
    expect(health.providers.find((p) => p.provider === "openai")).toMatchObject(
      { admitted: 5, committed: 0, nothing_completes: true },
    );
    expect(siteFundedAiHealthLevel(health)).toBe("critical");
    expect(await runSiteFundedAiAlertCheck()).toBe(1);
    expect(adminAlert.mock.calls[0][0].body).toContain(
      "- openai: turns are admitted but none completed in the last 60 minutes",
    );

    // One completed turn clears it, and the alert state.
    await turn({ status: "committed" });
    expect(await runSiteFundedAiAlertCheck()).toBe(0);
    const { rows } = await getPool().query(
      "SELECT active FROM admin_alert_state WHERE subject = 'Site-funded AI turns are failing'",
    );
    expect(rows).toEqual([{ active: false }]);
  });
});
