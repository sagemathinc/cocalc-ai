/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  ensureSiteFundedSpeechReservationTable,
  finishSiteFundedSpeechGlobalLocal,
  reserveSiteFundedSpeechGlobalLocal,
} from "./site-funded-speech-reservations";

jest.mock("./site-funded-codex-policy", () => ({
  getSiteFundedAIGlobalPoolLimitMicrousd: jest.fn(async () => 1_000),
}));

beforeAll(async () => await before({ noConat: true }), 60_000);
afterAll(after);

describe("site-funded speech global reservations", () => {
  beforeEach(async () => {
    await ensureSiteFundedSpeechReservationTable();
    await getPool().query("DELETE FROM site_ai_speech_reservations");
    await getPool().query("DELETE FROM site_ai_funding_periods");
  });
  // PGlite serializes transactions and cannot reproduce PostgreSQL row-lock cycles.
  const postgresTest =
    process.env.COCALC_TEST_USE_PGLITE === "1" ? it.skip : it;
  postgresTest.each(["committed", "released"] as const)(
    "locks the pool before the reservation when finishing as %s",
    async (status) => {
      const requestId = uuid();
      await reserveSiteFundedSpeechGlobalLocal({
        requestId,
        accountId: uuid(),
        reservedMicrousd: 100,
      });
      const pool = getPool();
      const admission = await pool.connect();
      let settlement: Promise<unknown> | undefined;
      try {
        await admission.query("BEGIN");
        const {
          rows: [{ pid }],
        } = await admission.query("SELECT pg_backend_pid() AS pid");
        await admission.query(
          `SELECT pool_id FROM site_ai_funding_periods
           WHERE pool_id='site-funded-codex-global' FOR UPDATE`,
        );
        settlement = finishSiteFundedSpeechGlobalLocal({
          requestId,
          status,
          costMicrousd: status === "committed" ? 50 : 0,
        }).then(
          () => undefined,
          (error) => error,
        );

        const deadline = Date.now() + 10_000;
        while (true) {
          await admission.query("SELECT pg_stat_clear_snapshot()");
          const { rows } = await admission.query(
            `SELECT pid FROM pg_stat_activity
             WHERE $1::int = ANY(pg_blocking_pids(pid))`,
            [pid],
          );
          if (rows.length > 0) break;
          if (Date.now() > deadline)
            throw new Error("settlement did not wait for the pool lock");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // Admission must still be able to lock the reservation while settlement
        // waits for its pool. Reversed ordering fails here with 55P03.
        await admission.query(
          `SELECT request_id FROM site_ai_speech_reservations
           WHERE request_id=$1 FOR UPDATE NOWAIT`,
          [requestId],
        );
        await admission.query("COMMIT");
        expect(await settlement).toBeUndefined();
        const { rows } = await pool.query(
          `SELECT status FROM site_ai_speech_reservations WHERE request_id=$1`,
          [requestId],
        );
        expect(rows[0].status).toBe(status);
      } finally {
        await admission.query("ROLLBACK");
        admission.release();
        await settlement;
      }
    },
    20_000,
  );

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
