import {
  describeSensorSchedule,
  nextSensorRunAt,
  validateSensorSchedule,
} from "./sensor-schedule";

const min15 = { minIntervalMinutes: 15 };

describe("validateSensorSchedule", () => {
  it("normalizes an interval and defaults to UTC", () => {
    expect(
      validateSensorSchedule({ kind: "interval", minutes: 30 }, min15),
    ).toEqual({ kind: "interval", minutes: 30, timezone: "UTC" });
  });

  it("enforces the tier minimum interval", () => {
    expect(() =>
      validateSensorSchedule({ kind: "interval", minutes: 5 }, min15),
    ).toThrow(/from 15/);
    expect(
      validateSensorSchedule(
        { kind: "interval", minutes: 5 },
        { minIntervalMinutes: 5 },
      ).kind,
    ).toBe("interval");
  });

  it("enforces the minimum between daily times, across midnight too", () => {
    expect(() =>
      validateSensorSchedule(
        { kind: "daily", times: ["09:00", "09:10"], timezone: "UTC" },
        min15,
      ),
    ).toThrow(/15 minutes apart/);
    expect(() =>
      validateSensorSchedule(
        { kind: "daily", times: ["23:55", "00:05"], timezone: "UTC" },
        min15,
      ),
    ).toThrow(/15 minutes apart/);
    expect(
      validateSensorSchedule(
        { kind: "daily", times: ["17:00", "9:00"], timezone: "UTC" },
        min15,
      ),
    ).toEqual({ kind: "daily", times: ["09:00", "17:00"], timezone: "UTC" });
  });

  it("refuses unknown fields, bad zones and bad windows", () => {
    expect(() =>
      validateSensorSchedule({ kind: "interval", minutes: 30, x: 1 }, min15),
    ).toThrow(/unknown schedule field/);
    expect(() =>
      validateSensorSchedule(
        { kind: "daily", times: ["09:00"], timezone: "Mars/Olympus" },
        min15,
      ),
    ).toThrow(/time zone/);
    expect(() =>
      validateSensorSchedule(
        {
          kind: "interval",
          minutes: 30,
          window: { start: "17:00", end: "09:00" },
        },
        min15,
      ),
    ).toThrow(/end after/);
    expect(() =>
      validateSensorSchedule({ kind: "cron", expr: "* * * * *" }, min15),
    ).toThrow(/kind/);
  });

  it("drops a days list that covers every day", () => {
    expect(
      validateSensorSchedule(
        { kind: "interval", minutes: 60, days: [6, 5, 4, 3, 2, 1, 0] },
        min15,
      ),
    ).toEqual({ kind: "interval", minutes: 60, timezone: "UTC" });
  });
});

describe("nextSensorRunAt", () => {
  const at = (iso: string) => Date.parse(iso);

  it("runs plain intervals on a fixed grid", () => {
    const s = validateSensorSchedule({ kind: "interval", minutes: 15 }, min15);
    expect(nextSensorRunAt(s, at("2026-10-10T14:07:12Z"))).toBe(
      at("2026-10-10T14:15:00Z"),
    );
    expect(nextSensorRunAt(s, at("2026-10-10T14:15:00Z"))).toBe(
      at("2026-10-10T14:30:00Z"),
    );
  });

  it("respects daily times in a time zone", () => {
    const s = validateSensorSchedule(
      { kind: "daily", times: ["07:00"], timezone: "America/Los_Angeles" },
      min15,
    );
    // 2026-10-10 is PDT (UTC-7).
    expect(nextSensorRunAt(s, at("2026-10-10T13:00:00Z"))).toBe(
      at("2026-10-10T14:00:00Z"),
    );
    expect(nextSensorRunAt(s, at("2026-10-10T15:00:00Z"))).toBe(
      at("2026-10-11T14:00:00Z"),
    );
  });

  it("skips disallowed weekdays and stays inside windows", () => {
    const s = validateSensorSchedule(
      {
        kind: "interval",
        minutes: 60,
        timezone: "UTC",
        days: [1, 2, 3, 4, 5],
        window: { start: "09:00", end: "17:00" },
      },
      min15,
    );
    // Saturday 2026-10-10 -> Monday 09:00.
    expect(nextSensorRunAt(s, at("2026-10-10T12:00:00Z"))).toBe(
      at("2026-10-12T09:00:00Z"),
    );
    expect(nextSensorRunAt(s, at("2026-10-12T16:30:00Z"))).toBe(
      at("2026-10-12T17:00:00Z"),
    );
    expect(nextSensorRunAt(s, at("2026-10-12T17:00:00Z"))).toBe(
      at("2026-10-13T09:00:00Z"),
    );
  });
});

describe("describeSensorSchedule", () => {
  it("describes schedules for people", () => {
    expect(
      describeSensorSchedule({
        kind: "interval",
        minutes: 120,
        timezone: "UTC",
      }),
    ).toBe("Every 2 hours");
    expect(
      describeSensorSchedule({
        kind: "daily",
        times: ["07:00"],
        timezone: "Europe/Berlin",
        days: [1, 2, 3, 4, 5],
      }),
    ).toBe("Daily at 07:00 on Mon, Tue, Wed, Thu, Fri (Europe/Berlin)");
  });
});

describe("monthly and quarterly schedules", () => {
  const monthly = (fields: Record<string, unknown>) =>
    validateSensorSchedule(
      {
        kind: "monthly",
        times: ["08:30"],
        timezone: "America/Los_Angeles",
        ...fields,
      },
      min15,
    );

  it("validates days of the month and months", () => {
    expect(monthly({ dates: [3] })).toEqual({
      kind: "monthly",
      dates: [3],
      times: ["08:30"],
      timezone: "America/Los_Angeles",
    });
    expect(monthly({ dates: [31, 3, 3], months: [10, 1, 7, 4] })).toMatchObject(
      {
        dates: [3, 31],
        months: [1, 4, 7, 10],
      },
    );
    // Every month listed is the same as none.
    expect(
      monthly({ dates: [1], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }),
    ).not.toHaveProperty("months");
    for (const bad of [
      { dates: [] },
      { dates: [0] },
      { dates: [32] },
      { dates: [1], months: [13] },
      { dates: [1], days: [1] },
    ])
      expect(() => monthly(bad)).toThrow();
  });

  it("describes them plainly", () => {
    expect(describeSensorSchedule(monthly({ dates: [3] }))).toBe(
      "Monthly on the 3rd at 08:30 (America/Los_Angeles)",
    );
    expect(
      describeSensorSchedule(monthly({ dates: [1], months: [1, 4, 7, 10] })),
    ).toBe("Quarterly on the 1st at 08:30 (America/Los_Angeles)");
    expect(describeSensorSchedule(monthly({ dates: [31], months: [7] }))).toBe(
      "In Jul on the 31st at 08:30 (America/Los_Angeles)",
    );
  });

  it("runs on the next such day, in the time zone", () => {
    const schedule = monthly({ dates: [3] });
    // Oct 21 2026, noon in Seattle: next is Nov 3, 08:30 PST (16:30 UTC).
    const now = Date.parse("2026-10-21T19:00:00Z");
    expect(new Date(nextSensorRunAt(schedule, now)!).toISOString()).toBe(
      "2026-11-03T16:30:00.000Z",
    );
    // Same day, before the time: today (PDT, 15:30 UTC).
    expect(
      new Date(
        nextSensorRunAt(schedule, Date.parse("2026-10-03T10:00:00Z"))!,
      ).toISOString(),
    ).toBe("2026-10-03T15:30:00.000Z");
  });

  it("a day past the month's end runs on its last day", () => {
    const schedule = monthly({ dates: [31] });
    expect(
      new Date(
        nextSensorRunAt(schedule, Date.parse("2027-02-01T00:00:00Z"))!,
      ).toISOString(),
    ).toBe("2027-02-28T16:30:00.000Z");
  });

  it("quarterly reaches months ahead (the end-of-quarter reports)", () => {
    const schedule = monthly({ dates: [31], months: [1, 4, 7, 10] });
    // After Oct 31 2026: next is Jan 31 2027.
    expect(
      new Date(
        nextSensorRunAt(schedule, Date.parse("2026-11-01T00:00:00Z"))!,
      ).toISOString(),
    ).toBe("2027-01-31T16:30:00.000Z");
    // A yearly date, 11 months away, is still found.
    const yearly = monthly({ dates: [31], months: [7] });
    expect(
      new Date(
        nextSensorRunAt(yearly, Date.parse("2026-08-15T00:00:00Z"))!,
      ).toISOString(),
    ).toBe("2027-07-31T15:30:00.000Z");
  });

  it("a time skipped by the spring-forward gap runs just after it, never early or a month late", () => {
    // Mar 14 2027: Seattle's clocks go from 02:00 PST to 03:00 PDT.
    const schedule = monthly({ dates: [14], times: ["02:30"] });
    // Set before that day: it runs at 03:30 PDT (10:30 UTC), not 01:30.
    expect(
      new Date(
        nextSensorRunAt(schedule, Date.parse("2027-03-01T00:00:00Z"))!,
      ).toISOString(),
    ).toBe("2027-03-14T10:30:00.000Z");
    // Recomputed that morning after 01:30 PST (09:30 UTC): still that day.
    expect(
      new Date(
        nextSensorRunAt(schedule, Date.parse("2027-03-14T09:45:00Z"))!,
      ).toISOString(),
    ).toBe("2027-03-14T10:30:00.000Z");
  });
});
