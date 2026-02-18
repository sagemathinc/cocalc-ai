import {
  decideInitialWatchSource,
  shouldInitialWatchLoadFromDisk,
} from "../watch-policy";

describe("jupyter ipynb watch initial-load policy", () => {
  it("loads from disk when RTC has no cells", () => {
    expect(shouldInitialWatchLoadFromDisk({ hasRtcCells: false })).toBe(true);
  });

  it("skips disk load when RTC already has cells", () => {
    expect(
      shouldInitialWatchLoadFromDisk({
        hasRtcCells: true,
        rtcLastChangedMs: 200,
        diskMtimeMs: 100,
      }),
    ).toBe(false);
  });

  it("loads from disk when disk is newer than RTC state", () => {
    expect(
      decideInitialWatchSource({
        hasRtcCells: true,
        rtcLastChangedMs: 1000,
        diskMtimeMs: 2000,
      }),
    ).toEqual({
      loadFromDisk: true,
      reason: "disk_newer_than_rtc",
    });
  });

  it("keeps RTC when RTC state is newer than disk", () => {
    expect(
      decideInitialWatchSource({
        hasRtcCells: true,
        rtcLastChangedMs: 3000,
        diskMtimeMs: 2000,
      }),
    ).toEqual({
      loadFromDisk: false,
      reason: "rtc_newer_or_equal",
    });
  });

  it("loads from disk when RTC has cells but no timestamp", () => {
    expect(
      decideInitialWatchSource({
        hasRtcCells: true,
        rtcLastChangedMs: undefined,
        diskMtimeMs: 2000,
      }),
    ).toEqual({
      loadFromDisk: true,
      reason: "rtc_timestamp_missing",
    });
  });

  it("keeps RTC when disk mtime is unavailable", () => {
    expect(
      decideInitialWatchSource({
        hasRtcCells: true,
        rtcLastChangedMs: 3000,
      }),
    ).toEqual({
      loadFromDisk: false,
      reason: "disk_mtime_unavailable",
    });
  });
});
