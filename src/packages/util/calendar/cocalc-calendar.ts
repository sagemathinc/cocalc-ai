/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A CoCalc calendar (`*.cal.json`): dates an agent shows a person, published as
a file artifact and shown as a card (agenda and month views, an event's
details on click, .ics download). Pure and browser-safe: the card, the CLI's
`cocalc calendar validate` and any agent share this one reading of the
format.

  {
    "format": "cocalc-calendar", "version": 1,
    "id"?: "sagemath-taxes",                   (keeps .ics UIDs apart)
    "title": "...", "description": "...",
    "timezone": "America/Los_Angeles",          (IANA; how local times read)
    "default_view": "agenda" | "month",
    "categories": {"tax": {"label": "Tax filing", "color": "#d9480f"}},
    "events": [{
      "id": "lni-quarterly", "title": "WA L&I quarterly report",
      "start": "2027-01-06" | "2027-01-06T08:30" | "...T08:30-08:00",
      "end"?, "all_day"?, "due"? (a date or time), "due_offset_days"?,
      "recurrence"?: {"freq": "daily"|"weekly"|"monthly"|"yearly",
                      "interval"?, "bymonthday"?, "bymonth"?, "byweekday"?
                      (["MO", ...]), "until"? (a date), "count"?},
      "category"?, "status"?: "scheduled"|"pending"|"done"|"cancelled",
      "owner"?, "details"? (Markdown), "links"?: [{"label", "url"}],
      "sensor_id"?
    }]
  }

A time without an offset is in the calendar's time zone; a date alone is an
all-day event. Recurring events repeat their start's local time of day; a
day of the month past a month's end falls on its last day.
*/

export const CALENDAR_FORMAT = "cocalc-calendar";
export const CALENDAR_VERSION = 1;
/** Bounds, so a card never chokes on a file. */
export const CALENDAR_LIMITS = {
  maxEvents: 2_000,
  maxTextBytes: 1_000_000,
  maxDetails: 20_000,
  maxLinks: 20,
  /** Occurrences of one event expanded for any range. */
  maxOccurrences: 1_000,
} as const;

export type CalendarStatus = "scheduled" | "pending" | "done" | "cancelled";
export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";
const WEEKDAYS: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export interface CalendarRecurrence {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval?: number;
  bymonthday?: number[];
  bymonth?: number[];
  byweekday?: Weekday[];
  /** The last local date it may occur on, inclusive. */
  until?: string;
  count?: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  all_day?: boolean;
  due?: string;
  due_offset_days?: number;
  recurrence?: CalendarRecurrence;
  category?: string;
  status?: CalendarStatus;
  owner?: string;
  details?: string;
  links?: { label: string; url: string }[];
  sensor_id?: string;
}

export interface CocalcCalendar {
  format: typeof CALENDAR_FORMAT;
  version: 1;
  /** Names this calendar in exported UIDs, so two calendars' events with the
   * same id stay apart in one calendar app; the title's hash without it. */
  id?: string;
  title: string;
  description?: string;
  timezone: string;
  default_view: "agenda" | "month";
  categories?: Record<string, { label: string; color?: string }>;
  events: CalendarEvent[];
}

export interface CalendarProblem {
  /** Where, like "events[3].start" ("" for the whole file). */
  path: string;
  message: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const STATUSES: CalendarStatus[] = [
  "scheduled",
  "pending",
  "done",
  "cancelled",
];
const DAY_MS = 86_400_000;

function validDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/** How a time string reads: a date, a local time, a time with an offset. */
export function calendarTimeKind(
  value: unknown,
): "date" | "local" | "zoned" | undefined {
  if (typeof value !== "string") return;
  let m = DATE.exec(value);
  if (m) return validDate(+m[1], +m[2], +m[3]) ? "date" : undefined;
  m = LOCAL_TIME.exec(value);
  if (m)
    return validDate(+m[1], +m[2], +m[3]) &&
      +m[4] < 24 &&
      +m[5] < 60 &&
      +(m[6] ?? 0) < 60
      ? "local"
      : undefined;
  return ZONED_TIME.test(value) && Number.isFinite(Date.parse(value))
    ? "zoned"
    : undefined;
}

function validZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Links a card may show: web pages and mail, nothing that runs code. */
export function calendarLinkAllowed(url: unknown): boolean {
  if (typeof url !== "string" || url.length > 2_000) return false;
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Read a calendar file's text: the calendar if it can be shown, and every
 * problem found. Events with problems are left out (and listed); `ok` says
 * whether there were none at all.
 */
export function parseCalendar(text: string): {
  ok: boolean;
  calendar?: CocalcCalendar;
  problems: CalendarProblem[];
} {
  const problems: CalendarProblem[] = [];
  const problem = (path: string, message: string) =>
    problems.push({ path, message });
  if (text.length > CALENDAR_LIMITS.maxTextBytes)
    return {
      ok: false,
      problems: [
        {
          path: "",
          message: `the file is larger than ${CALENDAR_LIMITS.maxTextBytes} bytes`,
        },
      ],
    };
  let value: any;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      problems: [{ path: "", message: `not JSON: ${(err as Error).message}` }],
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      ok: false,
      problems: [{ path: "", message: "not a JSON object" }],
    };
  if (value.format !== CALENDAR_FORMAT)
    problem("format", `must be "${CALENDAR_FORMAT}"`);
  if (value.version !== CALENDAR_VERSION)
    problem("version", `must be ${CALENDAR_VERSION}`);
  if (typeof value.title !== "string" || !value.title.trim())
    problem("title", "must be a non-empty string");
  if (value.description != null && typeof value.description !== "string")
    problem("description", "must be a string");
  const idOk = (id: unknown): id is string =>
    typeof id === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(id);
  if (value.id != null && !idOk(value.id))
    problem("id", "must be 1 to 100 letters, digits or _ . : -");
  const timezone = value.timezone;
  if (!validZone(timezone))
    problem("timezone", "must be an IANA time zone, like America/Los_Angeles");
  if (
    value.default_view != null &&
    value.default_view !== "agenda" &&
    value.default_view !== "month"
  )
    problem("default_view", 'must be "agenda" or "month"');
  const categories: Record<string, { label: string; color?: string }> = {};
  if (value.categories != null) {
    if (typeof value.categories !== "object" || Array.isArray(value.categories))
      problem("categories", "must be an object of {label, color}");
    else
      for (const [key, c] of Object.entries<any>(value.categories)) {
        if (!c || typeof c.label !== "string" || !c.label.trim())
          problem(`categories.${key}`, "needs a label");
        else if (c.color != null && !COLOR.test(c.color))
          problem(`categories.${key}.color`, "must look like #1971c2");
        else
          categories[key] = {
            label: c.label,
            ...(c.color ? { color: c.color } : {}),
          };
      }
  }
  const events: CalendarEvent[] = [];
  if (!Array.isArray(value.events)) problem("events", "must be a list");
  else if (value.events.length > CALENDAR_LIMITS.maxEvents)
    problem("events", `at most ${CALENDAR_LIMITS.maxEvents} events`);
  else if (validZone(timezone)) {
    const ids = new Set<string>();
    value.events.forEach((e: any, i: number) => {
      const event = parseEvent(e, timezone, categories, (field, message) =>
        problem(`events[${i}]${field ? `.${field}` : ""}`, message),
      );
      if (!event) return;
      if (ids.has(event.id)) {
        problem(`events[${i}].id`, `"${event.id}" is used twice`);
        return;
      }
      ids.add(event.id);
      events.push(event);
    });
  }
  const showable =
    value.format === CALENDAR_FORMAT &&
    validZone(timezone) &&
    Array.isArray(value.events);
  return {
    ok: problems.length === 0,
    ...(showable
      ? {
          calendar: {
            format: CALENDAR_FORMAT,
            version: 1,
            ...(idOk(value.id) ? { id: value.id } : {}),
            title:
              typeof value.title === "string" && value.title.trim()
                ? value.title
                : "Calendar",
            ...(typeof value.description === "string"
              ? { description: value.description }
              : {}),
            timezone,
            default_view: value.default_view === "month" ? "month" : "agenda",
            ...(Object.keys(categories).length ? { categories } : {}),
            events,
          },
        }
      : {}),
    problems,
  };
}

function parseEvent(
  e: any,
  timezone: string,
  categories: Record<string, unknown>,
  bad: (field: string, message: string) => void,
): CalendarEvent | undefined {
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    bad("", "must be an object");
    return;
  }
  let usable = true;
  if (typeof e.id !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(e.id)) {
    bad("id", "must be 1 to 100 letters, digits or _ . : -");
    usable = false;
  }
  if (typeof e.title !== "string" || !e.title.trim()) {
    bad("title", "must be a non-empty string");
    usable = false;
  }
  const startKind = calendarTimeKind(e.start);
  if (!startKind) {
    bad("start", "must be a date (2027-01-31) or a time (2027-01-31T08:30)");
    usable = false;
  }
  let end: string | undefined;
  if (e.end != null) {
    const endKind = calendarTimeKind(e.end);
    if (!endKind) bad("end", "must be a date or a time");
    else if (startKind && (endKind === "date") !== (startKind === "date"))
      bad("end", "must be a date if start is one, a time if start is one");
    else if (
      startKind &&
      calendarInstant(e.end, timezone) < calendarInstant(e.start, timezone)
    )
      bad("end", "must not be before start");
    else end = e.end;
  }
  if (e.all_day != null && typeof e.all_day !== "boolean")
    bad("all_day", "must be true or false");
  if (e.all_day === true && startKind && startKind !== "date")
    bad("start", "an all-day event starts on a date, like 2027-01-31");
  let due: string | undefined;
  if (e.due != null) {
    if (!calendarTimeKind(e.due)) bad("due", "must be a date or a time");
    else if (e.recurrence != null)
      // One date cannot be each occurrence's deadline.
      bad("due", "a recurring event uses due_offset_days instead");
    else if (e.due_offset_days != null)
      bad("due", "use either due or due_offset_days, not both");
    else due = e.due;
  }
  if (
    e.due_offset_days != null &&
    !(
      Number.isInteger(e.due_offset_days) &&
      e.due_offset_days >= 0 &&
      e.due_offset_days <= 366
    )
  )
    bad("due_offset_days", "must be a whole number of days, 0 to 366");
  if (e.status != null && !STATUSES.includes(e.status))
    bad("status", `must be one of ${STATUSES.join(", ")}`);
  // Own keys only: "constructor" or "toString" is not a category.
  const known = (key: unknown) =>
    typeof key === "string" &&
    Object.prototype.hasOwnProperty.call(categories, key);
  if (e.category != null && !known(e.category))
    bad("category", `"${e.category}" is not one of the categories`);
  if (
    e.details != null &&
    (typeof e.details !== "string" ||
      e.details.length > CALENDAR_LIMITS.maxDetails)
  )
    bad(
      "details",
      `must be Markdown text, at most ${CALENDAR_LIMITS.maxDetails} characters`,
    );
  if (e.owner != null && (typeof e.owner !== "string" || e.owner.length > 200))
    bad("owner", "must be a name, like @accounting");
  if (e.sensor_id != null && typeof e.sensor_id !== "string")
    bad("sensor_id", "must be a sensor id");
  let links: CalendarEvent["links"];
  if (e.links != null) {
    if (!Array.isArray(e.links) || e.links.length > CALENDAR_LIMITS.maxLinks)
      bad(
        "links",
        `must be a list of at most ${CALENDAR_LIMITS.maxLinks} {label, url}`,
      );
    else
      links = e.links.filter((link: any, j: number) => {
        const ok =
          link &&
          typeof link.label === "string" &&
          link.label.trim() &&
          calendarLinkAllowed(link.url);
        if (!ok)
          bad(`links[${j}]`, "needs a label and an http(s) or mailto URL");
        return ok;
      });
  }
  let recurrence: CalendarRecurrence | undefined;
  if (e.recurrence != null) {
    recurrence = parseRecurrence(e.recurrence, (field, message) =>
      bad(`recurrence${field ? `.${field}` : ""}`, message),
    );
    if (!recurrence) usable = false;
    else if (startKind) {
      const startDate =
        startKind === "date"
          ? e.start
          : calendarLocalDate(calendarInstant(e.start, timezone), timezone);
      const rule = monthEndRule(recurrence, startDate);
      if (rule.kind === "unsupported") {
        bad("recurrence.bymonthday", rule.message);
        usable = false;
      }
    }
  }
  if (!usable) return;
  return {
    id: e.id,
    title: e.title,
    start: e.start,
    ...(end ? { end } : {}),
    ...(startKind === "date" ? { all_day: true } : {}),
    ...(due ? { due } : {}),
    ...(Number.isInteger(e.due_offset_days) &&
    e.due_offset_days >= 0 &&
    e.due_offset_days <= 366
      ? { due_offset_days: e.due_offset_days }
      : {}),
    ...(recurrence ? { recurrence } : {}),
    ...(known(e.category) ? { category: e.category } : {}),
    ...(STATUSES.includes(e.status) ? { status: e.status } : {}),
    ...(typeof e.owner === "string" && e.owner.length <= 200
      ? { owner: e.owner }
      : {}),
    ...(typeof e.details === "string" &&
    e.details.length <= CALENDAR_LIMITS.maxDetails
      ? { details: e.details }
      : {}),
    ...(links?.length ? { links } : {}),
    ...(typeof e.sensor_id === "string" ? { sensor_id: e.sensor_id } : {}),
  };
}

/**
 * How a monthly or yearly rule's month-end days are written in iCalendar.
 * Here a day past a month's end falls on its last day (the 31st is Feb 28);
 * an RRULE skips such months, so one day after the 28th is written as
 * "the last of 28..that day" (BYMONTHDAY=28,29,30,31;BYSETPOS=-1), with the
 * other days kept by their positions. Rules that cannot be written exactly
 * are refused when the calendar is read.
 */
type MonthEndRule =
  | { kind: "none" }
  | {
      kind: "setpos";
      freq: "MONTHLY" | "YEARLY";
      bymonth?: number[];
      bymonthday: number[];
      bysetpos: number[];
    }
  | { kind: "unsupported"; message: string };

function monthEndRule(r: CalendarRecurrence, startDate: string): MonthEndRule {
  if (r.freq !== "monthly" && r.freq !== "yearly") return { kind: "none" };
  const [, sm, sd] = startDate.split("-").map(Number);
  const days = r.bymonthday ?? (r.byweekday ? undefined : [sd]);
  const late = (days ?? []).filter((d) => d > 28);
  if (late.length === 0) return { kind: "none" };
  if (late.length > 1)
    return {
      kind: "unsupported",
      message:
        "at most one day after the 28th (it falls on the last day of shorter months)",
    };
  if (r.byweekday)
    return {
      kind: "unsupported",
      message: "a day after the 28th cannot be combined with byweekday",
    };
  const months = r.bymonth ?? [sm];
  let freq: "MONTHLY" | "YEARLY" = "MONTHLY";
  if (r.freq === "yearly") {
    // BYSETPOS picks within each period: a year of one month is that month;
    // several months need a monthly rule, which only every year can be.
    if (months.length === 1) freq = "YEARLY";
    else if ((r.interval ?? 1) > 1)
      return {
        kind: "unsupported",
        message:
          "a day after the 28th in several months needs interval 1 for a yearly rule",
      };
  }
  const low = [...new Set((days ?? []).filter((d) => d <= 28))].sort(
    (a, b) => a - b,
  );
  const range: number[] = [];
  for (let d = 28; d <= late[0]; d++) range.push(d);
  return {
    kind: "setpos",
    freq,
    ...(r.freq === "yearly" || r.bymonth ? { bymonth: months } : {}),
    bymonthday: [...new Set([...low, ...range])].sort((a, b) => a - b),
    bysetpos: [...low.map((_, i) => i + 1), -1],
  };
}

function parseRecurrence(
  r: any,
  bad: (field: string, message: string) => void,
): CalendarRecurrence | undefined {
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    bad("", "must be an object");
    return;
  }
  const known = [
    "freq",
    "interval",
    "bymonthday",
    "bymonth",
    "byweekday",
    "until",
    "count",
  ];
  const unknown = Object.keys(r).find((k) => !known.includes(k));
  if (unknown) {
    bad(unknown, "is not a recurrence field");
    return;
  }
  if (!["daily", "weekly", "monthly", "yearly"].includes(r.freq)) {
    bad("freq", 'must be "daily", "weekly", "monthly" or "yearly"');
    return;
  }
  const ints = (v: any, min: number, max: number) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((n) => Number.isInteger(n) && n >= min && n <= max);
  if (
    r.interval != null &&
    !(Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= 1000)
  ) {
    bad("interval", "must be a whole number from 1 to 1000");
    return;
  }
  if (r.bymonthday != null && !ints(r.bymonthday, 1, 31)) {
    bad("bymonthday", "must be days 1 to 31");
    return;
  }
  // As in iCalendar, whose rules these export as: days of the month pick
  // within a month or a year, not within days or weeks.
  if (r.bymonthday != null && (r.freq === "daily" || r.freq === "weekly")) {
    bad("bymonthday", "is for monthly and yearly rules");
    return;
  }
  if (r.bymonth != null && !ints(r.bymonth, 1, 12)) {
    bad("bymonth", "must be months 1 to 12");
    return;
  }
  if (
    r.byweekday != null &&
    !(
      Array.isArray(r.byweekday) &&
      r.byweekday.length > 0 &&
      r.byweekday.every((d: any) => WEEKDAYS.includes(d))
    )
  ) {
    bad("byweekday", 'must be weekdays like ["MO", "WE"]');
    return;
  }
  if (r.until != null && calendarTimeKind(r.until) !== "date") {
    bad("until", "must be a date like 2027-12-31");
    return;
  }
  if (
    r.count != null &&
    !(
      Number.isInteger(r.count) &&
      r.count >= 1 &&
      r.count <= CALENDAR_LIMITS.maxOccurrences
    )
  ) {
    bad("count", `must be 1 to ${CALENDAR_LIMITS.maxOccurrences}`);
    return;
  }
  const sorted = (v: number[]) => [...new Set(v)].sort((a, b) => a - b);
  return {
    freq: r.freq,
    ...(r.interval > 1 ? { interval: r.interval } : {}),
    ...(r.bymonthday ? { bymonthday: sorted(r.bymonthday) } : {}),
    ...(r.bymonth ? { bymonth: sorted(r.bymonth) } : {}),
    ...(r.byweekday
      ? { byweekday: WEEKDAYS.filter((d) => r.byweekday.includes(d)) }
      : {}),
    ...(r.until ? { until: r.until } : {}),
    ...(r.count ? { count: r.count } : {}),
  };
}

// --- time ---------------------------------------------------------------

// Making a formatter is far slower than using one: one per zone.
const formatters = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f == null) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (formatters.size > 100) formatters.clear();
    formatters.set(timeZone, f);
  }
  return f;
}

function zonedParts(ms: number, timeZone: string) {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(ms));
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

/** The instant of a local wall-clock time in a zone, settling DST. */
function zonedMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): number {
  const target = Date.UTC(y, mo - 1, d, h, mi, s);
  // How far the zone's wall clock is from UTC at an instant.
  const offset = (t: number) => {
    const p = zonedParts(t, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  // The usual case, and a repeated (fall-back) hour: its first instant.
  for (const guess of [target - offset(target), target]) {
    const candidate = target - offset(guess);
    if (candidate + offset(candidate) === target) return candidate;
  }
  // A time the clocks skip (spring forward) does not exist: read it with
  // the offset before the change, which lands as far past the gap (02:30
  // becomes 03:30), as calendar apps do.
  return target - offset(target - DAY_MS);
}

/** When a calendar time string is; a date is its local midnight. */
export function calendarInstant(value: string, timeZone: string): number {
  let m = DATE.exec(value);
  if (m) return zonedMs(+m[1], +m[2], +m[3], 0, 0, 0, timeZone);
  m = LOCAL_TIME.exec(value);
  if (m)
    return zonedMs(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0), timeZone);
  return Date.parse(value);
}

/** A local date ("YYYY-MM-DD") in a zone. */
export function calendarLocalDate(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return ymd(p.year, p.month, p.day);
}

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return ymd(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

// Days since 1970-01-01 for a proleptic Gregorian date, and back (integer
// arithmetic, no Date objects: a long recurrence scans many days).
function dayNumber(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilDate(n: number): [number, number, number] {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** A recurrence is expanded at most this long after its start. */
const MAX_RECURRENCE_DAYS = 200 * 365 + 49;

/**
 * The local dates an event occurs on, in order, from `fromDate` to
 * `lastDate` (inclusive), within its own until and count (counted from its
 * start), and at most 200 years after its start.
 */
function occurrenceDates(
  event: CalendarEvent,
  timeZone: string,
  fromDate: string,
  lastDate: string,
  max: number = CALENDAR_LIMITS.maxOccurrences,
): string[] {
  const first = DATE.test(event.start)
    ? event.start
    : calendarLocalDate(calendarInstant(event.start, timeZone), timeZone);
  const r = event.recurrence;
  if (!r) return first <= lastDate ? [first] : [];
  const [sy, sm, sd] = first.split("-").map(Number);
  const startDay = dayNumber(sy, sm, sd);
  const horizon = ymd(...civilDate(startDay + MAX_RECURRENCE_DAYS));
  let last = r.until && r.until < lastDate ? r.until : lastDate;
  if (horizon < last) last = horizon;
  // `seen` counts every occurrence from the start (for count); only those
  // from fromDate are kept, at most maxOccurrences of them.
  let seen = 0;
  const count = r.count ?? Infinity;
  const interval = r.interval ?? 1;
  const out: string[] = [];
  // 1970-01-01 was a Thursday.
  const weekday = (y: number, m: number, d: number) =>
    WEEKDAYS[(((dayNumber(y, m, d) + 4) % 7) + 7) % 7];
  const fits = (y: number, m: number, d: number) =>
    (!r.bymonth || r.bymonth.includes(m)) &&
    (!r.byweekday || r.byweekday.includes(weekday(y, m, d))) &&
    (!r.bymonthday ||
      r.bymonthday.some((n) => Math.min(n, daysInMonth(y, m)) === d));
  const full = () => seen >= count || out.length >= max;
  const take = (date: string): boolean => {
    if (date > last || full()) return false;
    if (date < first) return true;
    seen += 1;
    if (date >= fromDate) out.push(date);
    return true;
  };
  if (r.freq === "daily" || r.freq === "weekly") {
    // Day by day from the start; every `interval` days, or weeks (weeks
    // counted from the start's). Without a count nothing before the range
    // matters, so the scan starts at the period that holds `fromDate`.
    const period = r.freq === "daily" ? interval : 7 * interval;
    const [fy, fm, fd] = fromDate.split("-").map(Number);
    const ahead = dayNumber(fy, fm, fd) - startDay;
    const [ly, lm, ld] = last.split("-").map(Number);
    const lastDay = dayNumber(ly, lm, ld);
    for (
      let i = count === Infinity && ahead > 0 ? ahead - (ahead % period) : 0;
      startDay + i <= lastDay && !full();
      i++
    ) {
      const [y, m, d] = civilDate(startDay + i);
      if (r.freq === "daily") {
        if (i % interval !== 0 || !fits(y, m, d)) continue;
      } else {
        if (Math.floor(i / 7) % interval !== 0) continue;
        if (r.byweekday ? !fits(y, m, d) : i % 7 !== 0) continue;
        if (!fits(y, m, d)) continue;
      }
      if (!take(ymd(y, m, d))) break;
    }
    return out;
  }
  // Monthly or yearly: the days of each period's months that fit.
  const lastYear = +last.slice(0, 4);
  for (let k = 0; !full(); k += interval) {
    const months: [number, number][] =
      r.freq === "monthly"
        ? [[sy + Math.floor((sm - 1 + k) / 12), ((sm - 1 + k) % 12) + 1]]
        : (r.bymonth ?? [sm]).map((m) => [sy + k, m]);
    if (months[0][0] > lastYear) break;
    let stop = false;
    for (const [y, m] of months) {
      if (r.bymonth && !r.bymonth.includes(m)) continue;
      const days: number[] = [];
      if (r.bymonthday || r.byweekday) {
        for (let d = 1; d <= daysInMonth(y, m); d++)
          if (fits(y, m, d)) days.push(d);
      } else days.push(Math.min(sd, daysInMonth(y, m)));
      for (const d of days)
        if (!take(ymd(y, m, d))) {
          stop = true;
          break;
        }
      if (stop) break;
    }
    if (stop) break;
  }
  return out;
}

export interface CalendarOccurrence {
  event: CalendarEvent;
  /** Its local date in the calendar's zone. */
  date: string;
  start: number;
  /** Exclusive; an all-day occurrence ends at the next local midnight. */
  end?: number;
  /** When it is due: its `due`, or `due_offset_days` after its date, at the
   * end of that local day. */
  due?: number;
  /** Its position among the event's occurrences in the range, from 0. */
  index: number;
}

/** An event's first local date (a recurrence's first that fits its rule),
 * or undefined if it never occurs. */
function firstOccurrenceDate(
  event: CalendarEvent,
  timeZone: string,
): string | undefined {
  const start = DATE.test(event.start)
    ? event.start
    : calendarLocalDate(calendarInstant(event.start, timeZone), timeZone);
  return occurrenceDates(event, timeZone, start, "9999-12-31", 1)[0];
}

/** Whole days from one date to another. */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return dayNumber(ty, tm, td) - dayNumber(fy, fm, fd);
}

/**
 * Every occurrence that overlaps [fromMs, toMs), across all events, in time
 * order. Recurring events are expanded here, for display.
 */
export function calendarOccurrences(
  calendar: CocalcCalendar,
  fromMs: number,
  toMs: number,
): CalendarOccurrence[] {
  const tz = calendar.timezone;
  const lastDate = calendarLocalDate(toMs, tz);
  const rangeStart = calendarLocalDate(fromMs, tz);
  const out: CalendarOccurrence[] = [];
  for (const event of calendar.events) {
    const allDay = event.all_day === true;
    const startMs = calendarInstant(event.start, tz);
    const p = zonedParts(startMs, tz);
    // An all-day event lasts whole local days (by date, whatever DST does);
    // a timed one, a fixed time.
    const allDaySpan =
      allDay && event.end != null ? daysBetween(event.start, event.end) : 0;
    const duration =
      !allDay && event.end != null
        ? calendarInstant(event.end, tz) - startMs
        : undefined;
    // Early enough for an occurrence that began before the range and lasts
    // into it: a day, plus the event's own length.
    const fromDate = addDays(
      rangeStart,
      -1 - allDaySpan - Math.ceil((duration ?? 0) / DAY_MS),
    );
    const endOfDay = (date: string) => {
      const [y, m, d] = date.split("-").map(Number);
      return zonedMs(y, m, d + 1, 0, 0, 0, tz) - 1;
    };
    const fixedDue =
      event.due == null
        ? undefined
        : DATE.test(event.due)
          ? endOfDay(event.due)
          : calendarInstant(event.due, tz);
    occurrenceDates(event, tz, fromDate, lastDate).forEach((date, index) => {
      const [y, m, d] = date.split("-").map(Number);
      // A one-off keeps its exact instant (in a repeated DST hour its wall
      // clock time names two); a recurrence repeats the local time of day.
      const start = allDay
        ? zonedMs(y, m, d, 0, 0, 0, tz)
        : event.recurrence
          ? zonedMs(y, m, d, p.hour, p.minute, p.second, tz)
          : startMs;
      const end = allDay
        ? zonedMs(y, m, d + 1 + allDaySpan, 0, 0, 0, tz)
        : duration != null
          ? start + duration
          : undefined;
      if ((end ?? start + 1) <= fromMs || start >= toMs) return;
      const due =
        event.due_offset_days != null
          ? endOfDay(addDays(date, event.due_offset_days))
          : event.recurrence
            ? undefined
            : fixedDue;
      out.push({
        event,
        date,
        start,
        ...(end != null ? { end } : {}),
        ...(due != null ? { due } : {}),
        index,
      });
    });
  }
  return out.sort(
    (a, b) => a.start - b.start || a.event.title.localeCompare(b.event.title),
  );
}

/**
 * Past due and not done or cancelled. An occurrence with no due date is
 * overdue only if the event is "pending" and its time has passed.
 */
export function isOverdue(o: CalendarOccurrence, nowMs: number): boolean {
  const status = o.event.status;
  if (status === "done" || status === "cancelled") return false;
  if (o.due != null) return o.due < nowMs;
  if (o.event.recurrence || status !== "pending") return false;
  return (o.end ?? o.start) < nowMs;
}

// --- iCalendar ------------------------------------------------------------

function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

const encoder = new TextEncoder();
/** Lines folded at 75 octets, as RFC 5545 asks (never inside a character). */
function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  // By code point, so a character (an emoji's surrogate pair too) is never
  // split.
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
      limit = 74; // continuation lines start with a space
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

function icsUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function icsLocal(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${ymd(p.year, p.month, p.day).replace(/-/g, "")}T${two(p.hour)}${two(p.minute)}${two(p.second)}`;
}

/** A short, stable hash (FNV-1a, 32 bits) in base 36. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The calendar (or one event of it) as an iCalendar file, for Google, Apple
 * or Outlook calendars. Recurrences become RRULEs; Markdown details become
 * the description as written.
 */
export function calendarToIcs(
  calendar: CocalcCalendar,
  {
    eventId,
    nowMs = Date.now(),
    uidDomain = "calendar.cocalc.com",
  }: { eventId?: string; nowMs?: number; uidDomain?: string } = {},
): string {
  const tz = calendar.timezone;
  const namespace = calendar.id ?? `t${fnv1a(calendar.title)}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CoCalc//Calendar//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsText(calendar.title)}`,
    `X-WR-TIMEZONE:${tz}`,
  ];
  for (const e of calendar.events) {
    if (eventId != null && e.id !== eventId) continue;
    const allDay = e.all_day === true;
    // A recurrence's DTSTART is its first instance in iCalendar: the first
    // date that fits its rule, as the agenda shows it (not a declared start
    // the rule skips). One that never occurs is left out, as in the agenda.
    let shift = 0;
    if (e.recurrence) {
      const startDate = DATE.test(e.start)
        ? e.start
        : calendarLocalDate(calendarInstant(e.start, tz), tz);
      const firstDate = firstOccurrenceDate(e, tz);
      if (firstDate == null) continue;
      shift = daysBetween(startDate, firstDate);
    }
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}.${namespace}@${uidDomain}`,
      `DTSTAMP:${icsUtc(nowMs)}`,
    );
    if (allDay) {
      lines.push(
        `DTSTART;VALUE=DATE:${addDays(e.start, shift).replace(/-/g, "")}`,
      );
      // An all-day DTEND is exclusive: the day after the last day.
      lines.push(
        `DTEND;VALUE=DATE:${addDays(e.end ?? e.start, 1 + shift).replace(/-/g, "")}`,
      );
    } else if (calendarTimeKind(e.start) === "zoned" && !e.recurrence) {
      // A fixed instant. A recurring one repeats the calendar zone's local
      // time of its first instant (as the agenda does), so it is written
      // as that local time below.
      lines.push(`DTSTART:${icsUtc(Date.parse(e.start))}`);
      if (e.end) lines.push(`DTEND:${icsUtc(calendarInstant(e.end, tz))}`);
    } else {
      // The same local time of day, `shift` days on.
      const startMs = calendarInstant(e.start, tz);
      const p = zonedParts(startMs, tz);
      const [y, m, d] = calendarLocalDate(startMs, tz).split("-").map(Number);
      const first = zonedMs(y, m, d + shift, p.hour, p.minute, p.second, tz);
      lines.push(`DTSTART;TZID=${tz}:${icsLocal(first, tz)}`);
      if (e.end)
        lines.push(
          `DTEND;TZID=${tz}:${icsLocal(first + calendarInstant(e.end, tz) - startMs, tz)}`,
        );
    }
    const r = e.recurrence;
    if (r) {
      const startDate = DATE.test(e.start)
        ? e.start
        : calendarLocalDate(calendarInstant(e.start, tz), tz);
      const monthEnd = monthEndRule(r, startDate);
      const parts: string[] = [];
      if (monthEnd.kind === "setpos") {
        parts.push(`FREQ=${monthEnd.freq}`);
        // A yearly rule written monthly runs every year: interval is 1.
        if (r.interval && monthEnd.freq === r.freq.toUpperCase())
          parts.push(`INTERVAL=${r.interval}`);
        if (monthEnd.bymonth)
          parts.push(`BYMONTH=${monthEnd.bymonth.join(",")}`);
        parts.push(`BYMONTHDAY=${monthEnd.bymonthday.join(",")}`);
        parts.push(`BYSETPOS=${monthEnd.bysetpos.join(",")}`);
      } else {
        parts.push(`FREQ=${r.freq.toUpperCase()}`);
        if (r.interval) parts.push(`INTERVAL=${r.interval}`);
        // A yearly rule's days are picked in its start's month, unless it
        // names months; in iCalendar they would be picked all year.
        const bymonth =
          r.bymonth ??
          (r.freq === "yearly" && (r.bymonthday || r.byweekday)
            ? [+startDate.slice(5, 7)]
            : undefined);
        if (bymonth) parts.push(`BYMONTH=${bymonth.join(",")}`);
        if (r.bymonthday) parts.push(`BYMONTHDAY=${r.bymonthday.join(",")}`);
        if (r.byweekday) parts.push(`BYDAY=${r.byweekday.join(",")}`);
        // Weeks are counted from the start's weekday, here and in iCalendar.
        if (r.freq === "weekly" && (r.interval ?? 1) > 1)
          parts.push(
            `WKST=${WEEKDAYS[new Date(`${startDate}T12:00:00Z`).getUTCDay()]}`,
          );
      }
      if (r.count) parts.push(`COUNT=${r.count}`);
      if (r.until)
        parts.push(
          `UNTIL=${
            allDay
              ? r.until.replace(/-/g, "")
              : icsUtc(calendarInstant(addDays(r.until, 1), tz) - 1000)
          }`,
        );
      lines.push(`RRULE:${parts.join(";")}`);
    }
    lines.push(`SUMMARY:${icsText(e.title)}`);
    const description = [
      e.details,
      e.due
        ? `Due: ${e.due}`
        : e.due_offset_days != null
          ? `Due ${e.due_offset_days} days after each date.`
          : "",
      e.owner ? `Owner: ${e.owner}` : "",
      ...(e.links ?? []).map((l) => `${l.label}: ${l.url}`),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (description) lines.push(`DESCRIPTION:${icsText(description)}`);
    const category = e.category ? calendar.categories?.[e.category] : undefined;
    if (category) lines.push(`CATEGORIES:${icsText(category.label)}`);
    if (e.status === "cancelled") lines.push("STATUS:CANCELLED");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// --- Agenda -----------------------------------------------------------------

export interface CalendarAgenda {
  /** Past due and not done, oldest first (looked for `pastDays` back). */
  overdue: CalendarOccurrence[];
  /** What is on or still to come, by local date in the calendar's zone. */
  days: { date: string; occurrences: CalendarOccurrence[] }[];
}

/**
 * What an agenda view shows at `nowMs`: overdue items first, then the next
 * `days` days, grouped by date. An occurrence counts once, overdue or not.
 */
export function calendarAgenda(
  calendar: CocalcCalendar,
  nowMs: number,
  { days = 60, pastDays = 90 }: { days?: number; pastDays?: number } = {},
): CalendarAgenda {
  // Overdue history goes by when things were due: look back far enough for
  // an occurrence that started long before its deadline.
  const tz = calendar.timezone;
  let dueReach = 0;
  for (const e of calendar.events) {
    if (e.due_offset_days != null)
      dueReach = Math.max(dueReach, (e.due_offset_days + 1) * DAY_MS);
    else if (e.due != null && !e.recurrence)
      dueReach = Math.max(
        dueReach,
        calendarInstant(e.due, tz) - calendarInstant(e.start, tz) + DAY_MS,
      );
  }
  const historyStart = nowMs - pastDays * DAY_MS;
  const occurrences = calendarOccurrences(
    calendar,
    historyStart - dueReach,
    nowMs + days * DAY_MS,
  );
  const overdue: CalendarOccurrence[] = [];
  const byDate = new Map<string, CalendarOccurrence[]>();
  for (const o of occurrences) {
    if (isOverdue(o, nowMs)) {
      if ((o.due ?? o.end ?? o.start) >= historyStart) overdue.push(o);
    } else if (
      // Still to come or running, or not yet due: a pending item stays in
      // view until its deadline, not just its start.
      (o.end ?? o.start + 1) > nowMs ||
      (o.due != null &&
        o.due >= nowMs &&
        o.event.status !== "done" &&
        o.event.status !== "cancelled")
    ) {
      const list = byDate.get(o.date) ?? [];
      list.push(o);
      byDate.set(o.date, list);
    }
  }
  return {
    overdue,
    days: [...byDate.entries()].map(([date, occurrences]) => ({
      date,
      occurrences,
    })),
  };
}
