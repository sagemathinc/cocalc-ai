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
// Stale holds (a hub that died mid-call) are removed after 5 minutes, as
// speech's are.

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { uuid } from "@cocalc/util/misc";
import { ensureAccountUsageWindowsForEvent } from "@cocalc/server/membership/usage-windows";
import { AI_USAGE_UNITS_PER_DOLLAR } from "./usage-units";
import { ensureExactAIUsageSchema } from "./save-response";
import { getAIUsageStatus } from "./usage-status";
import {
  finishSiteFundedSpeechGlobal,
  reserveSiteFundedSpeechGlobal,
} from "./site-funded-speech-reservations";
import { DECIDE_LIMITS, type DecideFunding } from "./board-decide";

const RESERVATION_TAG = "board-decide-reservation";
const COMMITTED_TAG = "board-decide";
// A hold released after its call failed: kept (at no cost) until the
// reservations expire, so the call still counts toward the account's
// per-minute limit.
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
    async reserve({ accountId, requestId, microusd }) {
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
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        const account = await client.query(
          "SELECT account_id FROM accounts WHERE account_id=$1 FOR UPDATE",
          [accountId],
        );
        if (account.rows.length !== 1) {
          throw codedError("The account is unavailable.", 404);
        }
        await client.query(
          `DELETE FROM ai_usage_log
           WHERE account_id=$1 AND tag IN ($2, $3)
             AND time < NOW() - ($4::BIGINT * INTERVAL '1 millisecond')`,
          [accountId, RESERVATION_TAG, RELEASED_TAG, RESERVATION_TTL_MS],
        );
        // The account's calls in the last minute, held, done or failed,
        // counted under its row's lock: one limit across every hub replica
        // (the per-process count in board-decide.ts is only a cheap guard
        // in front of this one).
        const recent = await client.query(
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
        const requested = microusdToUsageUnits(microusd);
        for (const window of status.windows) {
          const { rows } = await client.query(
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
        await client.query(
          `INSERT INTO ai_usage_log(
             time, input, output, history, account_id, total_tokens,
             prompt_tokens, total_time_s, model, tag, cost_microusd,
             funded_event_id, price_version
           ) VALUES(
             NOW(), '[board-decide-reservation]', '', ARRAY[]::JSONB[], $1, 0,
             0, 0, $2, $3, $4, $5, $6
           )`,
          [
            accountId,
            model,
            RESERVATION_TAG,
            microusd,
            requestId,
            PRICE_VERSION,
          ],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        if (global.created) {
          await finishSiteFundedSpeechGlobal({
            requestId,
            status: "released",
          }).catch(() => undefined);
        }
        throw err;
      } finally {
        client.release();
      }
      return {
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
      };
    },
  };
}
