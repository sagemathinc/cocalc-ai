import { HarnessIdleDisposer, harnessIdleDisposeMs } from "../harness-idle";

describe("HarnessIdleDisposer", () => {
  const retire = jest.fn((_key: string, _agent: string) => true);
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("disposes an agent that stays idle for idleMs", async () => {
    const dispose = jest.fn(async () => {});
    const idle = new HarnessIdleDisposer({ idleMs: 1000, retire, dispose });
    idle.acquire("k");
    idle.release("k", "agent");
    jest.advanceTimersByTime(999);
    expect(dispose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(dispose).toHaveBeenCalledWith("agent");
    expect(idle.size).toBe(0);
  });

  test("a turn that takes the agent cancels its disposal", () => {
    const dispose = jest.fn(async () => {});
    const idle = new HarnessIdleDisposer({ idleMs: 1000, retire, dispose });
    idle.acquire("k");
    idle.release("k", "agent");
    jest.advanceTimersByTime(500);
    idle.acquire("k");
    jest.advanceTimersByTime(5000);
    expect(dispose).not.toHaveBeenCalled();
    // Its release restarts the idle time.
    idle.release("k", "agent");
    jest.advanceTimersByTime(999);
    expect(dispose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("an agent is idle only once every turn using it is done", () => {
    const dispose = jest.fn(async () => {});
    const idle = new HarnessIdleDisposer({ idleMs: 1000, retire, dispose });
    idle.acquire("k");
    idle.acquire("k");
    idle.release("k", "agent");
    jest.advanceTimersByTime(5000);
    expect(dispose).not.toHaveBeenCalled();
    expect(idle.size).toBe(0);
    idle.release("k", "agent");
    jest.advanceTimersByTime(1000);
    expect(dispose).toHaveBeenCalledWith("agent");
  });

  test("nothing is disposed when no agent is retained under the key", () => {
    const dispose = jest.fn(async () => {});
    const idle = new HarnessIdleDisposer({ idleMs: 1000, retire, dispose });
    idle.acquire("k");
    idle.release("k", undefined);
    jest.advanceTimersByTime(5000);
    expect(dispose).not.toHaveBeenCalled();
    expect(idle.size).toBe(0);
  });

  test("keys are independent", () => {
    const dispose = jest.fn(async () => {});
    const idle = new HarnessIdleDisposer({ idleMs: 1000, retire, dispose });
    idle.acquire("a");
    idle.acquire("b");
    idle.release("a", "agent-a");
    jest.advanceTimersByTime(1000);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith("agent-a");
  });

  test("idleMs 0 disables disposal", () => {
    const dispose = jest.fn(async () => {});
    const idle = new HarnessIdleDisposer({ idleMs: 0, retire, dispose });
    idle.acquire("k");
    idle.release("k", "agent");
    jest.advanceTimersByTime(60 * 60_000);
    expect(dispose).not.toHaveBeenCalled();
    expect(idle.size).toBe(0);
  });

  test("a failed disposal is reported and retried with backoff", async () => {
    const onError = jest.fn();
    let failures = 2;
    const dispose = jest.fn(async () => {
      if (failures-- > 0) throw Error("boom");
    });
    const idle = new HarnessIdleDisposer({
      idleMs: 10,
      retire,
      dispose,
      onError,
      retryMs: 100,
    });
    idle.acquire("k");
    idle.release("k", "agent");
    await jest.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith("k", expect.any(Error), 1);
    expect(idle.pendingRetries).toBe(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith("k", expect.any(Error), 2);
    // The second retry waits twice as long.
    await jest.advanceTimersByTimeAsync(199);
    expect(dispose).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(idle.pendingRetries).toBe(0);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  test("disposal gives up after maxAttempts", async () => {
    const onError = jest.fn();
    const dispose = jest.fn(async () => {
      throw Error("boom");
    });
    const idle = new HarnessIdleDisposer({
      idleMs: 10,
      retire,
      dispose,
      onError,
      retryMs: 1,
      maxAttempts: 3,
    });
    idle.acquire("k");
    idle.release("k", "agent");
    await jest.advanceTimersByTimeAsync(10_000);
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(idle.pendingRetries).toBe(0);
  });

  test("an agent no longer retained is not disposed", async () => {
    const dispose = jest.fn(async () => {});
    const idle = new HarnessIdleDisposer({
      idleMs: 10,
      retire: () => false,
      dispose,
    });
    idle.acquire("k");
    idle.release("k", "agent");
    await jest.advanceTimersByTimeAsync(10);
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe("harnessIdleDisposeMs", () => {
  test("defaults to 10 minutes", () => {
    expect(harnessIdleDisposeMs({})).toBe(600_000);
    expect(
      harnessIdleDisposeMs({ COCALC_ACP_HARNESS_IDLE_DISPOSE_MS: "" }),
    ).toBe(600_000);
  });
  test("reads the setting; 0 disables; bad values fall back", () => {
    expect(
      harnessIdleDisposeMs({ COCALC_ACP_HARNESS_IDLE_DISPOSE_MS: "120000" }),
    ).toBe(120_000);
    expect(
      harnessIdleDisposeMs({ COCALC_ACP_HARNESS_IDLE_DISPOSE_MS: "0" }),
    ).toBe(0);
    expect(
      harnessIdleDisposeMs({ COCALC_ACP_HARNESS_IDLE_DISPOSE_MS: "nope" }),
    ).toBe(600_000);
    expect(
      harnessIdleDisposeMs({ COCALC_ACP_HARNESS_IDLE_DISPOSE_MS: "-5" }),
    ).toBe(600_000);
  });
});
