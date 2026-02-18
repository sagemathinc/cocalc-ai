import { shouldInitialWatchLoadFromDisk } from "../watch-policy";

describe("jupyter ipynb watch initial-load policy", () => {
  it("loads from disk when RTC has no cells", () => {
    expect(shouldInitialWatchLoadFromDisk({ hasRtcCells: false })).toBe(true);
  });

  it("skips disk load when RTC already has cells", () => {
    expect(shouldInitialWatchLoadFromDisk({ hasRtcCells: true })).toBe(false);
  });
});

