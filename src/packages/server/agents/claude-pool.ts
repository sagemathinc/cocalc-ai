/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Auto (the Claude subscription pool), on the account's home bay, where its
// credentials and their reported limits live. Each turn of an Auto agent asks
// here which subscription to use; the pick reserves part of that
// subscription's 5-hour window for the turn.
//
// Every pick for an account runs in one transaction holding a per-account
// lock, and reservations are stored on the credentials, so picks in any hub
// process of the bay see each other. Nothing is kept in memory.

import { createHash } from "node:crypto";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type {
  ClaudePoolPickRequest,
  ClaudePoolPickResult,
} from "@cocalc/conat/inter-bay/agent-payment-selections";
import {
  CLAUDE_POOL_EXCLUDED_METADATA_KEY,
  CLAUDE_POOL_LIMITED_METADATA_KEY,
  CLAUDE_POOL_RESERVATION_MS,
  CLAUDE_POOL_RESERVATIONS_METADATA_KEY,
  CLAUDE_TURN_COSTS_METADATA_KEY,
  appendTurnCostSamples,
  claudePoolMemberFromMetadata,
  claudePoolReservedAmount,
  claudeTurnCostEstimate,
  parseClaudePoolReservations,
  parseTurnCostSamples,
  pickClaudePoolCredential,
  type ClaudePoolReservations,
} from "@cocalc/util/ai/claude-pool";
import {
  ANTHROPIC_API_PROVIDER,
  CLAUDE_SUBSCRIPTION_KIND,
} from "@cocalc/util/ai/external-credential-profiles";
import {
  agentPaymentTargetKey,
  validateAgentPaymentTarget,
} from "@cocalc/util/ai/agent-payment-selection";
import { updateExternalCredentialMetadataLocked } from "@cocalc/server/external-credentials/store";

const HOUR_MS = 3600_000;
// A limit without a reset time: try that subscription again after this long.
const DEFAULT_LIMITED_MS = 5 * HOUR_MS;
const MAX_TURN_COSTS = 20;

interface PoolCredential {
  id: string;
  metadata: Record<string, any>;
}

type MetadataUpdate = { id: string; key: string; value: unknown };

export interface ClaudePoolStore {
  /** Serialized per account across the bay: read the account's Claude
   * subscriptions, then set the returned metadata values atomically. */
  locked<T>(
    account_id: string,
    fn: (
      rows: PoolCredential[],
    ) => Promise<{ result: T; updates: MetadataUpdate[] }>,
  ): Promise<T>;
}

const defaultStore: ClaudePoolStore = {
  async locked(account_id, fn) {
    return await updateExternalCredentialMetadataLocked({
      selector: {
        provider: ANTHROPIC_API_PROVIDER,
        kind: CLAUDE_SUBSCRIPTION_KIND,
        scope: "account",
        owner_account_id: account_id,
      },
      lock: "claude-pool",
      fn,
    });
  },
};

let store = defaultStore;

/** Tests only. */
export function setClaudePoolStoreForTests(next?: ClaudePoolStore) {
  store = next ?? defaultStore;
}

function label(row: PoolCredential | undefined): string | undefined {
  const value = row?.metadata?.label;
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 60)
    : undefined;
}

/** The account's pooled subscriptions: every connected one not excluded. */
export function claudePoolCredentials<T extends PoolCredential>(
  rows: T[],
): T[] {
  return rows.filter(
    (row) => row.metadata?.[CLAUDE_POOL_EXCLUDED_METADATA_KEY] !== true,
  );
}

// Opaque in credential metadata (which the owner's browser lists).
function turnKey(target: { project_id: string; thread_id: string }): string {
  return createHash("sha256")
    .update(agentPaymentTargetKey(target))
    .digest("hex")
    .slice(0, 32);
}

export async function pickClaudePool(
  opts: { account_id: string } & ClaudePoolPickRequest,
  now = () => Date.now(),
): Promise<ClaudePoolPickResult> {
  const { account_id } = opts;
  requireUuid(account_id, "account_id");
  const target = validateAgentPaymentTarget(opts.target);
  const turn = turnKey(target);
  return await store.locked(account_id, async (rows) => {
    const t = now();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const changed = new Map<string, Record<string, unknown>>();
    const set = (id: string, key: string, value: unknown) => {
      const row = byId.get(id)!;
      row.metadata = { ...row.metadata, [key]: value };
      changed.set(id, { ...(changed.get(id) ?? {}), [key]: value });
    };

    // A limit just reached: skip that subscription until it resets.
    const limited = opts.limited;
    if (limited && byId.has(limited.credential_id)) {
      const resets =
        typeof limited.resets_at === "number" &&
        Number.isFinite(limited.resets_at)
          ? limited.resets_at * 1000
          : t + DEFAULT_LIMITED_MS;
      const until = new Date(
        Math.min(t + 7 * 24 * HOUR_MS, Math.max(t + 60_000, resets)),
      ).toISOString();
      set(limited.credential_id, CLAUDE_POOL_LIMITED_METADATA_KEY, { until });
    }

    // Observed turns refine the cost estimate.
    const costs = new Map<string, number[]>();
    for (const entry of (opts.turn_costs ?? []).slice(0, MAX_TURN_COSTS)) {
      if (!byId.has(entry?.credential_id)) continue;
      costs.set(entry.credential_id, [
        ...(costs.get(entry.credential_id) ?? []),
        entry.cost,
      ]);
    }
    for (const [id, add] of costs) {
      const next = appendTurnCostSamples(
        byId.get(id)!.metadata?.[CLAUDE_TURN_COSTS_METADATA_KEY],
        add,
      );
      if (next.samples.length > 0)
        set(id, CLAUDE_TURN_COSTS_METADATA_KEY, next);
    }

    // Running turns, without this conversation's previous one (this turn
    // replaces it) and without expired ones.
    const reservations = new Map<string, ClaudePoolReservations>();
    for (const row of rows) {
      const stored = row.metadata?.[CLAUDE_POOL_RESERVATIONS_METADATA_KEY];
      const current = parseClaudePoolReservations(stored, t);
      delete current[turn];
      reservations.set(row.id, current);
      if (stored != null && JSON.stringify(stored) !== JSON.stringify(current))
        set(row.id, CLAUDE_POOL_RESERVATIONS_METADATA_KEY, current);
    }

    const pool = claudePoolCredentials(rows);
    const current_label =
      opts.current_credential_id != null
        ? label(byId.get(opts.current_credential_id))
        : undefined;
    const cost = claudeTurnCostEstimate(
      pool.flatMap((row) =>
        parseTurnCostSamples(row.metadata?.[CLAUDE_TURN_COSTS_METADATA_KEY]),
      ),
    );
    const members = pool.map((row) => ({
      ...claudePoolMemberFromMetadata(row.id, row.metadata, t),
      reserved: claudePoolReservedAmount(reservations.get(row.id) ?? {}),
    }));
    const pick =
      pool.length === 0
        ? undefined
        : pickClaudePoolCredential({
            members,
            cost,
            current: opts.current_credential_id,
            now: t,
          });
    let result: ClaudePoolPickResult;
    if (!pick) {
      result = { empty: true };
    } else if (!("credential_id" in pick)) {
      result = {
        ...(pick.hold_until != null
          ? { hold_until: new Date(pick.hold_until).toISOString() }
          : {}),
        ...(pick.next_credential_id
          ? { next_credential_id: pick.next_credential_id }
          : {}),
        ...(current_label ? { current_label } : {}),
      };
    } else {
      set(pick.credential_id, CLAUDE_POOL_RESERVATIONS_METADATA_KEY, {
        ...reservations.get(pick.credential_id),
        [turn]: {
          amount: cost.typical,
          expires: t + CLAUDE_POOL_RESERVATION_MS,
        },
      });
      const picked = label(byId.get(pick.credential_id));
      result = {
        credential_id: pick.credential_id,
        ...(picked ? { label: picked } : {}),
        ...(current_label ? { current_label } : {}),
      };
    }
    const updates: MetadataUpdate[] = [];
    for (const [id, values] of changed)
      for (const [key, value] of Object.entries(values))
        updates.push({ id, key, value });
    return { result, updates };
  });
}
