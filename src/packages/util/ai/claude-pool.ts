/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Auto (the subscription pool): which of an account's Claude subscriptions
// pays for the next turn, from the limits Claude last reported for each.
// Utilization is a fraction of a window's limit (1 = reached), as stored in
// the claude_usage credential metadata.

import {
  CLAUDE_USAGE_METADATA_KEY,
  parseClaudeRateLimitSnapshot,
  type ClaudeRateLimitSnapshot,
} from "./claude-usage";

/** Credential metadata: true when the owner took it out of the pool. */
export const CLAUDE_POOL_EXCLUDED_METADATA_KEY = "claude_pool_excluded";
/** Credential metadata: { until: ISO time } after a turn hit its limit. */
export const CLAUDE_POOL_LIMITED_METADATA_KEY = "claude_pool_limited";
/** Credential metadata: { samples: number[] }, recent per-turn 5-hour usage. */
export const CLAUDE_TURN_COSTS_METADATA_KEY = "claude_turn_costs";
/** Credential metadata: turns running on it now, by an opaque turn key:
 * { [turn]: { amount, expires } } (expires in ms). */
export const CLAUDE_POOL_RESERVATIONS_METADATA_KEY = "claude_pool_reservations";
const MAX_RESERVATIONS = 100;

const HOUR_MS = 3600_000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;

export const MAX_TURN_COST_SAMPLES = 50;
// Before there is enough data: a typical turn, and a heavy one.
export const DEFAULT_TURN_COST = 0.02;
export const DEFAULT_HEAVY_TURN_COST = 0.1;
const MIN_TURN_COST_SAMPLES = 5;
const MAX_TURN_COST = 0.5;
// Keep the thread's subscription unless another scores this much better:
// moving makes the next turn reread the whole conversation uncached.
const STICKY_FACTOR = 1.5;
// Running turns count against a subscription for at most this long.
export const CLAUDE_POOL_RESERVATION_MS = 10 * 60_000;

function isSample(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

/** Revalidate stored per-turn samples. */
export function parseTurnCostSamples(value: unknown): number[] {
  const samples = (value as { samples?: unknown } | undefined)?.samples;
  if (!Array.isArray(samples)) return [];
  return samples.filter(isSample).slice(-MAX_TURN_COST_SAMPLES);
}

/** The stored value after adding new samples (the newest are kept). */
export function appendTurnCostSamples(
  value: unknown,
  add: number[],
): { samples: number[] } {
  return {
    samples: [...parseTurnCostSamples(value), ...add.filter(isSample)].slice(
      -MAX_TURN_COST_SAMPLES,
    ),
  };
}

export type ClaudePoolReservations = Record<
  string,
  { amount: number; expires: number }
>;

/** The stored reservations still in effect (expired and invalid dropped). */
export function parseClaudePoolReservations(
  value: unknown,
  now = Date.now(),
): ClaudePoolReservations {
  const result: ClaudePoolReservations = {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    return result;
  const entries = Object.entries(value as Record<string, any>)
    .filter(
      ([key, r]) =>
        /^[a-f0-9]{1,64}$/.test(key) &&
        isSample(r?.amount) &&
        typeof r?.expires === "number" &&
        r.expires > now &&
        r.expires <= now + 24 * HOUR_MS,
    )
    .sort(([, a], [, b]) => b.expires - a.expires)
    .slice(0, MAX_RESERVATIONS);
  for (const [key, r] of entries)
    result[key] = { amount: r.amount, expires: r.expires };
  return result;
}

export function claudePoolReservedAmount(
  reservations: ClaudePoolReservations,
): number {
  return Object.values(reservations).reduce((sum, r) => sum + r.amount, 0);
}

export interface ClaudeTurnCostEstimate {
  /** Average share of a 5-hour limit one turn uses: what a turn reserves. */
  typical: number;
  /** 95th percentile: a subscription is used only if such a turn fits. */
  heavy: number;
  samples: number;
}

/**
 * The 5-hour share of a typical and a heavy turn, from observed turns. With
 * too few observations, defaults (raised to the largest turn seen).
 */
export function claudeTurnCostEstimate(
  samples: number[],
): ClaudeTurnCostEstimate {
  const valid = samples.filter(isSample);
  const clamp = (x: number) => Math.min(MAX_TURN_COST, Math.max(0.005, x));
  if (valid.length < MIN_TURN_COST_SAMPLES) {
    return {
      typical: DEFAULT_TURN_COST,
      heavy: clamp(Math.max(DEFAULT_HEAVY_TURN_COST, ...valid)),
      samples: valid.length,
    };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, x) => sum + x, 0) / sorted.length;
  // Nearest-rank percentile.
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
  const typical = clamp(mean);
  return {
    typical,
    heavy: Math.max(typical, clamp(p95)),
    samples: valid.length,
  };
}

export interface ClaudePoolMember {
  credential_id: string;
  usage?: ClaudeRateLimitSnapshot;
  /** A turn hit this subscription's limit; unusable until then (ms). */
  limited_until?: number;
  /** Usage reserved by turns running on it now. */
  reserved?: number;
}

/** A member as stored on its credential. */
export function claudePoolMemberFromMetadata(
  credential_id: string,
  metadata: Record<string, unknown> | null | undefined,
  now = Date.now(),
): ClaudePoolMember {
  const usage = parseClaudeRateLimitSnapshot(
    metadata?.[CLAUDE_USAGE_METADATA_KEY],
    now,
  );
  const limited = metadata?.[CLAUDE_POOL_LIMITED_METADATA_KEY] as
    | { until?: unknown }
    | undefined;
  const until =
    typeof limited?.until === "string" ? Date.parse(limited.until) : NaN;
  return {
    credential_id,
    ...(usage ? { usage } : {}),
    ...(Number.isFinite(until) && until > now ? { limited_until: until } : {}),
  };
}

export interface ClaudePoolWindows {
  five: number;
  fiveResetsAt?: number;
  week: number;
  weekResetsAt?: number;
}

/**
 * Current utilization: a window whose reset has passed is at 0, known for
 * certain however old the report. A subscription never reported is unused.
 */
export function claudePoolWindows(
  member: ClaudePoolMember,
  now = Date.now(),
): ClaudePoolWindows {
  const reading = (key: "five_hour" | "seven_day") => {
    const window = member.usage?.windows[key];
    if (!window) return { utilization: 0 };
    const resetsAt = window.resets_at * 1000;
    return resetsAt <= now
      ? { utilization: 0 }
      : { utilization: window.utilization, resetsAt };
  };
  const five = reading("five_hour");
  const week = reading("seven_day");
  return {
    five: five.utilization,
    ...(five.resetsAt ? { fiveResetsAt: five.resetsAt } : {}),
    week: week.utilization,
    ...(week.resetsAt ? { weekResetsAt: week.resetsAt } : {}),
  };
}

/** When the member could take a heavy turn (now if it can). */
export function claudePoolAvailableAt(
  member: ClaudePoolMember,
  cost: ClaudeTurnCostEstimate,
  now = Date.now(),
): number {
  const w = claudePoolWindows(member, now);
  let at = now;
  if (member.limited_until && member.limited_until > now)
    at = Math.max(at, member.limited_until);
  if (w.week + cost.typical >= 1)
    at = Math.max(at, w.weekResetsAt ?? now + WEEK_MS);
  if (w.five + cost.heavy > 1)
    at = Math.max(at, w.fiveResetsAt ?? now + FIVE_HOURS_MS);
  else if (w.five + (member.reserved ?? 0) + cost.heavy > 1)
    // Only running turns are in the way; they end or expire soon.
    at = Math.max(at, now + CLAUDE_POOL_RESERVATION_MS);
  return at;
}

/**
 * The weekly capacity that would otherwise expire unused, per hour until the
 * week resets, weighted by 5-hour headroom. Higher is better.
 */
export function claudePoolScore(
  member: ClaudePoolMember,
  now = Date.now(),
): number {
  const w = claudePoolWindows(member, now);
  const untilReset = Math.max(HOUR_MS, (w.weekResetsAt ?? now + WEEK_MS) - now);
  return ((1 - w.week) / (untilReset / HOUR_MS)) * (1 - w.five);
}

export type ClaudePoolPick =
  | { credential_id: string }
  /** Nothing can take a turn now: the earliest time one can, and which one
   * (none if the pool is empty). */
  | { hold_until?: number; next_credential_id?: string };

/**
 * The subscription for the next turn: eligible if a heavy turn still fits
 * its 5-hour window and a typical one its week; the best scoring one, but
 * the thread's current one while it is eligible and not much worse.
 */
export function pickClaudePoolCredential({
  members,
  cost,
  current,
  now = Date.now(),
}: {
  members: ClaudePoolMember[];
  cost: ClaudeTurnCostEstimate;
  current?: string;
  now?: number;
}): ClaudePoolPick {
  if (members.length === 0) return {};
  const eligible = members
    .filter((member) => claudePoolAvailableAt(member, cost, now) <= now)
    .map((member) => ({ member, score: claudePoolScore(member, now) }));
  if (eligible.length === 0) {
    const next = members
      .map((member) => ({
        member,
        at: claudePoolAvailableAt(member, cost, now),
      }))
      .reduce((a, b) => (b.at < a.at ? b : a));
    return {
      hold_until: next.at,
      next_credential_id: next.member.credential_id,
    };
  }
  // Ties go to the earlier member, so the choice is deterministic.
  const best = eligible.reduce((a, b) => (b.score > a.score ? b : a));
  const kept = eligible.find((x) => x.member.credential_id === current);
  if (kept && !(best.score > STICKY_FACTOR * kept.score))
    return { credential_id: kept.member.credential_id };
  return { credential_id: best.member.credential_id };
}

export interface ClaudePoolForecast {
  members: number;
  /** Weekly limits left, summed (1 = one subscription's whole week). */
  remaining: number;
  /** Weekly limits used per hour, at the rate of each current week. */
  ratePerHour: number;
  /** When every subscription would be at its weekly limit at that rate;
   * absent if not within a week. */
  runsOutAt?: number;
}

// A week's rate means little before this much of it has passed.
const MIN_RATE_ELAPSED_MS = 12 * HOUR_MS;

/**
 * When the pool runs out at the recent rate: turns spend the capacity that
 * resets soonest first (as Auto does), and each subscription is full again
 * when its week resets. A linear estimate.
 */
export function claudePoolForecast(
  members: ClaudePoolMember[],
  now = Date.now(),
): ClaudePoolForecast {
  let ratePerHour = 0;
  const state = members.map((member) => {
    const w = claudePoolWindows(member, now);
    const week = member.usage?.windows.seven_day;
    if (w.weekResetsAt && week) {
      const observed = Date.parse(member.usage!.observed_at);
      const elapsed = observed - (w.weekResetsAt - WEEK_MS);
      ratePerHour +=
        week.utilization / (Math.max(MIN_RATE_ELAPSED_MS, elapsed) / HOUR_MS);
    }
    return { left: 1 - w.week, resetsAt: w.weekResetsAt };
  });
  const remaining = state.reduce((sum, s) => sum + s.left, 0);
  const result: ClaudePoolForecast = {
    members: members.length,
    remaining,
    ratePerHour,
  };
  if (!(ratePerHour > 0) || members.length === 0) return result;
  const rate = ratePerHour / HOUR_MS;
  const horizon = now + WEEK_MS;
  let t = now;
  while (t < horizon) {
    const open = state
      .filter((s) => s.left > 1e-9)
      .sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))[0];
    const nextReset = Math.min(
      ...state
        .filter((s) => s.resetsAt != null && s.left < 1)
        .map((s) => s.resetsAt!),
    );
    if (!open) {
      result.runsOutAt = t;
      return result;
    }
    const exhaustAt = t + open.left / rate;
    const next = Math.min(exhaustAt, nextReset, horizon);
    open.left = Math.max(0, open.left - (next - t) * rate);
    t = next;
    for (const s of state) {
      if (s.resetsAt != null && s.resetsAt <= t) {
        s.left = 1;
        s.resetsAt += WEEK_MS;
      }
    }
  }
  return result;
}
