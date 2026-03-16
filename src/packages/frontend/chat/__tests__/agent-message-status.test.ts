/** @jest-environment jsdom */

import {
  describeLastActivity,
  STALE_ACTIVITY_MS,
} from "../agent-message-status";

describe("describeLastActivity", () => {
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
      label: "Awaiting activity",
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
