/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  finishSiteFundedSpeechGlobalLocal,
  reserveSiteFundedSpeechGlobalLocal,
} from "./site-funded-speech-reservations";

jest.mock("./site-funded-codex-policy", () => ({
  getSiteFundedAIGlobalPoolLimitMicrousd: jest.fn(async () => 1_000),
}));

beforeAll(async () => await before({ noConat: true }));
afterAll(after);

describe("site-funded speech global reservations", () => {
  it("atomically shares the weekly pool across accounts", async () => {
    const requests = [uuid(), uuid()];
    const accountByRequest = new Map(
      requests.map((requestId) => [requestId, uuid()]),
    );
    const results = await Promise.allSettled(
      requests.map((requestId) =>
        reserveSiteFundedSpeechGlobalLocal({
          requestId,
          accountId: accountByRequest.get(requestId)!,
          reservedMicrousd: 600,
        }),
      ),
    );
    const accepted = results.find((result) => result.status === "fulfilled");
    const rejected = results.find((result) => result.status === "rejected");
    expect(accepted?.status).toBe("fulfilled");
    expect(rejected?.status).toBe("rejected");
    if (accepted?.status !== "fulfilled") throw new Error("missing hold");

    const duplicate = await reserveSiteFundedSpeechGlobalLocal({
      requestId: accepted.value.requestId,
      accountId: accountByRequest.get(accepted.value.requestId)!,
      reservedMicrousd: 600,
    });
    expect(duplicate.created).toBe(false);

    await finishSiteFundedSpeechGlobalLocal({
      requestId: accepted.value.requestId,
      status: "committed",
      costMicrousd: 500,
    });
    const { rows } = await getPool().query(
      `SELECT reserved_microusd, committed_microusd
       FROM site_ai_funding_periods
       WHERE pool_id='site-funded-codex-global'`,
    );
    expect(Number(rows[0].reserved_microusd)).toBe(0);
    expect(Number(rows[0].committed_microusd)).toBe(500);

    const replacement = await reserveSiteFundedSpeechGlobalLocal({
      requestId: uuid(),
      accountId: uuid(),
      reservedMicrousd: 500,
    });
    await finishSiteFundedSpeechGlobalLocal({
      requestId: replacement.requestId,
      status: "released",
    });
  });
});
