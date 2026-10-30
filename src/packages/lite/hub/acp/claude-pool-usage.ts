/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// What each Auto turn uses of its subscription's 5-hour window, as Claude
// reports it during the turn; sent with the account's next pick, which
// estimates the cost of a turn from it.

import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import { claudeRateLimitSnapshot } from "@cocalc/util/ai/claude-usage";

type TurnCost = { credential_id: string; cost: number };

// Per account, until its next pick sends them. Observations are only a
// refinement, so an account that picks no more loses them: each entry is
// dropped after PENDING_TTL_MS, and at most MAX_ACCOUNTS are kept in all.
const MAX_PENDING_COSTS = 20;
const MAX_ACCOUNTS = 1_000;
const PENDING_TTL_MS = 60 * 60_000;
const pendingCosts = new Map<string, { costs: TurnCost[]; at: number }>();

function evictPending(now: number): void {
  // Oldest first: an entry is re-inserted on each change.
  for (const [account_id, entry] of pendingCosts) {
    if (pendingCosts.size <= MAX_ACCOUNTS && now - entry.at < PENDING_TTL_MS)
      break;
    pendingCosts.delete(account_id);
  }
}

function setPending(account_id: string, costs: TurnCost[], now: number) {
  pendingCosts.delete(account_id);
  pendingCosts.set(account_id, {
    costs: costs.slice(-MAX_PENDING_COSTS),
    at: now,
  });
  evictPending(now);
}

export function takeTurnCosts(
  account_id: string,
  now = Date.now(),
): TurnCost[] | undefined {
  evictPending(now);
  const entry = pendingCosts.get(account_id);
  pendingCosts.delete(account_id);
  return entry?.costs;
}

export function restoreTurnCosts(
  account_id: string,
  costs: TurnCost[],
  now = Date.now(),
): void {
  setPending(
    account_id,
    [...costs, ...(pendingCosts.get(account_id)?.costs ?? [])],
    now,
  );
}

/** For tests: how many accounts have observations waiting. */
export function pendingTurnCostAccounts(now = Date.now()): number {
  evictPending(now);
  return pendingCosts.size;
}

/** For tests: how many turns are being measured. */
export function measuredTurns(): number {
  return turns.size;
}

export function resetClaudePoolUsage(): void {
  pendingCosts.clear();
  turns.clear();
}

// The 5-hour utilization Claude reports with each response, first and last
// of the turn, on the same window.
type TurnUsage = {
  account_id: string;
  started: number;
  credential_id: string;
  first?: { utilization: number; resets_at: number };
  last?: { utilization: number; resets_at: number };
};
const turns = new Map<string, TurnUsage>();
const MAX_TURNS = 10_000;
// A turn that never ended (its worker died) is dropped after this long.
const TURN_TTL_MS = 24 * 60 * 60_000;

function conversationKey(c: {
  projectId: string;
  path: string;
  threadId: string;
}) {
  return JSON.stringify([c.projectId, c.path, c.threadId]);
}

/** An Auto turn starts on a subscription: measure what it uses. */
export function beginClaudePoolTurnUsage(
  request: AcpRequest,
  now = Date.now(),
): void {
  const credential = request.harness_credential;
  if (
    !request.harness_pool ||
    credential?.mode !== "account-subscription" ||
    !request.chat?.path ||
    !request.chat.thread_id
  )
    return;
  const key = conversationKey({
    projectId: request.project_id,
    path: request.chat.path,
    threadId: request.chat.thread_id,
  });
  turns.delete(key);
  // Oldest first: drop turns that never ended, and keep the total bounded.
  for (const [old, turn] of turns) {
    if (turns.size < MAX_TURNS && now - turn.started < TURN_TTL_MS) break;
    turns.delete(old);
  }
  turns.set(key, {
    account_id: request.account_id,
    credential_id: credential.credentialId,
    started: now,
  });
}

/** A rate-limit report from a running harness. */
export function noteClaudePoolRateLimit(
  conversation: { projectId: string; path: string; threadId: string },
  credentialId: string | undefined,
  info: unknown,
): void {
  const turn = turns.get(conversationKey(conversation));
  if (!turn || turn.credential_id !== credentialId) return;
  const reading = claudeRateLimitSnapshot(info)?.windows.five_hour;
  if (!reading) return;
  if (!turn.first || turn.first.resets_at !== reading.resets_at)
    turn.first = reading;
  turn.last = reading;
}

/** The turn ended: queue what it used for the account's next pick. Only
 * reports from the same 5-hour window count. Rough: other turns on the same
 * subscription meanwhile are included, and the first response's own usage
 * is not. */
export function endClaudePoolTurnUsage(
  request: AcpRequest,
  now = Date.now(),
): void {
  if (!request.chat?.path || !request.chat.thread_id) return;
  const key = conversationKey({
    projectId: request.project_id,
    path: request.chat.path,
    threadId: request.chat.thread_id,
  });
  const turn = turns.get(key);
  turns.delete(key);
  if (!turn?.first || !turn.last) return;
  const cost = turn.last.utilization - turn.first.utilization;
  if (!(cost >= 0) || cost > 1) return;
  setPending(
    turn.account_id,
    [
      ...(pendingCosts.get(turn.account_id)?.costs ?? []),
      { credential_id: turn.credential_id, cost },
    ],
    now,
  );
}
