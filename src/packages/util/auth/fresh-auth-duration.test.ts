/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  FRESH_AUTH_DEFAULT_MS,
  FRESH_AUTH_EXTENDED_MS,
  formatFreshAuthDuration,
  formatFreshAuthRemaining,
  freshAuthDurationMs,
  freshAuthDurationNeedsStrongFactor,
  isLongFreshAuthDuration,
  parseFreshAuthDuration,
} from "./fresh-auth-duration";

const HOUR = 60 * 60_000;

describe("parseFreshAuthDuration", () => {
  it("keeps the two existing durations", () => {
    expect(parseFreshAuthDuration(undefined)).toBe("default");
    expect(parseFreshAuthDuration(null)).toBe("default");
    expect(parseFreshAuthDuration("")).toBe("default");
    expect(parseFreshAuthDuration("default")).toBe("default");
    expect(parseFreshAuthDuration("extended")).toBe("extended");
    expect(parseFreshAuthDuration(" Extended ")).toBe("extended");
  });

  it("accepts 1h to 72h", () => {
    expect(parseFreshAuthDuration("1h")).toBe("1h");
    expect(parseFreshAuthDuration("24h")).toBe("24h");
    expect(parseFreshAuthDuration("72H")).toBe("72h");
  });

  it.each([
    "0h",
    "73h",
    "100h",
    "072h",
    "1.5h",
    "-1h",
    "24",
    "3d",
    "24 h",
    "forever",
    "extended;drop",
  ])("refuses %p", (value) => {
    expect(() => parseFreshAuthDuration(value)).toThrow(
      /invalid fresh auth duration/,
    );
  });
});

describe("freshAuthDurationMs", () => {
  it("maps each duration to its length", () => {
    expect(freshAuthDurationMs("default")).toBe(FRESH_AUTH_DEFAULT_MS);
    expect(freshAuthDurationMs(undefined)).toBe(FRESH_AUTH_DEFAULT_MS);
    expect(freshAuthDurationMs("extended")).toBe(FRESH_AUTH_EXTENDED_MS);
    expect(freshAuthDurationMs("1h")).toBe(HOUR);
    expect(freshAuthDurationMs("72h")).toBe(72 * HOUR);
  });

  it("refuses a value that was never parsed", () => {
    expect(() => freshAuthDurationMs("200h" as any)).toThrow();
  });
});

describe("factor and notice rules", () => {
  it("needs a strong factor for everything but the default", () => {
    expect(freshAuthDurationNeedsStrongFactor("default")).toBe(false);
    expect(freshAuthDurationNeedsStrongFactor("extended")).toBe(true);
    expect(freshAuthDurationNeedsStrongFactor("1h")).toBe(true);
    expect(freshAuthDurationNeedsStrongFactor("72h")).toBe(true);
  });

  it("calls only durations longer than 8 hours long", () => {
    expect(isLongFreshAuthDuration("default")).toBe(false);
    expect(isLongFreshAuthDuration("extended")).toBe(false);
    expect(isLongFreshAuthDuration("8h")).toBe(false);
    expect(isLongFreshAuthDuration("9h")).toBe(true);
    expect(isLongFreshAuthDuration("72h")).toBe(true);
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatFreshAuthDuration("default")).toBe("15 minutes");
    expect(formatFreshAuthDuration("extended")).toBe("8 hours");
    expect(formatFreshAuthDuration("1h")).toBe("1 hour");
    expect(formatFreshAuthDuration("72h")).toBe("72 hours");
  });

  it("formats the time left", () => {
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);
    expect(formatFreshAuthRemaining(new Date(now + 72 * HOUR), now)).toBe(
      "72 h 0 min",
    );
    expect(
      formatFreshAuthRemaining(new Date(now + 71 * HOUR + 59 * 60_000), now),
    ).toBe("71 h 59 min");
    expect(formatFreshAuthRemaining(new Date(now + 14 * 60_000), now)).toBe(
      "14 min",
    );
    expect(formatFreshAuthRemaining(new Date(now + 45_000), now)).toBe("45 s");
    expect(formatFreshAuthRemaining(new Date(now - 1), now)).toBe("");
    expect(formatFreshAuthRemaining(null, now)).toBe("");
    expect(formatFreshAuthRemaining("not a date", now)).toBe("");
  });
});
