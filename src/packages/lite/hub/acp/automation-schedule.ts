/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpAutomationConfig } from "@cocalc/conat/ai/acp/types";

export const AUTOMATION_ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export const AUTOMATION_DEFAULT_INTERVAL_MINUTES = 120;
export const AUTOMATION_DEFAULT_WINDOW_START_LOCAL_TIME = "00:00";
export const AUTOMATION_DEFAULT_WINDOW_END_LOCAL_TIME = "23:59";
export const AUTOMATION_DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const AUTOMATION_DEFAULT_COMMAND_MAX_OUTPUT_BYTES = 250_000;

type AutomationConfigLike =
  | {
      enabled?: boolean | null;
      automation_id?: string | null;
      title?: string | null;
      run_kind?: "codex" | "command" | null;
      prompt?: string | null;
      command?: string | null;
      command_cwd?: string | null;
      command_timeout_ms?: number | null;
      command_max_output_bytes?: number | null;
      schedule_type?: "daily" | "interval" | null;
      days_of_week?: unknown;
      local_time?: string | null;
      interval_minutes?: number | null;
      window_start_local_time?: string | null;
      window_end_local_time?: string | null;
      timezone?: string | null;
      pause_after_unacknowledged_runs?: number | null;
    }
  | null
  | undefined;

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function normalizeAutomationLocalTime(
  value?: string,
): string | undefined {
  const raw = `${value ?? ""}`.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}`;
}

export function normalizeAutomationTimezone(
  value?: string,
): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date());
    return raw;
  } catch {
    return undefined;
  }
}

export function normalizeAutomationDaysOfWeek(
  value?: unknown,
): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days = [...new Set(value.map((day) => Number(day)))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((left, right) => left - right);
  return days.length > 0 ? days : undefined;
}

function shiftZonedDate(
  parts: { year: number; month: number; day: number },
  timeZone: string,
  dayOffset: number,
): { year: number; month: number; day: number } {
  if (dayOffset === 0) {
    return parts;
  }
  const reference = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, 12, 0, 0, 0),
  );
  const shifted = zonedParts(reference, timeZone);
  return {
    year: shifted.year,
    month: shifted.month,
    day: shifted.day,
  };
}

function weekdayForLocalDate(parts: {
  year: number;
  month: number;
  day: number;
}): number {
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0),
  ).getUTCDay();
}

function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(":").map((x) => Number(x));
  return hour * 60 + minute;
}

export function normalizeAcpAutomationConfig(
  config: AutomationConfigLike,
  {
    defaultPauseAfterRuns,
    defaultTimezone,
  }: {
    defaultPauseAfterRuns: number;
    defaultTimezone?: string;
  },
): AcpAutomationConfig | undefined {
  if (!config) return undefined;
  const enabled = config.enabled !== false;
  const run_kind = config.run_kind === "command" ? "command" : "codex";
  const prompt = `${config.prompt ?? ""}`.trim();
  const command = `${config.command ?? ""}`.trim();
  const command_cwd = `${config.command_cwd ?? ""}`.trim() || undefined;
  const timezone =
    normalizeAutomationTimezone(config.timezone ?? undefined) ??
    defaultTimezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timezone) return undefined;
  if (run_kind === "command") {
    if (!command) return undefined;
  } else if (!prompt) {
    return undefined;
  }

  const schedule_type =
    config.schedule_type === "interval" ? "interval" : "daily";
  const days_of_week = normalizeAutomationDaysOfWeek(config.days_of_week) ?? [
    ...AUTOMATION_ALL_DAYS,
  ];

  if (schedule_type === "interval") {
    const window_start_local_time =
      normalizeAutomationLocalTime(
        config.window_start_local_time ?? undefined,
      ) ?? AUTOMATION_DEFAULT_WINDOW_START_LOCAL_TIME;
    const window_end_local_time =
      normalizeAutomationLocalTime(config.window_end_local_time ?? undefined) ??
      AUTOMATION_DEFAULT_WINDOW_END_LOCAL_TIME;
    if (
      timeToMinutes(window_end_local_time) <=
      timeToMinutes(window_start_local_time)
    ) {
      return undefined;
    }
    return {
      enabled,
      automation_id: `${config.automation_id ?? ""}`.trim() || undefined,
      title: `${config.title ?? ""}`.trim() || undefined,
      run_kind,
      prompt: run_kind === "codex" ? prompt : undefined,
      command: run_kind === "command" ? command : undefined,
      command_cwd,
      command_timeout_ms:
        run_kind === "command"
          ? clampNumber(
              config.command_timeout_ms,
              AUTOMATION_DEFAULT_COMMAND_TIMEOUT_MS,
              1_000,
              24 * 60 * 60_000,
            )
          : undefined,
      command_max_output_bytes:
        run_kind === "command"
          ? clampNumber(
              config.command_max_output_bytes,
              AUTOMATION_DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
              1_024,
              10 * 1024 * 1024,
            )
          : undefined,
      schedule_type,
      days_of_week,
      interval_minutes: clampNumber(
        config.interval_minutes,
        AUTOMATION_DEFAULT_INTERVAL_MINUTES,
        5,
        24 * 60,
      ),
      window_start_local_time,
      window_end_local_time,
      timezone,
      pause_after_unacknowledged_runs: clampNumber(
        config.pause_after_unacknowledged_runs,
        defaultPauseAfterRuns,
        1,
        365,
      ),
    };
  }

  const local_time = normalizeAutomationLocalTime(
    config.local_time ?? undefined,
  );
  if (!local_time) return undefined;
  return {
    enabled,
    automation_id: `${config.automation_id ?? ""}`.trim() || undefined,
    title: `${config.title ?? ""}`.trim() || undefined,
    run_kind,
    prompt: run_kind === "codex" ? prompt : undefined,
    command: run_kind === "command" ? command : undefined,
    command_cwd,
    command_timeout_ms:
      run_kind === "command"
        ? clampNumber(
            config.command_timeout_ms,
            AUTOMATION_DEFAULT_COMMAND_TIMEOUT_MS,
            1_000,
            24 * 60 * 60_000,
          )
        : undefined,
    command_max_output_bytes:
      run_kind === "command"
        ? clampNumber(
            config.command_max_output_bytes,
            AUTOMATION_DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
            1_024,
            10 * 1024 * 1024,
          )
        : undefined,
    schedule_type,
    days_of_week,
    local_time,
    timezone,
    pause_after_unacknowledged_runs: clampNumber(
      config.pause_after_unacknowledged_runs,
      defaultPauseAfterRuns,
      1,
      365,
    ),
  };
}

export function zonedParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((x) => x.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

export function zonedEpochMs(opts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): number {
  let candidate = Date.UTC(
    opts.year,
    opts.month - 1,
    opts.day,
    opts.hour,
    opts.minute,
    0,
    0,
  );
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(candidate), opts.timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
    const targetUtc = Date.UTC(
      opts.year,
      opts.month - 1,
      opts.day,
      opts.hour,
      opts.minute,
      0,
      0,
    );
    candidate += targetUtc - asUtc;
  }
  return candidate;
}

function computeNextDailyAutomationRunAt(
  config: Required<Pick<AcpAutomationConfig, "local_time" | "timezone">> &
    Pick<AcpAutomationConfig, "days_of_week">,
  nowMs: number,
): number | undefined {
  const now = new Date(nowMs);
  const [hour, minute] = config.local_time.split(":").map((x) => Number(x));
  const nowParts = zonedParts(now, config.timezone);
  const allowedDays = new Set(
    normalizeAutomationDaysOfWeek(config.days_of_week) ?? AUTOMATION_ALL_DAYS,
  );
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const localDate = shiftZonedDate(nowParts, config.timezone, dayOffset);
    if (!allowedDays.has(weekdayForLocalDate(localDate))) {
      continue;
    }
    const candidate = zonedEpochMs({
      ...localDate,
      hour,
      minute,
      timeZone: config.timezone,
    });
    if (candidate > nowMs) {
      return candidate;
    }
  }
  return undefined;
}

function computeNextIntervalAutomationRunAt(
  config: Required<
    Pick<
      AcpAutomationConfig,
      | "interval_minutes"
      | "window_start_local_time"
      | "window_end_local_time"
      | "timezone"
    >
  > &
    Pick<AcpAutomationConfig, "days_of_week">,
  nowMs: number,
): number | undefined {
  const now = new Date(nowMs);
  const startMinutes = timeToMinutes(config.window_start_local_time);
  const endMinutes = timeToMinutes(config.window_end_local_time);
  if (endMinutes <= startMinutes) return undefined;
  const nowParts = zonedParts(now, config.timezone);
  const allowedDays = new Set(
    normalizeAutomationDaysOfWeek(config.days_of_week) ?? AUTOMATION_ALL_DAYS,
  );

  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const localDate = shiftZonedDate(nowParts, config.timezone, dayOffset);
    if (!allowedDays.has(weekdayForLocalDate(localDate))) {
      continue;
    }
    for (
      let slotMinutes = startMinutes;
      slotMinutes <= endMinutes;
      slotMinutes += config.interval_minutes
    ) {
      const candidate = zonedEpochMs({
        ...localDate,
        hour: Math.floor(slotMinutes / 60),
        minute: slotMinutes % 60,
        timeZone: config.timezone,
      });
      if (candidate > nowMs) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function computeNextAutomationRunAt(
  config: AutomationConfigLike,
  {
    nowMs,
    defaultPauseAfterRuns,
    defaultTimezone,
  }: {
    nowMs?: number;
    defaultPauseAfterRuns: number;
    defaultTimezone?: string;
  },
): number | undefined {
  const normalized = normalizeAcpAutomationConfig(config, {
    defaultPauseAfterRuns,
    defaultTimezone,
  });
  if (!normalized?.timezone) return undefined;
  const currentNowMs = nowMs ?? Date.now();
  if (
    normalized.schedule_type === "interval" &&
    normalized.interval_minutes &&
    normalized.window_start_local_time &&
    normalized.window_end_local_time
  ) {
    return computeNextIntervalAutomationRunAt(
      {
        interval_minutes: normalized.interval_minutes,
        window_start_local_time: normalized.window_start_local_time,
        window_end_local_time: normalized.window_end_local_time,
        timezone: normalized.timezone,
        days_of_week: normalized.days_of_week,
      },
      currentNowMs,
    );
  }
  if (normalized.local_time) {
    return computeNextDailyAutomationRunAt(
      {
        local_time: normalized.local_time,
        timezone: normalized.timezone,
        days_of_week: normalized.days_of_week,
      },
      currentNowMs,
    );
  }
  return undefined;
}

export function computeSkippedAutomationRunAt(
  config: AutomationConfigLike,
  {
    nextRunAtMs,
    nowMs,
    defaultPauseAfterRuns,
    defaultTimezone,
  }: {
    nextRunAtMs?: number | null;
    nowMs?: number;
    defaultPauseAfterRuns: number;
    defaultTimezone?: string;
  },
): number | undefined {
  return computeNextAutomationRunAt(config, {
    nowMs:
      typeof nextRunAtMs === "number" && nextRunAtMs > 0 ? nextRunAtMs : nowMs,
    defaultPauseAfterRuns,
    defaultTimezone,
  });
}
