/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  calendarAgenda,
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

describe("long-running recurrences", () => {
  const recurring = (recurrence: object, start = "1990-01-01", n = 1) =>
    calendarOf({
      format: "cocalc-calendar",
      version: 1,
      title: "Long",
      timezone: "America/Los_Angeles",
      default_view: "agenda",
      events: Array.from({ length: n }, (_, i) => ({
        id: `e${i}`,
        title: "Long",
        start: `${start}T09:00`,
        recurrence,
      })),
    });
  const datesIn2026 = (cal) =>
    calendarOccurrences(
      cal,
      Date.parse("2026-10-01T00:00:00Z"),
      Date.parse("2026-11-01T00:00:00Z"),
    ).map((o) => o.date);
  // Whole days from 1990-01-01, by UTC dates.
  const daysSince = (date: string) =>
    (Date.parse(`${date}T00:00:00Z`) - Date.parse("1990-01-01T00:00:00Z")) /
    86_400_000;

  it("starting at the requested range keeps every interval's phase", () => {
    const every3 = datesIn2026(recurring({ freq: "daily", interval: 3 }));
    expect(every3.length).toBeGreaterThan(9);
    expect(every3.every((d) => daysSince(d) % 3 === 0)).toBe(true);
    const weekly = datesIn2026(
      recurring({ freq: "weekly", interval: 2, byweekday: ["MO", "TH"] }),
    );
    // 1990-01-01 was a Monday: weeks counted from it, every other one.
    expect(weekly.length).toBeGreaterThan(3);
    for (const d of weekly) {
      expect(Math.floor(daysSince(d) / 7) % 2).toBe(0);
      expect(["MO", "TH"]).toContain(
        ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][
          new Date(`${d}T12:00:00Z`).getUTCDay()
        ],
      );
    }
  });

  it("a count still counts from the start", () => {
    // 100 days from Jan 1, 1990: over long before 2026.
    expect(datesIn2026(recurring({ freq: "daily", count: 100 }))).toEqual([]);
    const occ = calendarOccurrences(
      recurring({ freq: "daily", interval: 2, count: 3 }),
      Date.parse("1990-01-01T00:00:00Z"),
      Date.parse("1990-02-01T00:00:00Z"),
    ).map((o) => o.date);
    expect(occ).toEqual(["1990-01-01", "1990-01-03", "1990-01-05"]);
  });

  it("is quick for many events that began long ago", () => {
    const cal = recurring({ freq: "daily" }, "1900-01-01", 50);
    const started = Date.now();
    const agenda = calendarAgenda(cal, Date.parse("2026-10-21T15:00:00Z")); // 8 am
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(agenda.days[0].date).toBe("2026-10-21");
    expect(agenda.days[0].occurrences).toHaveLength(50);
  });

  it("is expanded at most 200 years after its start", () => {
    expect(datesIn2026(recurring({ freq: "daily" }, "1800-01-01"))).toEqual([]);
    expect(datesIn2026(recurring({ freq: "monthly" }, "1800-01-01"))).toEqual(
      [],
    );
  });
});

describe("the agenda", () => {
  const cal = calendarOf(ACCOUNTING);
  // Dec 19, 4 pm in Seattle.
  const now = Date.parse("2026-12-20T00:00:00Z");

  it("puts overdue items first, then what is to come by day, each once", () => {
    const agenda = calendarAgenda(cal, now);
    // The withdrawal was due Dec 16; the pending wire check was Oct 28.
    expect(agenda.overdue.map((o) => o.event.id)).toEqual([
      "oss-q3-wire",
      "oss-withdrawal",
    ]);
    expect(agenda.days[0]).toMatchObject({
      date: "2026-12-21",
      occurrences: [{ event: { id: "vanta-renewal" } }],
    });
    // In date order, and the next 60 days only.
    const dates = agenda.days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
    expect(dates.at(-1)! <= "2027-02-17").toBe(true);
    const shown = [
      ...agenda.overdue,
      ...agenda.days.flatMap((d) => d.occurrences),
    ].map((o) => `${o.event.id}@${o.date}`);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it("an item that started long ago is overdue once its deadline passes", () => {
    const late = calendarOf({
      ...ACCOUNTING,
      events: [
        {
          id: "slow",
          title: "Slow",
          start: "2026-01-01",
          all_day: true,
          due_offset_days: 300,
          status: "pending",
        },
        {
          id: "fixed",
          title: "Fixed",
          start: "2026-01-02",
          all_day: true,
          due: "2026-10-30",
          status: "pending",
        },
      ],
    });
    // Due Oct 28 and Oct 30; started 10 months before.
    expect(
      calendarAgenda(late, Date.parse("2026-11-01T19:00:00Z")).overdue.map(
        (o) => o.event.id,
      ),
    ).toEqual(["slow", "fixed"]);
    // Due more than 90 days ago: no longer listed.
    expect(
      calendarAgenda(late, Date.parse("2027-03-01T19:00:00Z")).overdue,
    ).toEqual([]);
  });

  it("a past item that is done, or not due, is not shown again", () => {
    const done = calendarOf({
      ...ACCOUNTING,
      events: ACCOUNTING.events.map((e: any) =>
        e.id === "oss-withdrawal" ? { ...e, status: "done" } : e,
      ),
    });
    expect(calendarAgenda(done, now).overdue.map((o) => o.event.id)).toEqual([
      "oss-q3-wire",
    ]);
    // November's close is past and was never due: gone.
    expect(
      calendarAgenda(cal, now)
        .days.flatMap((d) => d.occurrences)
        .some((o) => o.date === "2026-12-03"),
    ).toBe(false);
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

  it("names each calendar's events apart, and keeps an offset recurrence local", () => {
    const one = (extra: object, events: object[]) =>
      calendarToIcs(
        calendarOf({
          format: "cocalc-calendar",
          version: 1,
          title: "A",
          timezone: "America/Los_Angeles",
          default_view: "agenda",
          ...extra,
          events,
        }),
        { nowMs: 0 },
      ).replace(/\r\n /g, "");
    const event = {
      id: "quarterly",
      title: "Q",
      start: "2027-01-06",
      all_day: true,
    };
    const uid = (ics: string) => /UID:(.*)/.exec(ics)![1];
    // The same event id in two calendars: two UIDs.
    expect(uid(one({}, [event]))).not.toBe(uid(one({ title: "B" }, [event])));
    // A calendar's own id names it, whatever its title.
    expect(uid(one({ id: "taxes" }, [event]))).toBe(
      "quarterly.taxes@calendar.cocalc.com",
    );
    expect(uid(one({ id: "taxes", title: "Renamed" }, [event]))).toBe(
      "quarterly.taxes@calendar.cocalc.com",
    );
    expect(
      parseCalendar(text({ ...ACCOUNTING, id: "no spaces" })).problems,
    ).toEqual([
      { path: "id", message: "must be 1 to 100 letters, digits or _ . : -" },
    ]);
    // A recurring start with an offset repeats Seattle's 08:30, as the
    // agenda shows it, across DST; a one-off is that instant.
    const offset = { id: "o", title: "O", start: "2026-11-03T08:30-08:00" };
    expect(one({}, [{ ...offset, recurrence: { freq: "monthly" } }])).toContain(
      "DTSTART;TZID=America/Los_Angeles:20261103T083000",
    );
    expect(one({}, [offset])).toContain("DTSTART:20261103T163000Z");
  });

  const single = (events: object[]) =>
    calendarOf({
      format: "cocalc-calendar",
      version: 1,
      title: "S",
      timezone: "America/Los_Angeles",
      default_view: "agenda",
      events,
    });

  it("never splits a character when folding, an emoji included", () => {
    // SUMMARY: is 8 octets; the emoji (4) starts at octet 72 of 75, where
    // its first half alone would fit.
    const title = "a".repeat(64) + "\u{1F600}" + "b".repeat(80);
    const ics = calendarToIcs(
      single([{ id: "e", title, start: "2027-01-01", all_day: true }]),
      { nowMs: 0 },
    );
    expect(ics).not.toContain("\uFFFD");
    const encoder = new TextEncoder();
    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
      // No lone surrogate at either end of a line.
      expect(line).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    expect(ics.replace(/\r\n /g, "")).toContain(`SUMMARY:${title}`);
  });

  it("a recurrence's DTSTART is its first instance, as the agenda shows", () => {
    const rule = { freq: "monthly", bymonthday: [15] };
    const allDay = single([
      {
        id: "a",
        title: "A",
        start: "2027-01-01",
        all_day: true,
        recurrence: rule,
      },
    ]);
    expect(
      calendarOccurrences(
        allDay,
        Date.parse("2027-01-01T08:00:00Z"),
        Date.parse("2027-02-01T08:00:00Z"),
      ).map((o) => o.date),
    ).toEqual(["2027-01-15"]);
    const ics = calendarToIcs(allDay, { nowMs: 0 });
    expect(ics).toContain("DTSTART;VALUE=DATE:20270115");
    expect(ics).toContain("DTEND;VALUE=DATE:20270116");
    expect(
      calendarToIcs(
        single([
          { id: "t", title: "T", start: "2027-01-01T09:00", recurrence: rule },
        ]),
        { nowMs: 0 },
      ),
    ).toContain("DTSTART;TZID=America/Los_Angeles:20270115T090000");
  });

  it("an all-day event ends at local midnight after its last day, across DST", () => {
    // DST starts in Seattle on March 14, 2027.
    const [o] = calendarOccurrences(
      single([
        {
          id: "s",
          title: "Spring",
          start: "2027-03-13",
          end: "2027-03-14",
          all_day: true,
        },
      ]),
      Date.parse("2027-03-01T00:00:00Z"),
      Date.parse("2027-04-01T00:00:00Z"),
    );
    expect(iso(o.end!)).toBe("2027-03-15T07:00:00.000Z");
  });

  it("a one-off with an offset is its exact instant, in a repeated DST hour too", () => {
    // 01:30 happens twice in Seattle on Nov 1, 2026; -08:00 is the second.
    const [o] = calendarOccurrences(
      single([{ id: "o", title: "O", start: "2026-11-01T01:30-08:00" }]),
      Date.parse("2026-11-01T00:00:00Z"),
      Date.parse("2026-11-02T00:00:00Z"),
    );
    expect(iso(o.start)).toBe("2026-11-01T09:30:00.000Z");
  });

  it("a recurring event's deadline is due_offset_days, not a fixed due", () => {
    const parsed = parseCalendar(
      text({
        format: "cocalc-calendar",
        version: 1,
        title: "S",
        timezone: "America/Los_Angeles",
        default_view: "agenda",
        events: [
          {
            id: "r",
            title: "R",
            start: "2027-01-06",
            all_day: true,
            due: "2027-01-31",
            recurrence: { freq: "monthly" },
          },
        ],
      }),
    );
    expect(parsed.problems).toEqual([
      {
        path: "events[0].due",
        message: "a recurring event uses due_offset_days instead",
      },
    ]);
  });

  it("an event has one deadline: due or due_offset_days", () => {
    const parsed = parseCalendar(
      text({
        format: "cocalc-calendar",
        version: 1,
        title: "S",
        timezone: "America/Los_Angeles",
        default_view: "agenda",
        events: [
          {
            id: "b",
            title: "B",
            start: "2027-01-06",
            all_day: true,
            due: "2027-01-31",
            due_offset_days: 5,
          },
        ],
      }),
    );
    expect(parsed.problems).toEqual([
      {
        path: "events[0].due",
        message: "use either due or due_offset_days, not both",
      },
    ]);
  });

  it("a time the clocks skip moves forward across the gap, consistently", () => {
    // 02:30 does not exist in Seattle on March 14, 2027: it is 03:30 PDT.
    const cal = single([
      {
        id: "g",
        title: "Gap",
        start: "2027-03-14T02:30",
        recurrence: { freq: "daily", count: 2 },
      },
    ]);
    const [first, second] = calendarOccurrences(
      cal,
      Date.parse("2027-03-14T00:00:00Z"),
      Date.parse("2027-03-16T00:00:00Z"),
    );
    expect(iso(first.start)).toBe("2027-03-14T10:30:00.000Z");
    expect(iso(second.start)).toBe("2027-03-15T10:30:00.000Z");
    expect(calendarToIcs(cal, { nowMs: 0 })).toContain(
      "DTSTART;TZID=America/Los_Angeles:20270314T033000",
    );
    // An ordinary time, and the repeated fall-back hour's first 01:30.
    const at = (start: string) =>
      iso(
        calendarOccurrences(
          single([{ id: "t", title: "T", start }]),
          Date.parse("2026-01-01T00:00:00Z"),
          Date.parse("2028-01-01T00:00:00Z"),
        )[0].start,
      );
    expect(at("2027-07-01T09:00")).toBe("2027-07-01T16:00:00.000Z");
    expect(at("2026-11-01T01:30")).toBe("2026-11-01T08:30:00.000Z");
  });

  it("finds a long recurring occurrence that began before the range", () => {
    const week = single([
      {
        id: "w",
        title: "Conference week",
        start: "2026-10-05",
        end: "2026-10-09",
        all_day: true,
        recurrence: { freq: "monthly" },
      },
    ]);
    // October 8: the occurrence from October 5 is still on.
    expect(
      calendarOccurrences(
        week,
        Date.parse("2026-10-08T19:00:00Z"),
        Date.parse("2026-10-09T19:00:00Z"),
      ).map((o) => o.date),
    ).toEqual(["2026-10-05"]);
  });

  it("month-end days export as iCalendar's last-of-range, as the agenda shows", () => {
    const rrule = (start: string, recurrence: object) =>
      /RRULE:(.*)/.exec(
        calendarToIcs(
          single([{ id: "m", title: "M", start, all_day: true, recurrence }]),
          { nowMs: 0 },
        ),
      )![1];
    const jan31 = single([
      {
        id: "m",
        title: "M",
        start: "2027-01-31",
        all_day: true,
        recurrence: { freq: "monthly" },
      },
    ]);
    // The agenda: the 31st, or the month's last day.
    expect(
      calendarOccurrences(
        jan31,
        Date.parse("2027-01-01T08:00:00Z"),
        Date.parse("2027-05-01T08:00:00Z"),
      ).map((o) => o.date),
    ).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    // The export: the last of the 28th..31st that each month has.
    expect(rrule("2027-01-31", { freq: "monthly" })).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1",
    );
    // The 30th: Feb 28 (29 in leap years), else the 30th.
    expect(rrule("2027-01-30", { freq: "monthly", interval: 2 })).toBe(
      "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=28,29,30;BYSETPOS=-1",
    );
    // Other days keep their positions.
    expect(
      rrule("2027-01-15", { freq: "monthly", bymonthday: [15, 1, 31] }),
    ).toBe("FREQ=MONTHLY;BYMONTHDAY=1,15,28,29,30,31;BYSETPOS=1,2,-1");
    // Feb 29 each year: Feb 28 in other years.
    expect(rrule("2028-02-29", { freq: "yearly" })).toBe(
      "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1",
    );
    // Several months, every year: per month.
    expect(
      rrule("2027-01-31", {
        freq: "yearly",
        bymonth: [1, 2],
        bymonthday: [31],
      }),
    ).toBe("FREQ=MONTHLY;BYMONTH=1,2;BYMONTHDAY=28,29,30,31;BYSETPOS=-1");
    // Up to the 28th: written as is.
    expect(rrule("2027-01-28", { freq: "monthly" })).toBe("FREQ=MONTHLY");
  });

  it("refuses month-end rules iCalendar cannot write exactly", () => {
    const problems = (recurrence: object, start = "2027-01-31") =>
      parseCalendar(
        text({
          format: "cocalc-calendar",
          version: 1,
          title: "S",
          timezone: "America/Los_Angeles",
          default_view: "agenda",
          events: [{ id: "m", title: "M", start, all_day: true, recurrence }],
        }),
      ).problems.map((p) => p.path);
    expect(problems({ freq: "monthly", bymonthday: [30, 31] })).toEqual([
      "events[0].recurrence.bymonthday",
    ]);
    expect(
      problems({ freq: "monthly", bymonthday: [31], byweekday: ["FR"] }),
    ).toEqual(["events[0].recurrence.bymonthday"]);
    expect(problems({ freq: "yearly", interval: 2, bymonth: [1, 3] })).toEqual([
      "events[0].recurrence.bymonthday",
    ]);
    expect(problems({ freq: "yearly", interval: 2 })).toEqual([]);
  });

  it("escapes every line break in text, a lone carriage return too", () => {
    const ics = calendarToIcs(
      single([
        { id: "e", title: "a\rb\nc\r\nd", start: "2027-01-01", all_day: true },
      ]),
      { nowMs: 0 },
    );
    expect(ics).toContain("SUMMARY:a\\nb\\nc\\nd");
    // Only CRLF line ends: no CR or LF anywhere else.
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("exports rules that pick the same days in calendar apps", () => {
    const rrule = (start: string, recurrence: object) =>
      /RRULE:(.*)/.exec(
        calendarToIcs(
          single([{ id: "r", title: "R", start, all_day: true, recurrence }]),
          { nowMs: 0 },
        ),
      )![1];
    // A yearly rule's days are in its start's month, not all year.
    expect(rrule("2027-01-04", { freq: "yearly", byweekday: ["MO"] })).toBe(
      "FREQ=YEARLY;BYMONTH=1;BYDAY=MO",
    );
    expect(rrule("2027-01-15", { freq: "yearly", bymonthday: [15] })).toBe(
      "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=15",
    );
    // Every other week, weeks counted from a Wednesday start, as the agenda.
    const biweekly = single([
      {
        id: "b",
        title: "B",
        start: "2027-01-06",
        all_day: true,
        recurrence: { freq: "weekly", interval: 2, byweekday: ["MO", "FR"] },
      },
    ]);
    expect(
      calendarOccurrences(
        biweekly,
        Date.parse("2027-01-01T08:00:00Z"),
        Date.parse("2027-01-27T08:00:00Z"),
      ).map((o) => o.date),
    ).toEqual(["2027-01-08", "2027-01-11", "2027-01-22", "2027-01-25"]);
    const ics = calendarToIcs(biweekly, { nowMs: 0 });
    expect(ics).toContain("DTSTART;VALUE=DATE:20270108");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;WKST=WE");
  });

  it("days of the month are for monthly and yearly rules only", () => {
    for (const freq of ["daily", "weekly"]) {
      const parsed = parseCalendar(
        text({
          format: "cocalc-calendar",
          version: 1,
          title: "S",
          timezone: "America/Los_Angeles",
          default_view: "agenda",
          events: [
            {
              id: "d",
              title: "D",
              start: "2027-01-01",
              all_day: true,
              recurrence: { freq, bymonthday: [31] },
            },
          ],
        }),
      );
      expect(parsed.problems).toEqual([
        {
          path: "events[0].recurrence.bymonthday",
          message: "is for monthly and yearly rules",
        },
      ]);
    }
  });

  it("exports one event alone", () => {
    const one = calendarToIcs(cal, { eventId: "delaware" });
    expect(one.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(one).toMatch(/UID:delaware\.t[0-9a-z]+@/);
  });
});
