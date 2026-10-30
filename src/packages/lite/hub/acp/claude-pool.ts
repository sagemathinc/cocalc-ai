/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Auto (the Claude subscription pool) on the host: each turn of an Auto
// agent runs on the subscription the account's home bay picks for it, and a
// turn that reaches a limit continues on another one.

import type { AcpRequest, AcpStreamEvent } from "@cocalc/conat/ai/acp/types";
import type { TurnFailure } from "@cocalc/conat/ai/acp/turn-outcome";
import type {
  ClaudePoolPickRequest,
  ClaudePoolPickResult,
} from "@cocalc/conat/inter-bay/agent-payment-selections";
import { isValidUUID } from "@cocalc/util/misc";
import type { AcpHarnessCredential } from "@cocalc/util/ai/runtime";
import { hubApi } from "../api";
import {
  resetClaudePoolUsage,
  restoreTurnCosts,
  takeTurnCosts,
} from "./claude-pool-usage";

export {
  beginClaudePoolTurnUsage,
  endClaudePoolTurnUsage,
} from "./claude-pool-usage";

export type ClaudePoolPicker = (
  opts: { account_id: string } & ClaudePoolPickRequest,
) => Promise<ClaudePoolPickResult>;

const defaultPicker: ClaudePoolPicker = async (opts) =>
  await hubApi.agent.pickClaudePoolSubscription(opts);

let picker = defaultPicker;

export function setClaudePoolPicker(next?: ClaudePoolPicker): void {
  picker = next ?? defaultPicker;
  resetClaudePoolUsage();
}

/** The Auto marker an admitted request carries (host-set, never sent). */
export type ClaudePoolMarker = NonNullable<AcpRequest["harness_pool"]>;

export class ClaudePoolEmptyError extends Error {
  constructor() {
    super(
      "Auto has no Claude subscription to use. Connect a Claude subscription, or add one to Auto, in this agent's payment settings.",
    );
  }
}

function target(request: AcpRequest) {
  return {
    project_id: request.chat?.project_id ?? request.project_id,
    thread_id: request.chat!.thread_id!,
  };
}

export function poolCredential(
  credential_id: string,
  pool: ClaudePoolMarker,
): AcpHarnessCredential {
  return {
    version: 1,
    provider: "anthropic",
    mode: "account-subscription",
    credentialId: credential_id,
    ...(pool.claude_ai_connectors === false
      ? { claudeAiConnectors: false }
      : {}),
  };
}

async function pick(
  request: AcpRequest,
  extra: Pick<ClaudePoolPickRequest, "limited"> = {},
): Promise<ClaudePoolPickResult> {
  const turn_costs = takeTurnCosts(request.account_id);
  const current =
    request.harness_credential?.mode === "account-subscription"
      ? request.harness_credential.credentialId
      : undefined;
  try {
    return await picker({
      account_id: request.account_id,
      target: target(request),
      ...(current ? { current_credential_id: current } : {}),
      ...(turn_costs?.length ? { turn_costs } : {}),
      ...extra,
    });
  } catch (err) {
    // Keep the observations for the next pick.
    if (turn_costs?.length) restoreTurnCosts(request.account_id, turn_costs);
    throw err;
  }
}

/**
 * Admission of an Auto turn: a subscription to admit it with. Dispatch picks
 * again, since the turn may wait in the queue. Throws when the pool is empty.
 */
export async function admitClaudePoolTurn<T extends AcpRequest>(
  request: T,
  pool: ClaudePoolMarker,
): Promise<T> {
  const result = await pick({ ...request, harness_pool: pool });
  if (result.empty) throw new ClaudePoolEmptyError();
  // Nothing has room now: admit on the current subscription, else the one
  // with room first; dispatch then holds the turn until one has.
  const credential_id =
    result.credential_id ??
    (request.harness_credential?.mode === "account-subscription"
      ? request.harness_credential.credentialId
      : undefined) ??
    result.next_credential_id;
  if (!credential_id) throw new ClaudePoolEmptyError();
  return {
    ...request,
    harness_pool: pool,
    harness_credential: poolCredential(credential_id, pool),
  };
}

export interface ClaudePoolDispatch<T> {
  request: T;
  /** Shown in the turn's activity: the subscription it runs on. */
  event?: Extract<AcpStreamEvent, { type: "payment" }>;
  /** Nothing has room: fail the turn as this limit, so it is held. */
  hold?: TurnFailure;
}

/**
 * Dispatch of an Auto turn: the subscription it runs on now. If the pick
 * fails, the turn runs on the one it was admitted with.
 */
export async function dispatchClaudePoolTurn<T extends AcpRequest>(
  request: T,
): Promise<ClaudePoolDispatch<T>> {
  const pool = request.harness_pool;
  if (!pool || !request.chat?.thread_id) return { request };
  let result: ClaudePoolPickResult;
  try {
    result = await pick(request);
  } catch {
    return { request };
  }
  if (result.empty) throw new ClaudePoolEmptyError();
  if (!result.credential_id) {
    const resets_at = result.hold_until
      ? Date.parse(result.hold_until)
      : undefined;
    return {
      request,
      hold: {
        kind: "limit",
        scope: "credential",
        ...(resets_at && Number.isFinite(resets_at) ? { resets_at } : {}),
      },
    };
  }
  const previous =
    request.harness_credential?.mode === "account-subscription"
      ? request.harness_credential.credentialId
      : undefined;
  const moved = previous != null && previous !== result.credential_id;
  return {
    request: {
      ...request,
      harness_credential: poolCredential(result.credential_id, pool),
    },
    event: {
      type: "payment",
      mode: "auto",
      ...(result.label ? { label: result.label } : {}),
      ...(moved
        ? {
            moved: true,
            ...(result.current_label
              ? { previous_label: result.current_label }
              : {}),
          }
        : {}),
    },
  };
}

/**
 * A turn of an Auto agent reached a subscription's limit: mark it, and pick
 * another to continue on now (or learn when one has room). Undefined when
 * this is not an Auto turn or the home bay cannot answer: then the turn is
 * held until that subscription resets, as for a pinned one.
 */
export async function claudePoolAfterLimit(
  request: AcpRequest,
  failure: TurnFailure,
): Promise<ClaudePoolPickResult | undefined> {
  if (!request.harness_pool || failure.kind !== "limit") return;
  if (!request.chat?.thread_id) return;
  const limited =
    failure.credential_id && isValidUUID(failure.credential_id)
      ? {
          credential_id: failure.credential_id,
          ...(failure.resets_at
            ? { resets_at: Math.round(failure.resets_at / 1000) }
            : {}),
        }
      : undefined;
  try {
    const result = await pick(request, limited ? { limited } : {});
    return result.empty ? undefined : result;
  } catch {
    return;
  }
}
