/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Sensor schedules: when an approved sensor script runs. Pure and
// browser-safe, so the hub (authoritative), the CLI and the frontend agree.

export type SensorSchedule =
  | {
      kind: "interval";
      /** Minutes between runs, at least the membership tier's minimum. */
      minutes: number;
      /** IANA time zone for `days` and `window`; default UTC. */
      timezone?: string;
      /** Allowed weekdays, 0 = Sunday; default every day. */
      days?: number[];
      /** Only run between these local times ("HH:MM"), inclusive. */
      window?: { start: string; end: string };
    }
  | {
      kind: "daily";
      /** Local times of day ("HH:MM"), at most 24. */
      times: string[];
      timezone: string;
      days?: number[];
    };

export const SENSOR_MAX_DAILY_TIMES = 24;
export const SENSOR_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function localTime(value: unknown, name: string): string {
  const match =
    typeof value === "string" ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59)
    throw new Error(`${name} must be a local time like 09:30`);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function minutesOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function timezone(value: unknown, fallback?: string): string {
  if (value == null && fallback) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 64)
    throw new Error("schedule timezone must be an IANA time zone");
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
  } catch {
    throw new Error(`unknown time zone "${value}"`);
  }
  return value.trim();
}

function days(value: unknown): number[] | undefined {
  if (value == null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    throw new Error("schedule days must be weekday numbers 0 (Sunday) to 6");
  const result = [...new Set(value as number[])].sort((a, b) => a - b);
  return result.length === 7 ? undefined : result;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`unknown schedule field "${unknown}"`);
}

/**
 * Validate a schedule and normalize it. `minIntervalMinutes` comes from the
 * membership tier: no two runs may be closer together than that.
 */
export function validateSensorSchedule(
  value: unknown,
  { minIntervalMinutes }: { minIntervalMinutes: number },
): SensorSchedule {
  const s = value as Record<string, unknown>;
  if (!s || typeof s !== "object" || Array.isArray(s))
    throw new Error("schedule must be an object");
  if (s.kind === "interval") {
    onlyKeys(s, ["kind", "minutes", "timezone", "days", "window"]);
    const minutes = s.minutes;
    if (
      typeof minutes !== "number" ||
      !Number.isInteger(minutes) ||
      minutes < minIntervalMinutes ||
      minutes > SENSOR_MAX_INTERVAL_MINUTES
    )
      throw new Error(
        `schedule minutes must be a whole number from ${minIntervalMinutes} (your membership's minimum) to ${SENSOR_MAX_INTERVAL_MINUTES}`,
      );
    let window: { start: string; end: string } | undefined;
    if (s.window != null) {
      const w = s.window as Record<string, unknown>;
      if (!w || typeof w !== "object")
        throw new Error("schedule window must be {start, end}");
      onlyKeys(w, ["start", "end"]);
      window = {
        start: localTime(w.start, "window start"),
        end: localTime(w.end, "window end"),
      };
      if (minutesOf(window.end) <= minutesOf(window.start))
        throw new Error("schedule window must end after it starts");
    }
    const d = days(s.days);
    return {
      kind: "interval",
      minutes,
      timezone: timezone(s.timezone, "UTC"),
      ...(d ? { days: d } : {}),
      ...(window ? { window } : {}),
    };
  }
  if (s.kind === "daily") {
    onlyKeys(s, ["kind", "times", "timezone", "days"]);
    if (
      !Array.isArray(s.times) ||
      s.times.length === 0 ||
      s.times.length > SENSOR_MAX_DAILY_TIMES
    )
      throw new Error(
        `schedule times must list 1 to ${SENSOR_MAX_DAILY_TIMES} local times`,
      );
    const times = [
      ...new Set(s.times.map((time) => localTime(time, "schedule time"))),
    ].sort();
    // Neighbouring times, including last-to-first across midnight, must
    // respect the tier minimum like an interval would.
    for (let i = 0; i < times.length && times.length > 1; i++) {
      const next = (i + 1) % times.length;
      const gap =
        (minutesOf(times[next]) - minutesOf(times[i]) + 24 * 60) % (24 * 60);
      if (gap < minIntervalMinutes)
        throw new Error(
          `schedule times must be at least ${minIntervalMinutes} minutes apart (your membership's minimum)`,
        );
    }
    const d = days(s.days);
    return {
      kind: "daily",
      times,
      timezone: timezone(s.timezone),
      ...(d ? { days: d } : {}),
    };
  }
  throw new Error('schedule kind must be "interval" or "daily"');
}

export function describeSensorSchedule(schedule: SensorSchedule): string {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const on = schedule.days
    ? ` on ${schedule.days.map((d) => names[d]).join(", ")}`
    : "";
  if (schedule.kind === "interval") {
    const every =
      schedule.minutes % 60 === 0
        ? `${schedule.minutes / 60} hour${schedule.minutes === 60 ? "" : "s"}`
        : `${schedule.minutes} minutes`;
    const window = schedule.window
      ? ` between ${schedule.window.start} and ${schedule.window.end}`
      : "";
    const tz =
      schedule.window || schedule.days
        ? ` (${schedule.timezone ?? "UTC"})`
        : "";
    return `Every ${every}${window}${on}${tz}`;
  }
  return `Daily at ${schedule.times.join(", ")}${on} (${schedule.timezone})`;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
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

// The UTC instant of a local wall-clock time, settling DST offsets.
function zonedEpochMs(
  date: { year: number; month: number; day: number },
  minuteOfDay: number,
  timeZone: string,
): number {
  const target = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
  );
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(new Date(candidate), timeZone);
    candidate +=
      target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return candidate;
}

function localDate(nowMs: number, timeZone: string, dayOffset: number) {
  const now = zonedParts(new Date(nowMs), timeZone);
  const noon = new Date(
    Date.UTC(now.year, now.month - 1, now.day + dayOffset, 12),
  );
  return {
    year: noon.getUTCFullYear(),
    month: noon.getUTCMonth() + 1,
    day: noon.getUTCDate(),
    weekday: noon.getUTCDay(),
  };
}

/** The first run strictly after `nowMs`, or undefined if none in 8 days. */
export function nextSensorRunAt(
  schedule: SensorSchedule,
  nowMs: number,
): number | undefined {
  const tz = schedule.timezone ?? "UTC";
  const allowed = new Set(schedule.days ?? ALL_DAYS);
  if (
    schedule.kind === "interval" &&
    !schedule.window &&
    allowed.size === ALL_DAYS.length
  ) {
    // Plain intervals run on a fixed grid from the epoch, so restarts and
    // missed runs never drift the schedule.
    const step = schedule.minutes * 60_000;
    return (Math.floor(nowMs / step) + 1) * step;
  }
  for (let offset = 0; offset <= 8; offset++) {
    const date = localDate(nowMs, tz, offset);
    if (!allowed.has(date.weekday)) continue;
    let slots: number[];
    if (schedule.kind === "daily") {
      slots = schedule.times.map(minutesOf);
    } else {
      const start = schedule.window ? minutesOf(schedule.window.start) : 0;
      const end = schedule.window
        ? minutesOf(schedule.window.end)
        : 24 * 60 - 1;
      slots = [];
      for (let m = start; m <= end; m += schedule.minutes) slots.push(m);
    }
    for (const minute of slots) {
      const at = zonedEpochMs(date, minute, tz);
      if (at > nowMs) return at;
    }
  }
  return undefined;
}
