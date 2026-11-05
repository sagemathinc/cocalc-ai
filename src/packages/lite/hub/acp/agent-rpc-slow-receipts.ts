/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An agent message's launch receipt when the launch acknowledgment timed out
// although admission had started: "slow to confirm" (no Resubmit), until the
// reconcile poll finds the turn (accepted) or gives up after 30 minutes
// (plain unknown, as before). The durable rows are in
// ../sqlite/agent-rpc-slow-receipts.
//
// Every write of a receipt here is a compare-and-set: only while the message
// still carries this attempt's agent_rpc metadata and its receipt is one this
// step may replace. The check and the set run with no await between them, in
// the process that holds the chat document (the project host, which is the
// only writer of agent_rpc_launch), so no other write lands in between.

import getLogger from "@cocalc/backend/logger";
import type { AgentRpcAttempt, AgentRpcSource } from "@cocalc/conat/agents/rpc";
import type { AgentRpcTurnState } from "@cocalc/conat/agents/rpc-turn";
import type { ImmerDB } from "@cocalc/chat/server";
import {
  SLOW_RECEIPT_EXPIRY_MS,
  claimDueSlowReceipts,
  deleteSlowReceipt,
  type SlowReceiptRow,
} from "../sqlite/agent-rpc-slow-receipts";

const logger = getLogger("lite:acp:agent-rpc-slow-receipts");

/** The receipt's text after a timed-out acknowledgment (as before). */
export const LAUNCH_TIMEOUT_TEXT = "The agent launch acknowledgment timed out.";
/** The receipt's text while the turn is looked for. */
export const LAUNCH_SLOW_TEXT =
  "The agent is slow to confirm this message; checking.";

export type ReceiptDB = Pick<
  ImmerDB,
  "get_one" | "set" | "commit" | "save" | "save_to_disk"
>;

export interface ReceiptMessageKey {
  date: Date;
  sender_id: string;
  message_id: string;
}

interface LaunchReceipt {
  state?: string;
  slow?: boolean;
}

/** Only the receipt this attempt wrote before admission. */
export function isPendingLaunch(launch: LaunchReceipt | undefined): boolean {
  return launch?.state === "pending";
}

/** Still being looked for: slow, or pending (a crash came between the row
 * and the slow receipt). */
export function isUnsettledLaunch(launch: LaunchReceipt | undefined): boolean {
  return (
    launch?.state === "pending" ||
    (launch?.state === "unknown" && launch?.slow === true)
  );
}

export function slowLaunchReceipt(now = Date.now()) {
  return {
    state: "unknown" as const,
    slow: true as const,
    error: LAUNCH_SLOW_TEXT,
    updated_at: now,
  };
}

export function unknownLaunchReceipt(now = Date.now()) {
  return {
    state: "unknown" as const,
    error: LAUNCH_TIMEOUT_TEXT,
    updated_at: now,
  };
}

/**
 * "written": the receipt was replaced (committed; the caller saves it).
 * "superseded": the message is another attempt's now, or its receipt is not
 * one this step may replace (accepted, rejected, newer): nothing written.
 * "missing": no such message.
 */
export function casLaunchReceipt(
  db: ReceiptDB,
  key: ReceiptMessageKey,
  attempt: { attempt_id: string; agent_network_id: string },
  replaceable: (launch: LaunchReceipt | undefined) => boolean,
  next: object,
): "written" | "superseded" | "missing" {
  const where = {
    event: "chat",
    date: key.date,
    sender_id: key.sender_id,
    message_id: key.message_id,
  };
  const raw = db.get_one(where);
  const row = typeof raw?.toJS === "function" ? raw.toJS() : raw;
  if (!row || row.message_id !== key.message_id) return "missing";
  const rpc = row.agent_rpc;
  if (
    rpc?.attempt_id !== attempt.attempt_id ||
    rpc?.agent_network_id !== attempt.agent_network_id ||
    !replaceable(row.agent_rpc_launch)
  )
    return "superseded";
  db.set({ ...where, agent_rpc_launch: next });
  db.commit();
  return "written";
}

function messageKey(row: SlowReceiptRow): ReceiptMessageKey {
  return {
    date: new Date(row.message_date),
    sender_id: row.sender_id,
    message_id: row.message_id,
  };
}

export interface SlowReceiptReconcileDeps {
  withChat<T>(
    project_id: string,
    path: string,
    fn: (db: ReceiptDB) => Promise<T>,
  ): Promise<T>;
  turnState(
    source: AgentRpcSource,
    attempt: AgentRpcAttempt,
    accountId: string,
  ): AgentRpcTurnState | undefined;
  now?: () => number;
  limit?: number;
}

export interface SlowReceiptReconcileCounts {
  claimed: number;
  accepted: number;
  expired: number;
  settled: number;
  waiting: number;
  failed: number;
}

/**
 * One pass over the rows due now. For each: its turn, looked up with the
 * row's own (authorized) account, source, network and target, never the
 * message's content. A turn makes the receipt accepted; none by the expiry
 * makes it plain unknown; otherwise it waits for its next check. The row is
 * removed only after the receipt is final and saved (written now, or already
 * final), or when the message is gone; any failure keeps it for a later
 * pass. Rows older than the expiry take the same path, however old: none is
 * dropped without its receipt being made final.
 */
export async function reconcileSlowAgentRpcReceipts(
  deps: SlowReceiptReconcileDeps,
): Promise<SlowReceiptReconcileCounts> {
  const now = deps.now?.() ?? Date.now();
  const counts: SlowReceiptReconcileCounts = {
    claimed: 0,
    accepted: 0,
    expired: 0,
    settled: 0,
    waiting: 0,
    failed: 0,
  };
  const rows = claimDueSlowReceipts(now, deps.limit ?? 50);
  counts.claimed = rows.length;
  for (const row of rows) {
    let turn: AgentRpcTurnState | undefined;
    try {
      turn = deps.turnState(
        row.source,
        {
          version: 3,
          attempt_id: row.attempt_id,
          agent_network_id: row.agent_network_id,
          target: row.target,
        },
        row.account_id,
      );
    } catch (err) {
      counts.failed += 1;
      logger.debug("slow receipt turn lookup failed", {
        attempt_id: row.attempt_id,
        err: `${err}`,
      });
      continue;
    }
    const expired = now >= row.created_at + SLOW_RECEIPT_EXPIRY_MS;
    if (!turn && !expired) {
      counts.waiting += 1;
      continue;
    }
    try {
      const result = await deps.withChat(
        row.project_id,
        row.path,
        async (db) => {
          const result = casLaunchReceipt(
            db,
            messageKey(row),
            row,
            isUnsettledLaunch,
            turn
              ? { state: "accepted", confirmed_late: true, updated_at: now }
              : unknownLaunchReceipt(now),
          );
          // Saved before the row goes, also when nothing was written now: a
          // final receipt committed by an earlier pass whose save failed.
          if (result !== "missing") {
            await db.save();
            await db.save_to_disk();
          }
          return result;
        },
      );
      deleteSlowReceipt(row);
      if (result === "written") {
        if (turn) counts.accepted += 1;
        else counts.expired += 1;
      } else {
        counts.settled += 1;
      }
    } catch (err) {
      counts.failed += 1;
      logger.debug("slow receipt not settled yet", {
        attempt_id: row.attempt_id,
        err: `${err}`,
      });
    }
  }
  if (counts.claimed > 0) logger.debug("slow receipt pass", counts);
  return counts;
}

let running = false;
/** The reconcile poll's entry: one pass at a time in this process (claims
 * keep passes in different processes apart). */
export async function reconcileSlowAgentRpcReceiptsOnce(
  deps: SlowReceiptReconcileDeps,
): Promise<SlowReceiptReconcileCounts | undefined> {
  if (running) return;
  running = true;
  try {
    return await reconcileSlowAgentRpcReceipts(deps);
  } finally {
    running = false;
  }
}
