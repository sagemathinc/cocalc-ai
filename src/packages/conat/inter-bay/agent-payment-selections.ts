/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Account-home service for agent payment selections. Callers have already
// authenticated the account (or a host acting for it) on their own bay; the
// home bay rechecks that it is still the account's home.

import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type {
  AgentPaymentDefaults,
  AgentPaymentProvider,
  AgentPaymentSelection,
  AgentPaymentSelectionRecord,
  AgentPaymentTarget,
} from "@cocalc/util/ai/agent-payment-selection";

export interface AgentPaymentHomeRequest {
  account_id: string;
  home_bay_id: string;
}

export interface AgentPaymentSelectionsResult {
  selections: AgentPaymentSelectionRecord[];
  defaults: AgentPaymentDefaults;
}

export interface SetAgentPaymentSelectionsRequest {
  /** Agents to change, with an optional name for listings. */
  targets?: Array<AgentPaymentTarget & { title?: string }>;
  /** Account defaults to change. */
  defaults?: AgentPaymentProvider[];
  /** null clears, so the agent follows the account default. */
  selection: AgentPaymentSelection | null;
  /** With a null selection: clear only this provider's choice. */
  provider?: AgentPaymentProvider;
  /** Migration: only fill agents that have no record yet. */
  only_if_absent?: boolean;
}

export interface ResolvedAgentPaymentSelection {
  selection?: AgentPaymentSelection;
  default?: AgentPaymentSelection;
}

/** Auto: pick one of the account's pooled Claude subscriptions for a turn. */
export interface ClaudePoolPickRequest {
  /** The conversation the turn is in; a later pick for it replaces this
   * turn's reservation. */
  target: AgentPaymentTarget;
  /** The conversation's subscription now: kept while it is eligible. */
  current_credential_id?: string;
  /** A turn on this subscription just hit its limit (resets_at in seconds,
   * as Claude reports it). */
  limited?: { credential_id: string; resets_at?: number };
  /** Per-turn 5-hour usage observed since the last pick (fractions). */
  turn_costs?: Array<{ credential_id: string; cost: number }>;
}

export interface ClaudePoolPickResult {
  credential_id?: string;
  /** Display names of the picked and the current subscription. */
  label?: string;
  current_label?: string;
  /** Nothing in the pool can take a turn now: when one can (ISO time). */
  hold_until?: string;
  /** The pool has no subscription. */
  empty?: true;
}

export interface AgentPaymentSelectionsApi {
  get(
    opts: AgentPaymentHomeRequest & {
      targets: AgentPaymentTarget[];
      touch?: boolean;
    },
  ): Promise<AgentPaymentSelectionsResult>;
  list(
    opts: AgentPaymentHomeRequest & {
      provider?: AgentPaymentProvider;
      limit?: number;
    },
  ): Promise<AgentPaymentSelectionsResult>;
  set(
    opts: AgentPaymentHomeRequest & SetAgentPaymentSelectionsRequest,
  ): Promise<{ updated: number }>;
  copy(
    opts: AgentPaymentHomeRequest & {
      from: AgentPaymentTarget;
      to: AgentPaymentTarget;
    },
  ): Promise<{ copied: boolean }>;
  /** Selection used to admit one turn; records last use. */
  resolve(
    opts: AgentPaymentHomeRequest & {
      target: AgentPaymentTarget;
      provider: AgentPaymentProvider;
    },
  ): Promise<ResolvedAgentPaymentSelection>;
  /** Pick, and reserve for the turn, a pooled Claude subscription. */
  pickClaudePool(
    opts: AgentPaymentHomeRequest & ClaudePoolPickRequest,
  ): Promise<ClaudePoolPickResult>;
}

export function agentPaymentSelectionsSubject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw new Error("invalid bay_id");
  return `bay.${bay_id}.rpc.agent-payment-selections.v1`;
}

export function createAgentPaymentSelectionsClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): AgentPaymentSelectionsApi {
  return createServiceClient<AgentPaymentSelectionsApi>({
    service: "inter-bay-agent-payment-selections",
    subject: agentPaymentSelectionsSubject(bay_id),
    client,
    timeout: 15_000,
  });
}

export function createAgentPaymentSelectionsHandler({
  bay_id,
  impl,
  ...options
}: {
  bay_id: string;
  impl: AgentPaymentSelectionsApi;
} & Omit<Options, "handler" | "service" | "subject">) {
  return createServiceHandler<AgentPaymentSelectionsApi>({
    ...options,
    service: "inter-bay-agent-payment-selections",
    subject: agentPaymentSelectionsSubject(bay_id),
    impl,
  });
}
