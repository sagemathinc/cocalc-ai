/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  calendarOccurrences,
  calendarToIcs,
  isOverdue,
  parseCalendar,
} from "./cocalc-calendar";

// @accounting's real tax calendar (Oct 2026), the example the format was
// designed from.
const ACCOUNTING = {
  format: "cocalc-calendar",
  version: 1,
  title: "SageMath, Inc. accounting and tax calendar",
  description: "Deadlines tracked by @accounting. Click an event for details.",
  timezone: "America/Los_Angeles",
  default_view: "agenda",
  categories: {
    tax: {
      label: "Tax filing",
      color: "#d9480f",
    },
    close: {
      label: "Bookkeeping",
      color: "#1971c2",
    },
    corporate: {
      label: "Corporate",
      color: "#2f9e44",
    },
  },
  events: [
    {
      id: "oss-q3-wire",
      title: "Check Q3 EU OSS payment (wire to Ireland)",
      start: "2026-10-28T09:30",
      category: "tax",
      status: "pending",
      owner: "@accounting",
      details:
        "Ireland's ROS should have sent the payment message for the **Q3 2026 Non-Union OSS** return (about €260). Confirm the wire went out and book it in Digits as VAT payable.",
      links: [
        {
          label: "ROS",
          url: "https://ros.ie",
        },
      ],
      sensor_id: "7e295424-e056-47d7-989a-a37f350de663",
    },
    {
      id: "month-close",
      title: "Month-end close",
      start: "2026-11-03T08:30",
      recurrence: {
        freq: "monthly",
        bymonthday: [3],
      },
      category: "close",
      status: "scheduled",
      owner: "@accounting",
      details:
        "Reconcile checking, savings and both cards in Digits; check prepaid releases; run the Stripe vs CoCalc revenue checks; update the cash forecast.",
    },
    {
      id: "oss-withdrawal",
      title: "Confirm EU OSS withdrawal submitted",
      start: "2026-12-01",
      all_day: true,
      due: "2026-12-16",
      category: "tax",
      status: "pending",
      details:
        "The withdrawal must reach Revenue at least 15 days before the quarter ends to take effect Jan 1, 2027.",
    },
    {
      id: "vanta-renewal",
      title: "Book the Vanta renewal as a prepaid expense",
      start: "2026-12-21",
      all_day: true,
      category: "close",
      details:
        "Annual renewal around Dec 19, about $20.8K. Book it to Liabilities / Subscriptions / Professional Fees / Vanta and import a 12-month release schedule.",
    },
    {
      id: "oss-q4-final",
      title: "File and pay the FINAL Q4 2026 EU OSS return",
      start: "2027-01-04",
      all_day: true,
      due: "2027-01-31",
      category: "tax",
      status: "pending",
      details:
        "Likely under $25. Per-country EUR figures come from Stripe tax liabilities, pulled with the read-only key.",
    },
    {
      id: "lni-quarterly",
      title: "WA L&I quarterly report",
      start: "2027-01-06",
      all_day: true,
      recurrence: {
        freq: "monthly",
        bymonth: [1, 4, 7, 10],
        bymonthday: [6],
      },
      due_offset_days: 25,
      category: "tax",
      details:
        "Gross payroll and worker hours from the QuickBooks payroll worksheet; file at secure.lni.wa.gov.",
    },
    {
      id: "1099-nec",
      title: "1099-NEC forms due",
      start: "2027-01-31",
      all_day: true,
      category: "tax",
    },
    {
      id: "delaware",
      title: "Delaware annual report and franchise tax",
      start: "2027-03-01",
      all_day: true,
      category: "corporate",
      details:
        "About $400 + $50. Enter assets as an INTEGER. Save the confirmation PDF.",
    },
  ],
};

const text = (value: unknown) => JSON.stringify(value);
const calendarOf = (value: unknown) => {
  const parsed = parseCalendar(text(value));
  if (!parsed.calendar) throw new Error(JSON.stringify(parsed.problems));
  return parsed.calendar;
};
const minimal = (events: unknown[], extra = {}) => ({
  format: "cocalc-calendar",
  version: 1,
  title: "T",
  timezone: "America/Los_Angeles",
  events,
  ...extra,
});
const iso = (ms: number) => new Date(ms).toISOString();

describe("reading a calendar", () => {
  it("reads the accounting calendar with no problems", () => {
    const parsed = parseCalendar(text(ACCOUNTING));
    expect(parsed.problems).toEqual([]);
    expect(parsed.ok).toBe(true);
    expect(parsed.calendar!.events).toHaveLength(ACCOUNTING.events.length);
    expect(
      parsed.calendar!.events.find((e) => e.id === "delaware"),
    ).toMatchObject({
      all_day: true,
      category: "corporate",
    });
  });

  it("names every problem, and still shows the events that are fine", () => {
    const parsed = parseCalendar(
      text(
        minimal(
          [
            { id: "ok", title: "Fine", start: "2027-01-31" },
            { id: "ok", title: "Twice", start: "2027-02-01" },
            { id: "bad-start", title: "X", start: "Jan 31" },
            { id: "bad-day", title: "X", start: "2027-02-30" },
            {
              id: "bad-link",
              title: "X",
              start: "2027-01-31",
              links: [{ label: "x", url: "javascript:alert(1)" }],
            },
            {
              id: "bad-cat",
              title: "X",
              start: "2027-01-31",
              category: "nope",
            },
            {
              id: "bad-rule",
              title: "X",
              start: "2027-01-31",
              recurrence: { freq: "hourly" },
            },
            {
              id: "end-first",
              title: "X",
              start: "2027-01-31T10:00",
              end: "2027-01-31T09:00",
            },
          ],
          { default_view: "year" },
        ),
      ),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.map((p) => p.path)).toEqual([
      "default_view",
      "events[1].id",
      "events[2].start",
      "events[3].start",
      "events[4].links[0]",
      "events[5].category",
      "events[6].recurrence.freq",
      "events[7].end",
    ]);
    // Shown: the fine one, and those whose problem was only a detail.
    expect(parsed.calendar!.events.map((e) => e.id)).toEqual([
      "ok",
      "bad-link",
      "bad-cat",
      "end-first",
    ]);
    // A bad link is dropped, not shown.
    expect(parsed.calendar!.events[1].links).toBeUndefined();
  });

  it("refuses what is not a calendar at all", () => {
    expect(parseCalendar("{").calendar).toBeUndefined();
    expect(parseCalendar(text({ format: "x" })).calendar).toBeUndefined();
    expect(
      parseCalendar(text({ ...minimal([]), timezone: "Mars/Olympus" }))
        .problems[0],
    ).toMatchObject({ path: "timezone" });
  });
});

describe("occurrences", () => {
  const cal = calendarOf(ACCOUNTING);
  const range = (from: string, to: string) =>
    calendarOccurrences(cal, Date.parse(from), Date.parse(to));

  it("expands a monthly event on its day, at its local time", () => {
    const closes = range("2026-10-01T00:00:00Z", "2027-02-01T00:00:00Z").filter(
      (o) => o.event.id === "month-close",
    );
    // 08:30 in Seattle: PST from November.
    expect(closes.map((o) => iso(o.start))).toEqual([
      "2026-11-03T16:30:00.000Z",
      "2026-12-03T16:30:00.000Z",
      "2027-01-03T16:30:00.000Z",
    ]);
  });

  it("expands a quarterly event, with each occurrence due its offset later", () => {
    const lni = range("2027-01-01T00:00:00Z", "2028-01-01T00:00:00Z").filter(
      (o) => o.event.id === "lni-quarterly",
    );
    expect(lni.map((o) => o.date)).toEqual([
      "2027-01-06",
      "2027-04-06",
      "2027-07-06",
      "2027-10-06",
    ]);
    // Due 25 days later, at the end of that day in Seattle (PST in January).
    expect(iso(lni[0].due!)).toBe("2027-02-01T07:59:59.999Z");
  });

  it("a fixed due date is due at the end of its day", () => {
    const o = range("2026-12-01T00:00:00Z", "2026-12-31T00:00:00Z").find(
      (o) => o.event.id === "oss-withdrawal",
    )!;
    expect(o.date).toBe("2026-12-01");
    expect(iso(o.due!)).toBe("2026-12-17T07:59:59.999Z");
  });

  it("is overdue once past due and not done", () => {
    const o = range("2026-12-01T00:00:00Z", "2026-12-31T00:00:00Z").find(
      (o) => o.event.id === "oss-withdrawal",
    )!;
    expect(isOverdue(o, Date.parse("2026-12-10T00:00:00Z"))).toBe(false);
    expect(isOverdue(o, Date.parse("2026-12-20T00:00:00Z"))).toBe(true);
    expect(
      isOverdue(
        { ...o, event: { ...o.event, status: "done" } },
        Date.parse("2026-12-20T00:00:00Z"),
      ),
    ).toBe(false);
    // A pending event with no due date: overdue once its time has passed.
    const wire = range("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z").find(
      (o) => o.event.id === "oss-q3-wire",
    )!;
    expect(isOverdue(wire, Date.parse("2026-10-28T20:00:00Z"))).toBe(true);
    // A scheduled one never is, without a due date.
    const close = range("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z").find(
      (o) => o.event.id === "month-close",
    )!;
    expect(isOverdue(close, Date.parse("2027-06-01T00:00:00Z"))).toBe(false);
  });

  it("a day past a month's end falls on its last day", () => {
    const c = calendarOf(
      minimal([
        {
          id: "e",
          title: "E",
          start: "2027-01-31",
          recurrence: { freq: "monthly" },
        },
      ]),
    );
    expect(
      calendarOccurrences(
        c,
        Date.parse("2027-01-01T00:00:00Z"),
        Date.parse("2027-05-01T00:00:00Z"),
      ).map((o) => o.date),
    ).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  });

  it("weekly on weekdays, every other week, until a date; and count", () => {
    const c = calendarOf(
      minimal([
        {
          id: "w",
          title: "Standup",
          start: "2026-11-02T09:00",
          recurrence: {
            freq: "weekly",
            interval: 2,
            byweekday: ["MO", "WE"],
            until: "2026-11-30",
          },
        },
        {
          id: "c",
          title: "Thrice",
          start: "2026-11-01",
          recurrence: { freq: "daily", count: 3 },
        },
      ]),
    );
    const os = calendarOccurrences(
      c,
      Date.parse("2026-10-01T00:00:00Z"),
      Date.parse("2027-01-01T00:00:00Z"),
    );
    expect(os.filter((o) => o.event.id === "w").map((o) => o.date)).toEqual([
      "2026-11-02",
      "2026-11-04",
      "2026-11-16",
      "2026-11-18",
      "2026-11-30",
    ]);
    expect(os.filter((o) => o.event.id === "c").map((o) => o.date)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
  });

  it("a long-running daily event still shows in a range years later", () => {
    const c = calendarOf(
      minimal([
        {
          id: "d",
          title: "Daily",
          start: "2020-01-01",
          recurrence: { freq: "daily" },
        },
      ]),
    );
    const os = calendarOccurrences(
      c,
      Date.parse("2027-03-10T12:00:00Z"),
      Date.parse("2027-03-13T12:00:00Z"),
    );
    expect(os.map((o) => o.date)).toContain("2027-03-12");
  });

  it("a time with an offset is that instant, wherever the calendar is", () => {
    const c = calendarOf(
      minimal([{ id: "z", title: "Z", start: "2026-11-05T09:00:00Z" }]),
    );
    expect(
      iso(
        calendarOccurrences(c, 0, Date.parse("2027-01-01T00:00:00Z"))[0].start,
      ),
    ).toBe("2026-11-05T09:00:00.000Z");
  });
});

describe("iCalendar export", () => {
  const cal = calendarOf(ACCOUNTING);
  const ics = calendarToIcs(cal, { nowMs: Date.parse("2026-10-21T00:00:00Z") });

  it("is a calendar of all the events, with CRLF lines of at most 75 octets", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(ACCOUNTING.events.length);
    for (const line of ics.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it("writes times in the calendar's zone, all-day dates, and recurrences", () => {
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(
      "DTSTART;TZID=America/Los_Angeles:20261103T083000",
    );
    expect(unfolded).toContain("RRULE:FREQ=MONTHLY;BYMONTHDAY=3");
    expect(unfolded).toContain("DTSTART;VALUE=DATE:20270301");
    expect(unfolded).toContain("DTEND;VALUE=DATE:20270302");
    expect(unfolded).toContain(
      "RRULE:FREQ=MONTHLY;BYMONTH=1,4,7,10;BYMONTHDAY=6",
    );
    expect(unfolded).toContain("SUMMARY:WA L&I quarterly report");
    // Commas and semicolons in text are escaped.
    expect(unfolded).toContain(
      "Reconcile checking\\, savings and both cards in Digits\\;",
    );
  });

  it("exports one event alone", () => {
    const one = calendarToIcs(cal, { eventId: "delaware" });
    expect(one.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(one).toContain("UID:delaware@");
  });
});
