/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// What is known about an account's AI subscriptions, for agents (and the
// CLI) to plan with: each Claude subscription's limits as Claude last
// reported them during a CoCalc turn, and Auto's view of the pool (who has
// room for a large turn, when one has room again, how long the weekly limits
// last at the recent rate). Only labels and numbers: never a credential.

import {
  CLAUDE_POOL_EXCLUDED_METADATA_KEY,
  CLAUDE_POOL_RESERVATIONS_METADATA_KEY,
  CLAUDE_TURN_COSTS_METADATA_KEY,
  claudePoolAvailableAt,
  claudePoolForecast,
  claudePoolMemberFromMetadata,
  claudePoolRecentRate,
  claudePoolWindows,
  claudePoolReservedAmount,
  claudeTurnCostEstimate,
  parseClaudePoolReservations,
  parseTurnCostSamples,
  type ClaudePoolMember,
} from "./claude-pool";
import {
  ANTHROPIC_API_PROVIDER,
  CLAUDE_SUBSCRIPTION_KIND,
} from "./external-credential-profiles";

export interface AiSubscriptionCredentialRow {
  id: string;
  provider: string;
  kind: string;
  scope?: string;
  metadata?: Record<string, any> | null;
  last_used?: Date | string | null;
  revoked?: Date | string | null;
}

export const CODEX_SUBSCRIPTION_CREDENTIAL_KIND =
  "codex-subscription-auth-json";

export interface AiSubscriptionWindow {
  /** Percent of this window's limit used, as Claude last reported. */
  used_percent: number;
  /** When it resets (ISO); a reset already passed means it is at 0 now. */
  resets_at?: string;
}

export interface ClaudeSubscriptionStatus {
  id: string;
  label?: string;
  /** Auto may use it (it is in the account's pool). */
  in_auto: boolean;
  /** When Claude last reported its usage (ISO), if ever. */
  observed_at?: string;
  five_hour?: AiSubscriptionWindow;
  week?: AiSubscriptionWindow;
  /** A turn reached its limit: Auto skips it until then (ISO). */
  limited_until?: string;
  /** Turns running on it now. */
  running_turns: number;
  /** Its weekly limit used per day recently (percent), from the readings
   * below; absent until they span a couple of hours. */
  week_percent_per_day?: number;
  /** Recent weekly readings (up to 48 hours, at most a dozen, oldest
   * first): how it has been used, not only where it is. */
  week_history?: { at: string; used_percent: number; resets_at: string }[];
  /** It could take a large turn now. */
  available_now: boolean;
  /** When it could, if not now (ISO). */
  available_at?: string;
  last_used?: string;
}

export interface AiSubscriptionStatus {
  checked_at: string;
  claude: {
    subscriptions: ClaudeSubscriptionStatus[];
    auto: {
      /** Subscriptions in the pool. */
      members: number;
      /** With room for a large turn now. */
      available_now: number;
      /** When one could, if none can now (ISO). */
      next_available_at?: string;
      /** Weekly limits left, summed (1 = one subscription's whole week). */
      weekly_limits_left: number;
      /** Weekly limits used per day at the recent rate. */
      weekly_limits_per_day: number;
      /** recent: measured over the last day; week: each week's average,
       * which overstates it (used until enough readings exist). */
      rate_from?: "recent" | "week";
      /** When every weekly limit would be reached at that rate (ISO); absent
       * if the limits last until they reset. */
      runs_out_at?: string;
      /** Share of a 5-hour window a typical and a large turn use (percent). */
      typical_turn_five_hour_percent: number;
      large_turn_five_hour_percent: number;
    };
  };
  codex: {
    subscriptions: {
      id: string;
      label?: string;
      email?: string;
      plan_type?: string;
      default?: boolean;
      last_used?: string;
    }[];
    note: string;
  };
}

// Undefined for a time a Date cannot represent (stored data may be odd):
// toISOString would throw.
const iso = (ms: number | undefined) => {
  if (ms == null) return undefined;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

const isoOf = (value: Date | string | null | undefined) => {
  if (value == null) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return iso(ms);
};

const text = (value: unknown, max = 200) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

const percent = (fraction: number) => Math.round(fraction * 1000) / 10;

const MAX_HISTORY_POINTS = 12;

function weekHistory(
  member: ClaudePoolMember,
  now: number,
): Pick<ClaudeSubscriptionStatus, "week_percent_per_day" | "week_history"> {
  // Only readings with representable times, none in the future.
  const readings = (member.history ?? []).filter(
    (r) => r.at <= now && iso(r.at) && iso(r.resets_at * 1000),
  );
  const rate = claudePoolRecentRate([{ ...member, history: readings }], now);
  // Evenly thinned, always keeping the newest.
  const step = Math.ceil(readings.length / MAX_HISTORY_POINTS);
  const kept = readings.filter(
    (_, i) => (readings.length - 1 - i) % step === 0,
  );
  return {
    ...(rate ? { week_percent_per_day: percent(rate.ratePerHour * 24) } : {}),
    ...(kept.length
      ? {
          week_history: kept.map((r) => ({
            at: iso(r.at)!,
            used_percent: percent(r.week),
            resets_at: iso(r.resets_at * 1000)!,
          })),
        }
      : {}),
  };
}

export function aiSubscriptionStatus(
  rows: AiSubscriptionCredentialRow[],
  now = Date.now(),
): AiSubscriptionStatus {
  // The account's own subscriptions, exactly as Auto selects them.
  const live = rows.filter((row) => !row.revoked && row.scope === "account");
  const claudeRows = live.filter(
    (row) =>
      row.provider === ANTHROPIC_API_PROVIDER &&
      row.kind === CLAUDE_SUBSCRIPTION_KIND,
  );
  const pool = claudeRows.filter(
    (row) => row.metadata?.[CLAUDE_POOL_EXCLUDED_METADATA_KEY] !== true,
  );
  const cost = claudeTurnCostEstimate(
    pool.flatMap((row) =>
      parseTurnCostSamples(row.metadata?.[CLAUDE_TURN_COSTS_METADATA_KEY]),
    ),
  );
  // As Auto sees them: running turns count against their subscription.
  const member = (row: AiSubscriptionCredentialRow) => {
    const reservations = parseClaudePoolReservations(
      row.metadata?.[CLAUDE_POOL_RESERVATIONS_METADATA_KEY],
      now,
    );
    return {
      ...claudePoolMemberFromMetadata(row.id, row.metadata, now),
      reserved: claudePoolReservedAmount(reservations),
      running: Object.keys(reservations).length,
    };
  };
  const subscriptions = claudeRows.map((row): ClaudeSubscriptionStatus => {
    const { running, ...m } = member(row);
    const windows = claudePoolWindows(m, now);
    const reported = m.usage?.windows;
    const availableAt = claudePoolAvailableAt(m, cost, now);
    const window = (
      present: boolean,
      used: number,
      resetsAt: number | undefined,
    ): AiSubscriptionWindow | undefined =>
      present
        ? {
            used_percent: percent(used),
            ...(resetsAt ? { resets_at: iso(resetsAt) } : {}),
          }
        : undefined;
    const five = window(
      !!reported?.five_hour,
      windows.five,
      windows.fiveResetsAt,
    );
    const week = window(
      !!reported?.seven_day,
      windows.week,
      windows.weekResetsAt,
    );
    return {
      id: row.id,
      ...(text(row.metadata?.label)
        ? { label: text(row.metadata?.label) }
        : {}),
      in_auto: row.metadata?.[CLAUDE_POOL_EXCLUDED_METADATA_KEY] !== true,
      ...(m.usage ? { observed_at: m.usage.observed_at } : {}),
      ...(five ? { five_hour: five } : {}),
      ...(week ? { week } : {}),
      ...(m.limited_until ? { limited_until: iso(m.limited_until) } : {}),
      running_turns: running,
      ...weekHistory(m, now),
      available_now: availableAt <= now,
      ...(availableAt > now ? { available_at: iso(availableAt) } : {}),
      ...(isoOf(row.last_used) ? { last_used: isoOf(row.last_used) } : {}),
    };
  });
  const members = pool.map((row) => {
    const { running: _, ...m } = member(row);
    return m;
  });
  const forecast = claudePoolForecast(members, now);
  const times = members.map((m) => claudePoolAvailableAt(m, cost, now));
  const availableNow = times.filter((t) => t <= now).length;
  return {
    checked_at: new Date(now).toISOString(),
    claude: {
      subscriptions,
      auto: {
        members: members.length,
        available_now: availableNow,
        ...(availableNow === 0 && times.length > 0
          ? { next_available_at: iso(Math.min(...times)) }
          : {}),
        weekly_limits_left: Math.round(forecast.remaining * 100) / 100,
        weekly_limits_per_day:
          Math.round(forecast.ratePerHour * 24 * 100) / 100,
        ...(forecast.rateFrom ? { rate_from: forecast.rateFrom } : {}),
        ...(forecast.runsOutAt ? { runs_out_at: iso(forecast.runsOutAt) } : {}),
        typical_turn_five_hour_percent: percent(cost.typical),
        large_turn_five_hour_percent: percent(cost.heavy),
      },
    },
    codex: {
      subscriptions: live
        .filter(
          (row) =>
            row.provider === "openai" &&
            row.kind === CODEX_SUBSCRIPTION_CREDENTIAL_KIND,
        )
        .map((row) => ({
          id: row.id,
          ...(text(row.metadata?.label)
            ? { label: text(row.metadata?.label) }
            : {}),
          ...(text(row.metadata?.email)
            ? { email: text(row.metadata?.email) }
            : {}),
          ...(text(row.metadata?.plan_type)
            ? { plan_type: text(row.metadata?.plan_type) }
            : {}),
          ...(row.metadata?.cocalc_default === true ? { default: true } : {}),
          ...(isoOf(row.last_used) ? { last_used: isoOf(row.last_used) } : {}),
        })),
      note: "CoCalc does not store live ChatGPT Codex usage: Codex reports its own limits during a turn.",
    },
  };
}
