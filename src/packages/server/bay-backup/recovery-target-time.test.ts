/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  formatRecoveryTargetTimeForPostgres,
  normalizeRecoveryTargetTime,
} from "./recovery-target-time";

describe("normalizeRecoveryTargetTime", () => {
  it("keeps microseconds, so a target never moves before a commit in the same millisecond", () => {
    // The 2026-10-13 staging2 drill: the "pre" sentinel committed at
    // 05:28:46.602286 and a millisecond target of 05:28:46.602 preceded it.
    expect(normalizeRecoveryTargetTime("2026-10-13T05:28:46.602731Z")).toBe(
      "2026-10-13T05:28:46.602731Z",
    );
    expect(
      normalizeRecoveryTargetTime("2026-10-13T05:28:46.602731Z")! >
        "2026-10-13T05:28:46.602286Z",
    ).toBe(true);
  });

  it("keeps the millisecond form for inputs with at most three fractional digits", () => {
    expect(normalizeRecoveryTargetTime("2026-04-07T15:37:57Z")).toBe(
      "2026-04-07T15:37:57.000Z",
    );
    expect(normalizeRecoveryTargetTime("2026-04-07T15:37:57.5Z")).toBe(
      "2026-04-07T15:37:57.500Z",
    );
    expect(normalizeRecoveryTargetTime("2026-04-07T15:37:57.123Z")).toBe(
      "2026-04-07T15:37:57.123Z",
    );
  });

  it("converts offsets to UTC without touching the fraction", () => {
    expect(
      normalizeRecoveryTargetTime("2026-10-12T22:28:46.602731-07:00"),
    ).toBe("2026-10-13T05:28:46.602731Z");
    expect(normalizeRecoveryTargetTime("2026-10-13T05:28:46+02:00")).toBe(
      "2026-10-13T03:28:46.000Z",
    );
  });

  it("drops digits beyond PostgreSQL's microsecond precision", () => {
    expect(normalizeRecoveryTargetTime("2026-10-13T05:28:46.6027319Z")).toBe(
      "2026-10-13T05:28:46.602731Z",
    );
  });

  it("rejects timestamps without an explicit zone and empty input", () => {
    expect(() => normalizeRecoveryTargetTime("2026-10-13 05:28:46")).toThrow(
      "RFC3339",
    );
    expect(() => normalizeRecoveryTargetTime("2026-13-40T99:99:99Z")).toThrow();
    expect(normalizeRecoveryTargetTime("  ")).toBeNull();
  });

  it("formats for PostgreSQL's recovery_target_time", () => {
    expect(
      formatRecoveryTargetTimeForPostgres("2026-10-13T05:28:46.602731Z"),
    ).toBe("2026-10-13 05:28:46.602731+00");
  });
});
