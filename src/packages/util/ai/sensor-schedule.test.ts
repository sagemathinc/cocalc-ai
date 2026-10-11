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
