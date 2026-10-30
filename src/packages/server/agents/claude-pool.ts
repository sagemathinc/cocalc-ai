/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Auto (the Claude subscription pool), on the account's home bay, where its
// credentials and their reported limits live. Each turn of an Auto agent asks
// here which subscription to use; the pick reserves part of that
// subscription's 5-hour window for the turn.

import { requireUuid } from "@cocalc/conat/agents/protocol";
import type {
  ClaudePoolPickRequest,
  ClaudePoolPickResult,
} from "@cocalc/conat/inter-bay/agent-payment-selections";
import {
  CLAUDE_POOL_EXCLUDED_METADATA_KEY,
  CLAUDE_POOL_LIMITED_METADATA_KEY,
  CLAUDE_POOL_RESERVATION_MS,
  CLAUDE_TURN_COSTS_METADATA_KEY,
  appendTurnCostSamples,
  claudePoolMemberFromMetadata,
  claudeTurnCostEstimate,
  parseTurnCostSamples,
  pickClaudePoolCredential,
} from "@cocalc/util/ai/claude-pool";
import {
  ANTHROPIC_API_PROVIDER,
  CLAUDE_SUBSCRIPTION_KIND,
} from "@cocalc/util/ai/external-credential-profiles";
import {
  agentPaymentTargetKey,
  validateAgentPaymentTarget,
} from "@cocalc/util/ai/agent-payment-selection";
import {
  listExternalCredentials,
  setExternalCredentialMetadataValueById,
} from "@cocalc/server/external-credentials/store";

const HOUR_MS = 3600_000;
// A limit without a reset time: try that subscription again after this long.
const DEFAULT_LIMITED_MS = 5 * HOUR_MS;
const MAX_TURN_COSTS = 20;

interface PoolCredential {
  id: string;
  metadata: Record<string, any> | null;
}

export interface ClaudePoolStore {
  list(account_id: string): Promise<PoolCredential[]>;
  setMetadata(opts: {
    account_id: string;
    id: string;
    key: string;
    value: unknown;
  }): Promise<boolean>;
}

const selector = (owner_account_id: string) => ({
  provider: ANTHROPIC_API_PROVIDER,
  kind: CLAUDE_SUBSCRIPTION_KIND,
  scope: "account" as const,
  owner_account_id,
});

const defaultStore: ClaudePoolStore = {
  async list(account_id) {
    return await listExternalCredentials(selector(account_id));
  },
  async setMetadata({ account_id, id, key, value }) {
    return await setExternalCredentialMetadataValueById({
      id,
      selector: selector(account_id),
      key,
      value,
    });
  },
};

let store = defaultStore;

/** Tests only. */
export function setClaudePoolStoreForTests(next?: ClaudePoolStore) {
  store = next ?? defaultStore;
  reservations.clear();
  locks.clear();
}

// Turns running now, by account and conversation: the share of a 5-hour
// window each is expected to use. In this hub process only, and kept for at
// most CLAUDE_POOL_RESERVATION_MS: a heuristic that keeps simultaneous turns
// from all landing on the same subscription, not an accounting.
const reservations = new Map<
  string,
  Map<string, { credential_id: string; amount: number; expires: number }>
>();

function reservedBy(account_id: string, now: number): Map<string, number> {
  const mine = reservations.get(account_id);
  const total = new Map<string, number>();
  if (!mine) return total;
  for (const [key, r] of mine) {
    if (r.expires <= now) {
      mine.delete(key);
      continue;
    }
    total.set(r.credential_id, (total.get(r.credential_id) ?? 0) + r.amount);
  }
  if (mine.size === 0) reservations.delete(account_id);
  return total;
}

// One pick at a time per account, so simultaneous turns see each other's
// reservations.
const locks = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  locks.set(key, settled);
  try {
    return await run;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
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

export async function pickClaudePool(
  opts: { account_id: string } & ClaudePoolPickRequest,
  now = () => Date.now(),
): Promise<ClaudePoolPickResult> {
  const { account_id } = opts;
  requireUuid(account_id, "account_id");
  const target = validateAgentPaymentTarget(opts.target);
  const turn = agentPaymentTargetKey(target);
  return await serialized(account_id, async () => {
    const rows = await store.list(account_id);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const t = now();

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
      const row = byId.get(limited.credential_id)!;
      await store.setMetadata({
        account_id,
        id: row.id,
        key: CLAUDE_POOL_LIMITED_METADATA_KEY,
        value: { until },
      });
      row.metadata = {
        ...row.metadata,
        [CLAUDE_POOL_LIMITED_METADATA_KEY]: { until },
      };
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
      const row = byId.get(id)!;
      const value = appendTurnCostSamples(
        row.metadata?.[CLAUDE_TURN_COSTS_METADATA_KEY],
        add,
      );
      await store.setMetadata({
        account_id,
        id,
        key: CLAUDE_TURN_COSTS_METADATA_KEY,
        value,
      });
      row.metadata = {
        ...row.metadata,
        [CLAUDE_TURN_COSTS_METADATA_KEY]: value,
      };
    }

    const pool = claudePoolCredentials(rows);
    const current_label =
      opts.current_credential_id != null
        ? label(byId.get(opts.current_credential_id))
        : undefined;
    if (pool.length === 0) return { empty: true };
    // This turn replaces the conversation's previous reservation.
    reservations.get(account_id)?.delete(turn);
    const reserved = reservedBy(account_id, t);
    const cost = claudeTurnCostEstimate(
      pool.flatMap((row) =>
        parseTurnCostSamples(row.metadata?.[CLAUDE_TURN_COSTS_METADATA_KEY]),
      ),
    );
    const members = pool.map((row) => ({
      ...claudePoolMemberFromMetadata(row.id, row.metadata, t),
      reserved: reserved.get(row.id) ?? 0,
    }));
    const pick = pickClaudePoolCredential({
      members,
      cost,
      current: opts.current_credential_id,
      now: t,
    });
    if (!("credential_id" in pick)) {
      return {
        ...(pick.hold_until != null
          ? { hold_until: new Date(pick.hold_until).toISOString() }
          : {}),
        ...(current_label ? { current_label } : {}),
      };
    }
    let mine = reservations.get(account_id);
    if (!mine) reservations.set(account_id, (mine = new Map()));
    mine.set(turn, {
      credential_id: pick.credential_id,
      amount: cost.typical,
      expires: t + CLAUDE_POOL_RESERVATION_MS,
    });
    const picked = label(byId.get(pick.credential_id));
    return {
      credential_id: pick.credential_id,
      ...(picked ? { label: picked } : {}),
      ...(current_label ? { current_label } : {}),
    };
  });
}
