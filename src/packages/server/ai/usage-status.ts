import getPool, { CacheTime } from "@cocalc/database/pool";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import {
  getActiveAccountUsageWindow,
  type AccountUsageWindow,
} from "@cocalc/server/membership/usage-windows";
import { AI_USAGE_UNITS_PER_DOLLAR } from "./usage-units";
import isValidAccount from "../accounts/is-valid-account";
import { ensureExactAIUsageSchema } from "./save-response";

export interface AIUsageWindowStatus {
  window: "5h" | "7d";
  used: number;
  limit?: number;
  remaining?: number;
  starts_at?: Date;
  resets_at?: Date;
  reset_at?: Date;
  reset_in?: string;
  site_funded_credits_microusd?: Record<string, number>;
}

export interface AIUsageStatus {
  units_per_dollar: number;
  windows: AIUsageWindowStatus[];
}

export interface AIUsageLimits {
  units_5h: number;
  units_7d: number;
}

export async function getAIUsageStatus({
  account_id,
  analytics_cookie,
  include_site_funded_credits = false,
}: {
  account_id?: string;
  analytics_cookie?: string;
  include_site_funded_credits?: boolean;
}): Promise<AIUsageStatus> {
  await ensureExactAIUsageSchema();
  if (account_id && !(await isValidAccount(account_id))) {
    throw Error(`invalid account_id ${account_id}`);
  }
  const limits = await getAIUsageLimits({ account_id });
  const windows: AIUsageWindowStatus[] = [];

  const window5h = await getUsageWindow({
    window: "5h",
    period: "5 hours",
    account_id,
    analytics_cookie,
    limit: limits.units_5h,
    cache: "short",
    include_site_funded_credits,
  });
  windows.push(window5h);

  const window7d = await getUsageWindow({
    window: "7d",
    period: "7 days",
    account_id,
    analytics_cookie,
    limit: limits.units_7d,
    cache: "short",
    include_site_funded_credits,
  });
  windows.push(window7d);

  return {
    units_per_dollar: AI_USAGE_UNITS_PER_DOLLAR,
    windows,
  };
}

async function getUsageWindow({
  window,
  period,
  account_id,
  analytics_cookie,
  limit,
  cache,
  include_site_funded_credits,
}: {
  window: AIUsageWindowStatus["window"];
  period: "5 hours" | "7 days";
  account_id?: string;
  analytics_cookie?: string;
  limit?: number;
  cache?: CacheTime;
  include_site_funded_credits?: boolean;
}): Promise<AIUsageWindowStatus> {
  const activeWindow = account_id
    ? await getActiveAccountUsageWindow({
        account_id,
        window,
      })
    : undefined;
  const fixedWindowUsage =
    account_id != null
      ? activeWindow
        ? await usageInFixedWindow({
            account_id,
            usageWindow: activeWindow,
            cache,
            include_site_funded_credits,
          })
        : { used: 0, site_funded_credits_microusd: {} }
      : undefined;
  const used = fixedWindowUsage
    ? fixedWindowUsage.used
    : await recentUsageUnits({ period, analytics_cookie, cache });
  const reset_at =
    activeWindow?.resets_at ??
    (account_id
      ? undefined
      : await getWindowResetAt({
          period,
          analytics_cookie,
        }));
  const remaining =
    limit != null && Number.isFinite(limit)
      ? Math.max(0, limit - used)
      : undefined;
  const reset_in = reset_at
    ? formatDuration(Math.max(0, reset_at.getTime() - Date.now()))
    : undefined;
  return {
    window,
    used,
    limit,
    remaining,
    starts_at: activeWindow?.starts_at,
    resets_at: activeWindow?.resets_at,
    reset_at,
    reset_in: reset_in && reset_in.length > 0 ? reset_in : undefined,
    site_funded_credits_microusd: include_site_funded_credits
      ? fixedWindowUsage?.site_funded_credits_microusd
      : undefined,
  };
}

async function usageInFixedWindow({
  account_id,
  usageWindow,
  cache,
  include_site_funded_credits,
}: {
  account_id: string;
  usageWindow: AccountUsageWindow;
  cache?: CacheTime;
  include_site_funded_credits?: boolean;
}): Promise<{
  used: number;
  site_funded_credits_microusd?: Record<string, number>;
}> {
  const pool = getPool(cache);
  if (include_site_funded_credits) {
    const { rows } = await pool.query(
      `WITH per_turn AS (
         SELECT funded_turn_id,
           SUM(COALESCE(
             cost_microusd * $4::numeric / 1000000,
             usage_units,
             0
           )) AS usage,
           SUM(COALESCE(cost_microusd, 0))::bigint AS funded_microusd
         FROM ai_usage_log
         WHERE account_id=$1
           AND time >= $2
           AND time < $3
           AND (tag IS DISTINCT FROM 'chat-speech-reservation'
                OR time >= NOW() - INTERVAL '5 minutes')
         GROUP BY funded_turn_id
       )
       SELECT COALESCE(SUM(usage), 0) AS usage,
         COALESCE(
           jsonb_object_agg(funded_turn_id::text, funded_microusd)
             FILTER (WHERE funded_turn_id IS NOT NULL),
           '{}'::jsonb
         ) AS site_funded_credits_microusd
       FROM per_turn`,
      [
        account_id,
        usageWindow.starts_at,
        usageWindow.resets_at,
        AI_USAGE_UNITS_PER_DOLLAR,
      ],
    );
    return {
      used: Number(rows[0]?.usage ?? 0),
      site_funded_credits_microusd: normalizeFundedTurnCredits(
        rows[0]?.site_funded_credits_microusd,
      ),
    };
  }
  const { rows } = await pool.query(
    `SELECT SUM(COALESCE(
       cost_microusd * $4::numeric / 1000000,
       usage_units,
       0
     )) AS usage
     FROM ai_usage_log
     WHERE account_id=$1
       AND time >= $2
       AND time < $3
       AND (tag IS DISTINCT FROM 'chat-speech-reservation'
            OR time >= NOW() - INTERVAL '5 minutes')`,
    [
      account_id,
      usageWindow.starts_at,
      usageWindow.resets_at,
      AI_USAGE_UNITS_PER_DOLLAR,
    ],
  );
  return { used: Number(rows[0]?.["usage"] ?? 0) };
}

function normalizeFundedTurnCredits(value: unknown): Record<string, number> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const credits: Record<string, number> = {};
  for (const [fundedTurnId, amount] of Object.entries(value)) {
    const numeric = Number(amount);
    if (Number.isSafeInteger(numeric) && numeric >= 0) {
      credits[fundedTurnId] = numeric;
    }
  }
  return credits;
}

async function recentUsageUnits({
  period,
  account_id,
  analytics_cookie,
  cache,
}: {
  period: string;
  account_id?: string;
  analytics_cookie?: string;
  cache?: CacheTime;
}): Promise<number> {
  const pool = getPool(cache);
  let query;
  let args: string[] = [];
  if (account_id) {
    query = `SELECT SUM(COALESCE(cost_microusd * ${AI_USAGE_UNITS_PER_DOLLAR}::numeric / 1000000, usage_units, 0)) AS usage FROM ai_usage_log WHERE account_id=$1 AND time >= NOW() - INTERVAL '${period}' AND (tag IS DISTINCT FROM 'chat-speech-reservation' OR time >= NOW() - INTERVAL '5 minutes')`;
    args = [account_id];
  } else if (analytics_cookie) {
    query = `SELECT SUM(COALESCE(cost_microusd * ${AI_USAGE_UNITS_PER_DOLLAR}::numeric / 1000000, usage_units, 0)) AS usage FROM ai_usage_log WHERE analytics_cookie=$1 AND time >= NOW() - INTERVAL '${period}' AND (tag IS DISTINCT FROM 'chat-speech-reservation' OR time >= NOW() - INTERVAL '5 minutes')`;
    args = [analytics_cookie];
  } else {
    query = `SELECT SUM(COALESCE(cost_microusd * ${AI_USAGE_UNITS_PER_DOLLAR}::numeric / 1000000, usage_units, 0)) AS usage FROM ai_usage_log WHERE time >= NOW() - INTERVAL '${period}' AND (tag IS DISTINCT FROM 'chat-speech-reservation' OR time >= NOW() - INTERVAL '5 minutes')`;
  }
  const { rows } = await pool.query(query, args);
  return Number(rows[0]?.["usage"] ?? 0);
}

async function getWindowResetAt({
  period,
  account_id,
  analytics_cookie,
}: {
  period: "5 hours" | "7 days";
  account_id?: string;
  analytics_cookie?: string;
}): Promise<Date | undefined> {
  const pool = getPool("short");
  let query;
  let args: string[] = [];
  if (account_id) {
    query = `SELECT time FROM ai_usage_log
             WHERE account_id=$1 AND time >= NOW() - INTERVAL '${period}'
             ORDER BY time ASC LIMIT 1`;
    args = [account_id];
  } else if (analytics_cookie) {
    query = `SELECT time FROM ai_usage_log
             WHERE analytics_cookie=$1 AND time >= NOW() - INTERVAL '${period}'
             ORDER BY time ASC LIMIT 1`;
    args = [analytics_cookie];
  } else {
    return;
  }
  const result = await pool.query(query, args);
  const rows = result.rows as Array<{ time?: string | Date }>;
  const oldest = rows[0]?.time;
  if (!oldest) return;
  const oldestMs = new Date(oldest).getTime();
  if (!Number.isFinite(oldestMs)) return;
  const windowMs =
    period === "5 hours" ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const resetMs = oldestMs + windowMs;
  return new Date(resetMs);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days == 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours == 1 ? "" : "s"}`);
  if (days == 0 && hours == 0 && minutes > 0) {
    parts.push(`${minutes} minute${minutes == 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

export async function getAIUsageLimits({
  account_id,
}: {
  account_id?: string;
}): Promise<AIUsageLimits> {
  if (!account_id) {
    return { units_5h: 0, units_7d: 0 };
  }
  const resolution = await resolveMembershipForAccount(account_id);
  const limits = resolution?.entitlements?.ai_limits ?? {};
  const units5h = extractLimit(limits, ["units_5h", "limit_5h"]);
  const units7d = extractLimit(limits, ["units_7d", "limit_7d"]);
  return {
    units_5h: units5h,
    units_7d: units7d,
  };
}

function extractLimit(limits: unknown, keys: string[]): number {
  if (limits == null || typeof limits !== "object") return 0;
  for (const key of keys) {
    const value = (limits as Record<string, unknown>)[key];
    if (typeof value == "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return 0;
}
