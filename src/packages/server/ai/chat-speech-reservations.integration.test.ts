/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { getAIUsageStatus } from "./usage-status";
import {
  releaseChatSpeechUsage,
  reserveChatSpeechUsage,
  settleChatSpeechUsage,
} from "./chat-speech-reservations";

jest.mock("./usage-status", () => ({ getAIUsageStatus: jest.fn() }));

const accountId = uuid();

beforeAll(async () => {
  await before({ noConat: true });
  await getPool().query(
    `INSERT INTO accounts(account_id, created, email_address)
     VALUES($1, NOW(), $2)`,
    [accountId, `${accountId}@example.com`],
  );
});

afterAll(after);

describe("site-funded chat speech reservations", () => {
  beforeEach(() => {
    const now = Date.now();
    jest.mocked(getAIUsageStatus).mockResolvedValue({
      units_per_dollar: 100_000,
      windows: [
        {
          window: "5h",
          used: 0,
          limit: 0.1,
          starts_at: new Date(now - 60_000),
          resets_at: new Date(now + 5 * 60 * 60_000),
        },
        {
          window: "7d",
          used: 0,
          limit: 0.1,
          starts_at: new Date(now - 60_000),
          resets_at: new Date(now + 7 * 24 * 60 * 60_000),
        },
      ],
    });
  });

  it("admits only spend that fits after concurrent pending holds", async () => {
    const requests = [uuid(), uuid()];
    const results = await Promise.allSettled(
      requests.map((requestId) =>
        reserveChatSpeechUsage({
          accountId,
          requestId,
          operation: "speech",
          model: "gpt-4o-mini-tts",
          reservedMicrousd: 600,
        }),
      ),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );

    const accepted = results.find((result) => result.status === "fulfilled");
    if (accepted?.status !== "fulfilled") throw new Error("missing hold");
    await settleChatSpeechUsage({
      reservation: accepted.value,
      operation: "speech",
      model: "gpt-4o-mini-tts",
      costMicrousd: 500,
      durationMs: 2_000,
      inputCharacters: 30,
      elapsedMs: 100,
    });

    const { rows } = await getPool().query(
      `SELECT tag, cost_microusd, audio_duration_ms
       FROM ai_usage_log WHERE funded_event_id=$1`,
      [accepted.value.requestId],
    );
    expect(rows[0]).toMatchObject({ tag: "chat-speech-speech" });
    expect(Number(rows[0].cost_microusd)).toBe(500);
    expect(Number(rows[0].audio_duration_ms)).toBe(2_000);
  });

  it("releases a hold when provider work does not complete", async () => {
    const reservation = await reserveChatSpeechUsage({
      accountId,
      requestId: uuid(),
      operation: "transcription",
      model: "gpt-transcribe",
      reservedMicrousd: 100,
    });
    await releaseChatSpeechUsage(reservation);
    const { rows } = await getPool().query(
      `SELECT COUNT(*)::int AS count FROM ai_usage_log
       WHERE funded_event_id=$1`,
      [reservation.requestId],
    );
    expect(rows[0].count).toBe(0);
  });

  it("keeps live holds persistent and settles a retry only once", async () => {
    const reservation = await reserveChatSpeechUsage({
      accountId,
      requestId: uuid(),
      operation: "live",
      model: "gpt-live-1",
      reservedMicrousd: 100,
    });
    const hold = await getPool().query(
      `SELECT expires_at::text AS expires_at FROM site_ai_speech_reservations
       WHERE request_id=$1`,
      [reservation.requestId],
    );
    expect(hold.rows[0].expires_at).toBe("infinity");
    const settle = () =>
      settleChatSpeechUsage({
        reservation,
        operation: "live",
        model: "gpt-live-1",
        costMicrousd: 80,
        durationMs: 1_000,
        elapsedMs: 1_000,
      });
    await settle();
    await settle();
    const usage = await getPool().query(
      `SELECT tag, cost_microusd FROM ai_usage_log WHERE funded_event_id=$1`,
      [reservation.requestId],
    );
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ tag: "chat-speech-live" });
    expect(Number(usage.rows[0].cost_microusd)).toBe(80);
  });
});
