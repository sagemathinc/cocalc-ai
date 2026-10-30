/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// What each Auto turn uses of its subscription's 5-hour window, as Claude
// reports it during the turn; sent with the account's next pick, which
// estimates the cost of a turn from it.

import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import { claudeRateLimitSnapshot } from "@cocalc/util/ai/claude-usage";

const MAX_PENDING_COSTS = 20;
const pendingCosts = new Map<
  string,
  Array<{ credential_id: string; cost: number }>
>();

export function takeTurnCosts(account_id: string) {
  const costs = pendingCosts.get(account_id);
  pendingCosts.delete(account_id);
  return costs;
}

export function restoreTurnCosts(
  account_id: string,
  costs: Array<{ credential_id: string; cost: number }>,
): void {
  pendingCosts.set(
    account_id,
    [...costs, ...(pendingCosts.get(account_id) ?? [])].slice(
      -MAX_PENDING_COSTS,
    ),
  );
}

export function resetClaudePoolUsage(): void {
  pendingCosts.clear();
  turns.clear();
}

// The 5-hour utilization Claude reports with each response, first and last
// of the turn, on the same window.
type TurnUsage = {
  account_id: string;
  credential_id: string;
  first?: { utilization: number; resets_at: number };
  last?: { utilization: number; resets_at: number };
};
const turns = new Map<string, TurnUsage>();
const MAX_TURNS = 10_000;

function conversationKey(c: {
  projectId: string;
  path: string;
  threadId: string;
}) {
  return JSON.stringify([c.projectId, c.path, c.threadId]);
}

/** An Auto turn starts on a subscription: measure what it uses. */
export function beginClaudePoolTurnUsage(request: AcpRequest): void {
  const credential = request.harness_credential;
  if (
    !request.harness_pool ||
    credential?.mode !== "account-subscription" ||
    !request.chat?.path ||
    !request.chat.thread_id
  )
    return;
  if (turns.size >= MAX_TURNS) turns.clear();
  turns.set(
    conversationKey({
      projectId: request.project_id,
      path: request.chat.path,
      threadId: request.chat.thread_id,
    }),
    { account_id: request.account_id, credential_id: credential.credentialId },
  );
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
export function endClaudePoolTurnUsage(request: AcpRequest): void {
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
  const costs = pendingCosts.get(turn.account_id) ?? [];
  costs.push({ credential_id: turn.credential_id, cost });
  pendingCosts.set(turn.account_id, costs.slice(-MAX_PENDING_COSTS));
}
