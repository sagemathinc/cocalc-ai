/** Account-private subscription limits, not token counts or a billing estimate. */
export interface ClaudeUsageWindow {
  name: string;
  usedPercent: number;
  resetsAt?: string;
}

export interface ClaudeSubscriptionUsage {
  fetchedAt: string;
  windows: ClaudeUsageWindow[];
  available: boolean;
}

/** Whitelist display fields; never forward an SDK response or credential state. */
export function parseClaudeSubscriptionUsage(
  value: unknown,
): ClaudeSubscriptionUsage {
  const result: ClaudeSubscriptionUsage = {
    fetchedAt: new Date().toISOString(),
    windows: [],
    available: false,
  };
  if (!value || typeof value !== "object") return result;
  const data = value as Record<string, any>;
  if (data.rate_limits_available !== true || !data.rate_limits) return result;
  for (const [key, name] of [
    ["five_hour", "Current session (5 hours)"],
    ["seven_day", "This week"],
    ["seven_day_opus", "Weekly Opus"],
    ["seven_day_sonnet", "Weekly Sonnet"],
  ]) {
    const window = data.rate_limits[key];
    if (
      typeof window?.utilization !== "number" ||
      !Number.isFinite(window.utilization) ||
      window.utilization < 0 ||
      window.utilization > 100
    )
      continue;
    const reset =
      typeof window.resets_at === "string" && window.resets_at.length < 100
        ? Date.parse(window.resets_at)
        : NaN;
    result.windows.push({
      name,
      usedPercent: window.utilization,
      ...(Number.isFinite(reset)
        ? { resetsAt: new Date(reset).toISOString() }
        : {}),
    });
  }
  result.available = result.windows.length > 0;
  return result;
}
