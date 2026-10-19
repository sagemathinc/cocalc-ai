/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Funding for board `decide` calls: the account's site-funded AI allowance
// and the site's AI pool, exactly as site-funded speech uses them
// (chat-speech-reservations.ts; William, Oct 16: "count decide in the
// existing AI allowance and site pool, like speech").
//
// - reserve: the account's AI usage windows must all have room for the
//   upper bound, and the site pool must too; the hold is a row in
//   ai_usage_log (counted by every window at once) and a global hold.
// - commit: the provider's reported cost, all of it. A cost above the hold
//   (which max_price should prevent) is recorded in full and alerted.
// - release: both holds go.
// - limits, counted under the account's row lock, so one limit for every
//   hub replica: the account's calls a minute, and its calls a board (the
//   board's project and real path are on the hold's row) an hour. Held,
//   done and failed calls all count.
// A stale hold (a hub that died mid-call) is released after 5 minutes, as
// speech's are.

import getLogger from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import { ensureAccountUsageWindowsForEvent } from "@cocalc/server/membership/usage-windows";
import { AI_USAGE_UNITS_PER_DOLLAR } from "./usage-units";
import { ensureExactAIUsageSchema } from "./save-response";
import { getAIUsageStatus } from "./usage-status";
import {
  finishSiteFundedSpeechGlobal,
  reserveSiteFundedSpeechGlobal,
} from "./site-funded-speech-reservations";
import {
  DECIDE_LIMITS,
  type DecideFunding,
  type DecideReservation,
} from "./board-decide";

const RESERVATION_TAG = "board-decide-reservation";
const COMMITTED_TAG = "board-decide";
// A hold released after its call failed (or gone stale): kept at no cost
// for an hour, so the call still counts toward the limits above.
const RELEASED_TAG = "board-decide-released";
const RESERVATION_TTL_MS = 5 * 60_000;
const PRICE_VERSION = "board-decide-2026-10-16";
const logger = getLogger("server:ai:board-decide-funding");

function codedError(message: string, code: number): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

function microusdToUsageUnits(microusd: number): number {
  return (microusd * AI_USAGE_UNITS_PER_DOLLAR) / 1_000_000;
}

const EXHAUSTED =
  "Your AI allowance is used up for now, so this answer can't be checked.";

export function siteFundedDecideFunding({
  model,
}: {
  model: string;
}): DecideFunding {
  return {
    async reserve({ accountId, requestId, microusd, board }) {
      if (!Number.isSafeInteger(microusd) || microusd <= 0) {
        throw new Error("microusd must be a positive safe integer");
      }
      await ensureExactAIUsageSchema();
      await ensureAccountUsageWindowsForEvent({ account_id: accountId });
      const status = await getAIUsageStatus({ account_id: accountId });
      if (
        status.windows.length === 0 ||
        status.windows.some(
          ({ limit, starts_at, resets_at }) =>
            typeof limit !== "number" ||
            limit <= 0 ||
            starts_at == null ||
            resets_at == null,
        )
      ) {
        throw codedError(EXHAUSTED, 403);
      }
      const global = await reserveSiteFundedSpeechGlobal({
        accountId,
        requestId,
        reservedMicrousd: microusd,
      });
      // The global hold is keyed by the request id, durably: a finished id
      // was refused above (409). An active one returned as created:false is
      // this same request still in flight, here or on another replica:
      // refused, so only its creator calls the provider and settles the
      // hold. The per-process check (board-decide.ts) is only a fast path.
      if (!global.created) {
        throw codedError("This answer is already being checked.", 409);
      }
      // From here this request owns the global hold it just created. Every
      // step until the reservation is returned (the connection, BEGIN, each
      // query, COMMIT) is in this one try: any throw releases the hold,
      // exactly once, and the rollback cannot prevent that (Codex on
      // #1134). Once returned, the caller commits or releases it.
      // One exception: a COMMIT that throws may have committed (its reply
      // lost). Then the hold's row is read back on another connection:
      // - there: the reservation stands; the hold is kept and returned, as
      //   for a clean COMMIT, and the caller settles both;
      // - not there, and the ROLLBACK was acknowledged: it didn't commit;
      //   the hold is released, once;
      // - not there on a broken connection (its COMMIT may still land), or
      //   unreadable: unknown; the hold is kept and the call fails without
      //   the provider. Both holds then go lazily: the global one is
      //   expired by a later reservation in the site pool once its 5
      //   minutes pass, and the account's row, if it committed, is released
      //   at no cost (still counted for the hour) by this account's next
      //   reservation that commits after those 5 minutes.
      // The reservation this call returns, once its hold is in place.
      const reservation = (): DecideReservation => ({
        async commit(costMicrousd: number) {
          if (!Number.isSafeInteger(costMicrousd) || costMicrousd <= 0) {
            throw new Error("decide cost must be a positive safe integer");
          }
          // A cost above the hold is never discarded: the account's row
          // records all of it, the site pool gets the excess as a hold of
          // its own, and it is logged as an error to alert admins. The
          // reservation is a real bound (max_price), so this should not
          // happen.
          const excess = Math.max(0, costMicrousd - microusd);
          await finishSiteFundedSpeechGlobal({
            requestId,
            status: "committed",
            costMicrousd: Math.min(costMicrousd, microusd),
          });
          if (excess > 0) {
            logger.error("board decide cost exceeded its reservation", {
              accountId,
              requestId,
              reservedMicrousd: microusd,
              costMicrousd,
            });
            const excessId = uuid();
            try {
              await reserveSiteFundedSpeechGlobal({
                accountId,
                requestId: excessId,
                reservedMicrousd: excess,
              });
              await finishSiteFundedSpeechGlobal({
                requestId: excessId,
                status: "committed",
                costMicrousd: excess,
              });
            } catch (err) {
              logger.error(
                "board decide excess not recorded in the site pool",
                {
                  accountId,
                  requestId,
                  excessMicrousd: excess,
                  err: `${err}`,
                },
              );
            }
          }
          const { rows } = await getPool().query(
            `UPDATE ai_usage_log SET input=$3, tag=$4, cost_microusd=$5
             WHERE account_id=$1 AND funded_event_id=$2 AND tag=$6
             RETURNING funded_event_id`,
            [
              accountId,
              requestId,
              "[board-decide]",
              COMMITTED_TAG,
              costMicrousd,
              RESERVATION_TAG,
            ],
          );
          if (rows.length !== 1)
            throw new Error("decide reservation was not found");
        },
        async release() {
          const results = await Promise.allSettled([
            finishSiteFundedSpeechGlobal({ requestId, status: "released" }),
            getPool().query(
              `UPDATE ai_usage_log
                  SET input=$4, tag=$5, cost_microusd=0
               WHERE account_id=$1 AND funded_event_id=$2 AND tag=$3`,
              [
                accountId,
                requestId,
                RESERVATION_TAG,
                "[board-decide-released]",
                RELEASED_TAG,
              ],
            ),
          ]);
          const failure = results.find(
            (r): r is PromiseRejectedResult => r.status === "rejected",
          );
          if (failure) throw failure.reason;
        },
      });
      let client: PoolClient | undefined;
      let broken = false;
      let committing = false;
      try {
        const db = await getPool().connect();
        client = db;
        await db.query("BEGIN");
        const account = await db.query(
          "SELECT account_id FROM accounts WHERE account_id=$1 FOR UPDATE",
          [accountId],
        );
        if (account.rows.length !== 1) {
          throw codedError("The account is unavailable.", 404);
        }
        // A stale hold (its hub died mid-call) no longer holds money: it
        // becomes a released row at no cost, which still counts toward the
        // limits below. Released rows are kept for the longest window they
        // count toward, the board's hour.
        await db.query(
          `UPDATE ai_usage_log SET input=$3, tag=$4, cost_microusd=0
           WHERE account_id=$1 AND tag=$2
             AND time < NOW() - ($5::BIGINT * INTERVAL '1 millisecond')`,
          [
            accountId,
            RESERVATION_TAG,
            "[board-decide-released]",
            RELEASED_TAG,
            RESERVATION_TTL_MS,
          ],
        );
        await db.query(
          `DELETE FROM ai_usage_log
           WHERE account_id=$1 AND tag=$2 AND time < NOW() - INTERVAL '1 hour'`,
          [accountId, RELEASED_TAG],
        );
        // The account's calls in the last minute, held, done or failed,
        // counted under its row's lock: one limit across every hub replica
        // (the per-process count in board-decide.ts is only a cheap guard
        // in front of this one).
        const recent = await db.query(
          `SELECT COUNT(*) AS n FROM ai_usage_log
           WHERE account_id=$1 AND tag IN ($2, $3, $4)
             AND time > NOW() - INTERVAL '1 minute'`,
          [accountId, RESERVATION_TAG, COMMITTED_TAG, RELEASED_TAG],
        );
        if (
          Number(recent.rows[0]?.n ?? 0) >=
          DECIDE_LIMITS.callsPerAccountPerMinute
        ) {
          throw codedError(
            "Too many answers checked. Try again in a minute.",
            429,
          );
        }
        // The account's calls on this board (as the file's server resolved
        // it) in the last hour, the same way, under the same lock.
        const onBoard = await db.query(
          `SELECT COUNT(*) AS n FROM ai_usage_log
           WHERE account_id=$1 AND tag IN ($2, $3, $4)
             AND project_id=$5 AND path=$6
             AND time > NOW() - INTERVAL '1 hour'`,
          [
            accountId,
            RESERVATION_TAG,
            COMMITTED_TAG,
            RELEASED_TAG,
            board.projectId,
            board.path,
          ],
        );
        if (
          Number(onBoard.rows[0]?.n ?? 0) >= DECIDE_LIMITS.callsPerBoardPerHour
        ) {
          throw codedError(
            "Too many answers checked on this board. Try later.",
            429,
          );
        }
        const requested = microusdToUsageUnits(microusd);
        for (const window of status.windows) {
          const { rows } = await db.query(
            `SELECT SUM(COALESCE(
               cost_microusd * $4::numeric / 1000000, usage_units, 0
             )) AS used
             FROM ai_usage_log
             WHERE account_id=$1 AND time >= $2 AND time < $3`,
            [
              accountId,
              window.starts_at,
              window.resets_at,
              AI_USAGE_UNITS_PER_DOLLAR,
            ],
          );
          if (
            Number(rows[0]?.used ?? 0) + requested >
            (window.limit as number)
          ) {
            throw codedError(EXHAUSTED, 403);
          }
        }
        await db.query(
          `INSERT INTO ai_usage_log(
             time, input, output, history, account_id, total_tokens,
             prompt_tokens, total_time_s, model, tag, cost_microusd,
             funded_event_id, price_version, project_id, path
           ) VALUES(
             NOW(), '[board-decide-reservation]', '', ARRAY[]::JSONB[], $1, 0,
             0, 0, $2, $3, $4, $5, $6, $7, $8
           )`,
          [
            accountId,
            model,
            RESERVATION_TAG,
            microusd,
            requestId,
            PRICE_VERSION,
            board.projectId,
            board.path,
          ],
        );
        committing = true;
        await db.query("COMMIT");
      } catch (err) {
        if (client != null) {
          // Best effort: a broken connection is discarded, not reused.
          await client.query("ROLLBACK").catch(() => {
            broken = true;
          });
          // Given back before anything else here takes a connection (the
          // read-back, the release): on a full pool they would otherwise
          // wait for the one this request holds.
          const done = client;
          client = undefined;
          done.release(broken ? true : undefined);
        }
        if (committing) {
          const row = await holdRow(accountId, requestId);
          if (row === "present") {
            logger.warn("board decide COMMIT reply lost; the hold committed", {
              accountId,
              requestId,
              err: `${err}`,
            });
            return reservation();
          }
          // Absent is only "didn't commit" when the ROLLBACK was
          // acknowledged. On a broken connection a COMMIT may still be
          // applied after the read (astra, CORR-781-1), so absent is
          // unknown too.
          if (row === "unknown" || (row === "absent" && broken)) {
            // Whether it committed is unknown: the global hold is kept (it
            // expires), never released while the account's row may hold.
            logger.error("board decide COMMIT outcome unknown; hold kept", {
              accountId,
              requestId,
              err: `${err}`,
            });
            throw err;
          }
        }
        await finishSiteFundedSpeechGlobal({
          requestId,
          status: "released",
        }).catch((releaseErr) =>
          // The hold then expires with its reservation (5 minutes).
          logger.error("board decide global hold not released", {
            accountId,
            requestId,
            err: `${releaseErr}`,
          }),
        );
        throw err;
      } finally {
        client?.release(broken ? true : undefined);
      }
      return reservation();
    },
  };
}

// Whether a reservation's hold row is in ai_usage_log, after a COMMIT
// whose reply was lost: "unknown" when it can't be read.
async function holdRow(
  accountId: string,
  requestId: string,
): Promise<"present" | "absent" | "unknown"> {
  try {
    const { rows } = await getPool().query(
      `SELECT 1 FROM ai_usage_log
       WHERE account_id=$1 AND funded_event_id=$2 AND tag=$3`,
      [accountId, requestId, RESERVATION_TAG],
    );
    return rows.length === 1 ? "present" : "absent";
  } catch {
    return "unknown";
  }
}
