import {
  regionUtcOffsetHours,
  spotReturnDecision,
  SPOT_RETURN_RECHECK_MS,
} from "./spot-return-timing";

const DAY = 24 * 60 * 60 * 1000;

describe("spotReturnDecision", () => {
  it("returns at once when nobody is using the host", () => {
    expect(
      spotReturnDecision({
        now: new Date("2026-10-08T17:00:00Z"),
        region: "us-south1",
        fallback_started_at: "2026-10-08T16:30:00Z",
        max_fallback_runtime_ms: DAY,
        recently_active_projects: 0,
      }),
    ).toEqual({ return_now: true, reason: "quiet" });
  });

  it("returns a busy host during its regional overnight window", () => {
    // 09:30 UTC is 03:30 in us-south1 (UTC-6).
    expect(
      spotReturnDecision({
        now: new Date("2026-10-08T09:30:00Z"),
        region: "us-south1",
        fallback_started_at: "2026-10-08T08:00:00Z",
        max_fallback_runtime_ms: DAY,
        recently_active_projects: 30,
      }),
    ).toEqual({ return_now: true, reason: "overnight" });
    // 22:00 UTC is 03:30 in asia-south2 (UTC+5:30).
    expect(
      spotReturnDecision({
        now: new Date("2026-10-08T22:00:00Z"),
        region: "asia-south2",
        max_fallback_runtime_ms: DAY,
        recently_active_projects: 30,
      }),
    ).toMatchObject({ return_now: true, reason: "overnight" });
  });

  it("defers a busy host in the daytime and re-checks within 30 minutes", () => {
    const now = new Date("2026-10-08T13:20:36Z"); // 07:20 in us-south1
    const decision = spotReturnDecision({
      now,
      region: "us-south1",
      fallback_started_at: "2026-10-08T12:54:45Z",
      max_fallback_runtime_ms: DAY,
      recently_active_projects: 30,
    });
    expect(decision.return_now).toBe(false);
    if (decision.return_now) return;
    expect(decision.recheck_at.getTime() - now.getTime()).toBe(
      SPOT_RETURN_RECHECK_MS,
    );
  });

  it("always returns once the fallback runtime cap is reached", () => {
    expect(
      spotReturnDecision({
        now: new Date("2026-10-09T13:00:00Z"),
        region: "us-south1",
        fallback_started_at: "2026-10-08T12:54:45Z",
        max_fallback_runtime_ms: DAY,
        recently_active_projects: 30,
      }),
    ).toEqual({ return_now: true, reason: "max_runtime" });
  });

  it("knows the fleet's regions", () => {
    for (const region of [
      "us-south1",
      "us-west2",
      "northamerica-northeast1",
      "europe-west8",
      "me-central2",
      "asia-south2",
      "australia-southeast2",
    ]) {
      expect(regionUtcOffsetHours(region)).toEqual(expect.any(Number));
    }
  });
});
