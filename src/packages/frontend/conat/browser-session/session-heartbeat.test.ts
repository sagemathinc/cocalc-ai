describe("browser session heartbeat backoff", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("backs off after repeated failures and resets after success", async () => {
    const upsertBrowserSession = jest
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValue(undefined);
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");

    const { createBrowserSessionHeartbeat } = require("./session-heartbeat");
    const heartbeat = createBrowserSessionHeartbeat({
      hub: {
        system: {
          upsertBrowserSession,
        },
      },
      getSnapshot: () => ({ browser_id: "browser-1" }),
      intervalMs: 10_000,
      retryMs: 4_000,
      maxRetryMs: 60_000,
      retryBackoff: 2,
      retryJitter: 0,
    });

    heartbeat.activate("acct-1");
    heartbeat.schedule(0);

    await jest.runOnlyPendingTimersAsync();
    expect(upsertBrowserSession).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 4_000);

    await jest.runOnlyPendingTimersAsync();
    expect(upsertBrowserSession).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 8_000);

    await jest.runOnlyPendingTimersAsync();
    expect(upsertBrowserSession).toHaveBeenCalledTimes(3);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(
      expect.any(Function),
      10_000,
    );
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
      getSnapshot: () => ({ browser_id: "browser-1" }),
      intervalMs: 10_000,
      retryMs: 4_000,
      maxRetryMs: 60_000,
      retryBackoff: 2,
      retryJitter: 0,
    });

    heartbeat.activate("acct-1");
    heartbeat.schedule(0);

    await jest.runOnlyPendingTimersAsync();
    expect(upsertBrowserSession).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 4_000);

    heartbeat.suspend();
    await jest.advanceTimersByTimeAsync(4_000);
    expect(upsertBrowserSession).toHaveBeenCalledTimes(1);

    heartbeat.resume();
    await jest.runOnlyPendingTimersAsync();
    expect(upsertBrowserSession).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(
      expect.any(Function),
      10_000,
    );
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
      getSnapshot: () => ({ browser_id: "browser-1" }),
      intervalMs: 10_000,
      retryMs: 4_000,
      maxRetryMs: 60_000,
      retryBackoff: 2,
      retryJitter: 0,
      onFailure,
    });

    heartbeat.activate("acct-1");
    heartbeat.schedule(0);

    await jest.runOnlyPendingTimersAsync();
    await jest.runOnlyPendingTimersAsync();

    expect(onFailure).toHaveBeenNthCalledWith(1, expect.any(Error), 1);
    expect(onFailure).toHaveBeenNthCalledWith(2, expect.any(Error), 2);
  });
});
