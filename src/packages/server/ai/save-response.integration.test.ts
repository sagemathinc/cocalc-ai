/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { getAIUsageStatus } from "./usage-status";
import { recordSiteFundedCodexAccountUsage } from "./save-response";

const accountId = uuid();
const fundedTurnId = uuid();
const projectId = uuid();

beforeAll(async () => {
  await before({ noConat: true });
  await getPool().query(
    `INSERT INTO accounts(account_id, created, email_address)
     VALUES($1, NOW(), $2)`,
    [accountId, `${accountId}@example.com`],
  );
});

afterAll(after);

describe("exact account AI usage ledger", () => {
  it("records each funded request once and sums the turn's exact usage", async () => {
    const eventId = uuid();
    const usage = {
      account_id: accountId,
      funded_turn_id: fundedTurnId,
      project_id: projectId,
      event: {
        eventId,
        reservationId: uuid(),
        providerRequestId: "response-test-1",
        requestSequence: 1,
        model: "gpt-5.6-luna" as const,
        inputTokens: 12_345,
        cachedInputTokens: 2_345,
        cacheWriteInputTokens: 123,
        outputTokens: 456,
        reasoningOutputTokens: 78,
        providerToolFeesMicrousd: 90,
        durationMs: 2_500,
      },
      cost_microusd: 71_234,
      price_version: "openai-2026-08-01",
      long_context: false,
    };
    await recordSiteFundedCodexAccountUsage(usage);
    await recordSiteFundedCodexAccountUsage(usage);
    await recordSiteFundedCodexAccountUsage({
      ...usage,
      event: {
        ...usage.event,
        eventId: uuid(),
        providerRequestId: "response-test-2",
        requestSequence: 2,
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 100,
      },
      cost_microusd: 28_766,
    });

    const { rows } = await getPool().query(
      `SELECT COUNT(*)::int AS count, SUM(cost_microusd) AS cost_microusd,
              MIN(funded_event_id::text) FILTER (WHERE request_sequence = 1) AS funded_event_id,
              MAX(prompt_tokens) AS prompt_tokens,
              MAX(cached_input_tokens) AS cached_input_tokens,
              MAX(output_tokens) AS output_tokens,
              MAX(request_sequence) AS request_sequence
       FROM ai_usage_log WHERE funded_turn_id = $1`,
      [fundedTurnId],
    );
    expect(rows[0]).toMatchObject({ count: 2 });
    expect(Number(rows[0].cost_microusd)).toBe(100_000);
    expect(rows[0].funded_event_id).toBe(eventId);
    expect(Number(rows[0].prompt_tokens)).toBe(12_345);
    expect(Number(rows[0].cached_input_tokens)).toBe(2_345);
    expect(Number(rows[0].output_tokens)).toBe(456);
    expect(Number(rows[0].request_sequence)).toBe(2);

    const status = await getAIUsageStatus({
      account_id: accountId,
      include_site_funded_credits: true,
    });
    expect(status.windows.find(({ window }) => window === "5h")?.used).toBe(10);
    expect(status.windows.find(({ window }) => window === "7d")?.used).toBe(10);
    expect(
      status.windows.find(({ window }) => window === "5h")
        ?.site_funded_credits_microusd,
    ).toEqual({ [fundedTurnId]: 100_000 });
    expect(
      status.windows.find(({ window }) => window === "7d")
        ?.site_funded_credits_microusd,
    ).toEqual({ [fundedTurnId]: 100_000 });
  });
});
