import { shouldSkipStartForSnapshot } from "./control";

describe("shouldSkipStartForSnapshot", () => {
  const nowMs = Date.UTC(2026, 2, 19, 12, 0, 0);

  it("skips while a start lro is active", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "starting",
        timeMs: nowMs - 60_000,
        hasActiveStartLro: true,
        nowMs,
      }),
    ).toEqual({
      skip: true,
      reason: "active-start-lro",
    });
  });

  it("skips for a recent starting state", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "starting",
        timeMs: nowMs - 60_000,
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: true,
      reason: "recent-starting-state",
    });
  });

  it("does not skip a stale starting state without an active lro", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "starting",
        timeMs: nowMs - 10 * 60_000,
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: false,
    });
  });

  it("does not skip a starting state with no timestamp and no active lro", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "starting",
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: false,
    });
  });

  it("skips a recent running state", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "running",
        timeMs: nowMs - 30_000,
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: true,
      reason: "recent-running-state",
    });
  });

  it("does not skip a stale running state", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "running",
        timeMs: nowMs - 5 * 60_000,
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: false,
    });
  });
});
