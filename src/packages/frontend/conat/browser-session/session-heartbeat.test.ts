describe("browser session sync controller", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("syncs only when marked dirty and does not poll periodically", async () => {
    const upsertBrowserSession = jest.fn().mockResolvedValue(undefined);
    let openProjects: string[] = [];

    const { createBrowserSessionHeartbeat } = require("./session-heartbeat");
    const heartbeat = createBrowserSessionHeartbeat({
      hub: {
        system: {
          upsertBrowserSession,
        },
      },
      getSnapshot: () => ({
        browser_id: "browser-1",
        open_projects: openProjects,
      }),
      retryMs: 4_000,
      maxRetryMs: 60_000,
      retryBackoff: 2,
      retryJitter: 0,
    });

    heartbeat.activate("acct-1");
    heartbeat.resume();
    await heartbeat.heartbeat();
    expect(upsertBrowserSession).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(upsertBrowserSession).toHaveBeenCalledTimes(1);

    openProjects = ["project-1"];
    heartbeat.markDirty(250);
    heartbeat.markDirty(250);
    await jest.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    expect(upsertBrowserSession).toHaveBeenCalledTimes(2);
  });

  it("suspends retries while disconnected and resumes immediately on reconnect", async () => {
    const upsertBrowserSession = jest
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");

    const { createBrowserSessionHeartbeat } = require("./session-heartbeat");
    const heartbeat = createBrowserSessionHeartbeat({
      hub: {
        system: {
          upsertBrowserSession,
        },
      },
      getSnapshot: () => ({ browser_id: "browser-1", open_projects: [] }),
      retryMs: 4_000,
      maxRetryMs: 60_000,
      retryBackoff: 2,
      retryJitter: 0,
    });

    heartbeat.activate("acct-1");
    heartbeat.resume();
    heartbeat.markDirty(0);

    await jest.runOnlyPendingTimersAsync();
    expect(upsertBrowserSession).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4_000);

    heartbeat.suspend();
    await jest.advanceTimersByTimeAsync(4_000);
    expect(upsertBrowserSession).toHaveBeenCalledTimes(1);

    heartbeat.resume();
    await jest.runOnlyPendingTimersAsync();
    expect(upsertBrowserSession).toHaveBeenCalledTimes(2);
  });

  it("reports consecutive failure counts to onFailure", async () => {
    const upsertBrowserSession = jest
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"));
    const onFailure = jest.fn();

    const { createBrowserSessionHeartbeat } = require("./session-heartbeat");
    const heartbeat = createBrowserSessionHeartbeat({
      hub: {
        system: {
          upsertBrowserSession,
        },
      },
      getSnapshot: () => ({ browser_id: "browser-1", open_projects: [] }),
      retryMs: 4_000,
      maxRetryMs: 60_000,
      retryBackoff: 2,
      retryJitter: 0,
      onFailure,
    });

    heartbeat.activate("acct-1");
    heartbeat.resume();
    heartbeat.markDirty(0);

    await jest.runOnlyPendingTimersAsync();
    await jest.runOnlyPendingTimersAsync();

    expect(onFailure).toHaveBeenNthCalledWith(1, expect.any(Error), 1);
    expect(onFailure).toHaveBeenNthCalledWith(2, expect.any(Error), 2);
  });
});
