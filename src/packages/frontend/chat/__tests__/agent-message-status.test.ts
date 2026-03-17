/** @jest-environment jsdom */

import {
  describeLastActivity,
  resolveLiveRunStartMs,
  STALE_ACTIVITY_MS,
} from "../agent-message-status";

describe("describeLastActivity", () => {
  it("prefers the ACP start time over the row date for live timing", () => {
    expect(resolveLiveRunStartMs({ startedAtMs: 5000, date: 1000 })).toBe(5000);
    expect(resolveLiveRunStartMs({ startedAtMs: undefined, date: 1000 })).toBe(
      1000,
    );
  });

  it("returns no label when not generating", () => {
    expect(
      describeLastActivity({
        generating: false,
        lastActivityAtMs: 1000,
        now: 5000,
      }),
    ).toEqual({
      label: undefined,
      ageMs: undefined,
      stale: false,
    });
  });

  it("shows awaiting activity before the first backend event", () => {
    expect(
      describeLastActivity({
        generating: true,
        lastActivityAtMs: undefined,
        now: 5000,
      }),
    ).toEqual({
      label: "Starting...",
      ageMs: undefined,
      stale: false,
    });
  });

  it("formats recent activity age and marks stale after the threshold", () => {
    expect(
      describeLastActivity({
        generating: true,
        lastActivityAtMs: 4000,
        now: 9000,
      }),
    ).toEqual({
      label: "Last activity 0:05 ago",
      ageMs: 5000,
      stale: false,
    });

    const stale = describeLastActivity({
      generating: true,
      lastActivityAtMs: 1000,
      now: 1000 + STALE_ACTIVITY_MS,
    });
    expect(stale.label).toBe("Last activity 2:00 ago");
    expect(stale.ageMs).toBe(STALE_ACTIVITY_MS);
    expect(stale.stale).toBe(true);
  });
});
