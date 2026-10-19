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
import { RecentTimes } from "@cocalc/util/recent-times";
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
// A hold whose provider call may have run: settled after it, or finished
// as a charge when it goes stale, never released at no cost.
const CALLING_TAG = "board-decide-calling";
// A settlement step is retried a little before it is left to the stale
// finish.
const SETTLE_ATTEMPTS = 3;

async function retried<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      if (attempt >= SETTLE_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
}
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
      // This account's paid calls whose site-pool charge isn't confirmed
      // yet are settled first (each retried by every reservation until it
      // is), so none is left with only one side charged.
      await settlePendingCalls(accountId);
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
      //
      // Settlement (Codex on #1134): the account's hold row is its durable
      // state. Before the provider is called it is marked CALLING, so a
      // hold whose provider may have run is never released at no cost
      // (a stale RESERVATION, never called, still is). After the call:
      // 1. the row records the cost, still CALLING (the global pending);
      // 2. the global hold is settled (idempotent: a settled one is left);
      // 3. the row becomes COMMITTED.
      // Each step is retried. If one still fails, nothing is lost: the row
      // stays CALLING, already charging the account its cost, until every
      // later reservation of the account (settlePendingCalls) has the site
      // pool charged it too, late if its hold expired, and only then
      // makes it COMMITTED. The call's answer stands: it is paid for, so it
      // is not refused.
      const accountUpdate = async (
        set: string,
        params: unknown[],
        fromTags: string[],
      ): Promise<number> => {
        const { rows } = await getPool().query(
          `UPDATE ai_usage_log SET ${set}
           WHERE account_id=$1 AND funded_event_id=$2 AND tag = ANY($3::TEXT[])
           RETURNING funded_event_id`,
          [accountId, requestId, fromTags, ...params],
        );
        return rows.length;
      };
      const reservation = (): DecideReservation => ({
        async calling() {
          // Before the provider: if this can't be recorded, it isn't called.
          const n = await accountUpdate(
            "tag=$4",
            [CALLING_TAG],
            [RESERVATION_TAG],
          );
          if (n !== 1) throw new Error("decide reservation was not found");
        },
        async commit(costMicrousd: number) {
          if (!Number.isSafeInteger(costMicrousd) || costMicrousd <= 0) {
            throw new Error("decide cost must be a positive safe integer");
          }
          const failed = (step: string, err: unknown) =>
            logger.error(`board decide settlement: ${step} failed`, {
              accountId,
              requestId,
              costMicrousd,
              err: `${err}`,
            });
          // 1. The cost, durably, on the account's row (still CALLING).
          let costRecorded = false;
          try {
            await retried(async () => {
              const n = await accountUpdate(
                "input=$4, cost_microusd=$5, tag=$6",
                ["[board-decide]", costMicrousd, CALLING_TAG],
                [CALLING_TAG, RESERVATION_TAG],
              );
              if (n !== 1 && !(await settled())) {
                throw new Error("decide hold was not found");
              }
            });
            costRecorded = true;
          } catch (err) {
            // Then the row keeps its reserved upper bound, charged in full
            // when it is finished as stale.
            failed("recording the cost", err);
          }
          // 2. The site pool.
          // A cost above the hold is never discarded: the account's row
          // records all of it, the site pool gets the excess as a hold of
          // its own, and it is logged as an error to alert admins. The
          // reservation is a real bound (max_price), so this should not
          // happen.
          const excess = Math.max(0, costMicrousd - microusd);
          let globalSettled = false;
          try {
            await retried(() =>
              finishSiteFundedSpeechGlobal({
                requestId,
                status: "committed",
                costMicrousd: Math.min(costMicrousd, microusd),
                chargeIfClosed: true,
              }),
            );
            globalSettled = true;
          } catch (err) {
            failed("settling the site pool", err);
          }
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
          // 3. Done: only once both sides are. Otherwise the row stays
          // CALLING and is finished as stale.
          if (!costRecorded || !globalSettled) return;
          try {
            await retried(async () => {
              const n = await accountUpdate(
                "tag=$4",
                [COMMITTED_TAG],
                [CALLING_TAG],
              );
              // A row not found is retried and logged too (daybreak2); the
              // stale finish is still there behind it.
              if (n !== 1) throw new Error("decide hold was not found");
            });
          } catch (err) {
            failed("marking it settled", err);
          }
        },
        async release() {
          // The provider failed: no charge. A row whose release fails stays
          // CALLING and is charged when finished as stale (it may have run).
          const results = await Promise.allSettled([
            retried(() =>
              finishSiteFundedSpeechGlobal({ requestId, status: "released" }),
            ),
            retried(() =>
              accountUpdate(
                "input=$4, tag=$5, cost_microusd=0",
                ["[board-decide-released]", RELEASED_TAG],
                [RESERVATION_TAG, CALLING_TAG],
              ),
            ),
          ]);
          const failure = results.find(
            (r): r is PromiseRejectedResult => r.status === "rejected",
          );
          if (failure) throw failure.reason;
        },
      });
      // Whether the row was already settled (a retry whose earlier attempt
      // went through).
      const settled = async (): Promise<boolean> => {
        const { rows } = await getPool().query(
          `SELECT 1 FROM ai_usage_log
           WHERE account_id=$1 AND funded_event_id=$2 AND tag=$3
             AND input='[board-decide]'`,
          [accountId, requestId, CALLING_TAG],
        );
        return rows.length === 1;
      };
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
           WHERE account_id=$1 AND tag IN ($2, $3, $4, $5)
             AND time > NOW() - INTERVAL '1 minute'`,
          [
            accountId,
            RESERVATION_TAG,
            COMMITTED_TAG,
            RELEASED_TAG,
            CALLING_TAG,
          ],
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
           WHERE account_id=$1 AND tag IN ($2, $3, $4, $7)
             AND project_id=$5 AND path=$6
             AND time > NOW() - INTERVAL '1 hour'`,
          [
            accountId,
            RESERVATION_TAG,
            COMMITTED_TAG,
            RELEASED_TAG,
            board.projectId,
            board.path,
            CALLING_TAG,
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

// A CALLING hold row means: the provider may have run, the account is
// charged its cost (the call's, or else the reserved upper bound), and
// the site pool's charge isn't confirmed. Once its 5 minutes pass (no
// call is still running), the site pool is charged that cost, late if its
// hold already expired or was released, and only once that is confirmed
// is the row COMMITTED. A failure leaves it CALLING, for the next pass.
//
// Bounded work on the request path (daybreak2): at most
// PENDING_SETTLE_BATCH rows a pass, oldest first; one pass at a time per
// account in this process (a concurrent reservation shares it); a row
// attempted in the last PENDING_SETTLE_BACKOFF_MS is skipped; the pass
// stops at its first failure, so an outage costs a request at most one
// attempt; and it waits at most PENDING_SETTLE_BUDGET_MS in all for the
// site pool (a remote-wait budget; its own SELECT and UPDATE are outside
// it), so a slow site pool can't stall admission. A remote settle it stops
// waiting for stays registered here until it really ends (daybreak2):
// no pass starts another for that row meanwhile, and at most
// MAX_SETTLES_IN_FLIGHT are in flight in this process. The row stays
// CALLING until a pass confirms its settle; settling is idempotent.
// Rows not reached stay CALLING for a later pass.
export const PENDING_SETTLE_BATCH = 3;
export const PENDING_SETTLE_BACKOFF_MS = 30_000;
export const PENDING_SETTLE_BUDGET_MS = 2_000;
export const MAX_SETTLES_IN_FLIGHT = 100;
const settling = new Map<string, Promise<void>>();
// Remote settles in flight, by request id, until each really ends.
const settlesInFlight = new Map<string, Promise<void>>();

/** For tests. */
export function pendingSettlesInFlightForTests(): number {
  return settlesInFlight.size;
}
const settleAttempts = new RecentTimes({
  windowMs: PENDING_SETTLE_BACKOFF_MS,
  maxKeys: 10_000,
});

/** For tests. */
export function resetPendingSettleBackoffForTests(): void {
  settleAttempts.clear();
}

async function settlePendingCalls(accountId: string): Promise<void> {
  const running = settling.get(accountId);
  if (running) return await running;
  const pass = settlePendingBatch(accountId);
  settling.set(accountId, pass);
  try {
    await pass;
  } finally {
    settling.delete(accountId);
  }
}

async function settlePendingBatch(accountId: string): Promise<void> {
  let pending: { funded_event_id: string; cost_microusd: string }[];
  try {
    ({ rows: pending } = await getPool().query(
      `SELECT funded_event_id, cost_microusd FROM ai_usage_log
       WHERE account_id=$1 AND tag=$2
         AND time < NOW() - ($3::BIGINT * INTERVAL '1 millisecond')
       ORDER BY time, funded_event_id
       LIMIT $4`,
      [accountId, CALLING_TAG, RESERVATION_TTL_MS, PENDING_SETTLE_BATCH],
    ));
  } catch (err) {
    logger.error("board decide pending settlements not read", {
      accountId,
      err: `${err}`,
    });
    return;
  }
  const deadline = Date.now() + PENDING_SETTLE_BUDGET_MS;
  for (const row of pending) {
    const requestId = `${row.funded_event_id}`;
    const costMicrousd = Number(row.cost_microusd);
    // One remote settle per row at a time, whoever stopped waiting for it.
    if (settlesInFlight.has(requestId)) continue;
    if (settlesInFlight.size >= MAX_SETTLES_IN_FLIGHT) return;
    if (!settleAttempts.take(requestId, Date.now(), 1)) continue;
    const left = deadline - Date.now();
    if (left <= 0) return;
    try {
      const settle = finishSiteFundedSpeechGlobal({
        requestId,
        status: "committed",
        costMicrousd,
        chargeIfClosed: true,
      });
      settlesInFlight.set(requestId, settle);
      settle
        .catch(() => undefined)
        .finally(() => settlesInFlight.delete(requestId));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          settle,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("pending settlement over budget")),
              left,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      await getPool().query(
        `UPDATE ai_usage_log SET tag=$4,
           input=CASE WHEN input='[board-decide]' THEN input
                      ELSE '[board-decide-unsettled]' END
         WHERE account_id=$1 AND funded_event_id=$2 AND tag=$3`,
        [accountId, requestId, CALLING_TAG, COMMITTED_TAG],
      );
    } catch (err) {
      logger.error("board decide pending settlement failed; retried later", {
        accountId,
        requestId,
        costMicrousd,
        err: `${err}`,
      });
      return; // the rest wait for a later pass
    }
  }
}
