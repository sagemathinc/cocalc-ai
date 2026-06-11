import { getStartProgressMessage } from "./start-in-progress";

describe("getStartProgressMessage", () => {
  it("explains archived queued starts as restore preparation", () => {
    expect(
      getStartProgressMessage({
        phase: "queued",
        rawMessage: "",
        lifecycleState: "archived",
        startLroActive: true,
        activeOpStartLike: true,
      }),
    ).toContain("Archived projects can wait here");
  });

  it("makes RootFS availability explicit during cache_rootfs", () => {
    expect(
      getStartProgressMessage({
        phase: "cache_rootfs",
        rawMessage: "",
        lifecycleState: "starting",
        startLroActive: true,
        activeOpStartLike: true,
      }),
    ).toBe("Making the RootFS image available on this host.");
  });

  it("explains explicit restart requests even if lifecycle is already running", () => {
    expect(
      getStartProgressMessage({
        phase: "queued",
        rawMessage: "",
        lifecycleState: "running",
        startLroActive: false,
        activeOpStartLike: false,
        restartRequested: true,
      }),
    ).toContain("restart was requested");
  });
});
