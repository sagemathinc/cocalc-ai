import { act, renderHook } from "@testing-library/react";
import { useDirectoryRevision } from "./use-directory-revision";
import type { DirectoryApi } from "./workspace-api";

const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

test("Scan capability changes without a directory revision reset", async () => {
  const mock = demandApi();
  const hook = renderHook(() =>
    useDirectoryRevision(mock as unknown as DirectoryApi, true),
  );
  await settle();
  expect(hook.result.current.scanSupported).toBe(false);
  mock.check.mockResolvedValue({
    revision: "r",
    reset: false,
    poll_after_ms: 5000,
    scan_supported: true,
  } as any);
  await act(() => jest.advanceTimersByTimeAsync(5000));
  expect(hook.result.current.scanSupported).toBe(true);
  mock.check.mockResolvedValue({
    revision: "r",
    reset: false,
    poll_after_ms: 5000,
  } as any);
  await act(() => jest.advanceTimersByTimeAsync(5000));
  expect(hook.result.current.scanSupported).toBe(false);
});
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function demandApi() {
  let sequence = 0;
  const receipt = (consumer_id: string) => ({
    consumer_id,
    lease_id: `lease-${++sequence}`,
    scope: { kind: "all" },
    expires_at: Date.now() + 120000,
    renew_after: Date.now() + 30000,
  });
  return {
    check: jest.fn().mockResolvedValue({
      revision: "r",
      reset: false,
      poll_after_ms: 5000,
      demand_supported: true,
    }),
    acquireDemand: jest.fn(async ({ consumer_id }) => receipt(consumer_id)),
    renewDemand: jest.fn(async ({ consumer_id }) => ({
      ...receipt(consumer_id),
      renewed: true,
    })),
    releaseDemand: jest.fn().mockResolvedValue({ released: true }),
  };
}

test("visible discovery demand renews at the allowed time and releases on hide", async () => {
  const mock = demandApi();
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const visibility = (value: string) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const hook = renderHook(() =>
    useDirectoryRevision(mock as unknown as DirectoryApi, true, {
      kind: "all",
    }),
  );
  try {
    await settle();
    expect(mock.acquireDemand).toHaveBeenCalledTimes(1);
    await act(() => jest.advanceTimersByTimeAsync(29999));
    expect(mock.renewDemand).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTimeAsync(1));
    expect(mock.renewDemand).toHaveBeenCalledTimes(1);
    await act(async () => visibility("hidden"));
    expect(hook.result.current.ready).toBe(false);
    expect(mock.releaseDemand).toHaveBeenCalledTimes(1);
    const checks = mock.check.mock.calls.length;
    await act(() => jest.advanceTimersByTimeAsync(300000));
    expect(mock.check).toHaveBeenCalledTimes(checks);
    expect(mock.renewDemand).toHaveBeenCalledTimes(1);
    await act(async () => visibility("visible"));
    expect(mock.acquireDemand).toHaveBeenCalledTimes(2);
    expect(mock.acquireDemand.mock.calls[1][0].consumer_id).toBe(
      mock.acquireDemand.mock.calls[0][0].consumer_id,
    );
  } finally {
    hook.unmount();
    if (original) Object.defineProperty(document, "visibilityState", original);
    else delete (document as any).visibilityState;
  }
});

test("invitation-only views and servers without demand capability do not acquire", async () => {
  const mock = demandApi();
  const api = mock as unknown as DirectoryApi;
  const invitations = renderHook(() => useDirectoryRevision(api, true));
  await settle();
  expect(mock.acquireDemand).not.toHaveBeenCalled();
  invitations.unmount();
  mock.check.mockResolvedValue({
    revision: "legacy",
    reset: false,
    poll_after_ms: 5000,
  });
  const legacy = renderHook(() =>
    useDirectoryRevision(api, true, { kind: "all" }),
  );
  await settle();
  expect(legacy.result.current.ready).toBe(true);
  expect(mock.acquireDemand).not.toHaveBeenCalled();
  legacy.unmount();
});

test("late acquisition is released before a reactivated view acquires again", async () => {
  const mock = demandApi();
  let finish!: (value: any) => void;
  mock.acquireDemand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const api = mock as unknown as DirectoryApi;
  const hook = renderHook(
    ({ active }) => useDirectoryRevision(api, active, { kind: "all" }),
    { initialProps: { active: true } },
  );
  await settle();
  hook.rerender({ active: false });
  hook.rerender({ active: true });
  await settle();
  expect(mock.acquireDemand).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      consumer_id: "old",
      lease_id: "late",
      expires_at: Date.now() + 120000,
      renew_after: Date.now() + 30000,
      scope: { kind: "all" },
    }),
  );
  expect(mock.releaseDemand).toHaveBeenCalledWith({
    consumer_id: "old",
    lease_id: "late",
  });
  expect(mock.acquireDemand).toHaveBeenCalledTimes(2);
  expect(mock.releaseDemand.mock.invocationCallOrder[0]).toBeLessThan(
    mock.acquireDemand.mock.invocationCallOrder[1],
  );
  hook.unmount();
});

test("establishes a baseline before reads and uses reset rather than rotating token strings", async () => {
  const check = jest
    .fn()
    .mockResolvedValueOnce({
      revision: "before-page",
      reset: true,
      poll_after_ms: 5000,
    })
    .mockResolvedValueOnce({
      revision: "renewed-lease",
      reset: false,
      poll_after_ms: 5000,
    })
    .mockResolvedValueOnce({
      revision: "changed",
      reset: true,
      poll_after_ms: 5000,
    });
  const api = { check } as unknown as DirectoryApi;
  const hook = renderHook(() => useDirectoryRevision(api, true));
  expect(hook.result.current.ready).toBe(false);
  await settle();
  expect(hook.result.current).toMatchObject({ ready: true, generation: 1 });
  await act(() => jest.advanceTimersByTimeAsync(5000));
  expect(check).toHaveBeenLastCalledWith({ since: "before-page" });
  expect(hook.result.current.generation).toBe(1);
  await act(() => jest.advanceTimersByTimeAsync(5000));
  expect(check).toHaveBeenLastCalledWith({ since: "renewed-lease" });
  expect(hook.result.current.generation).toBe(2);
  hook.unmount();
});

test("poll failure hides metadata and recovery resnapshots without the old token", async () => {
  const check = jest
    .fn()
    .mockResolvedValueOnce({
      revision: "before",
      reset: true,
      poll_after_ms: 1000,
    })
    .mockRejectedValueOnce(Error("home bay unavailable"))
    .mockResolvedValueOnce({
      revision: "after",
      reset: true,
      poll_after_ms: 5000,
    });
  const api = { check } as unknown as DirectoryApi;
  const hook = renderHook(() => useDirectoryRevision(api, true));
  await settle();
  await act(() => jest.advanceTimersByTimeAsync(1000));
  expect(hook.result.current).toMatchObject({
    ready: false,
    error: "Error: home bay unavailable",
  });
  await act(() => jest.advanceTimersByTimeAsync(5000));
  expect(check).toHaveBeenLastCalledWith({ since: undefined });
  expect(hook.result.current).toMatchObject({
    ready: true,
    generation: 2,
    error: "",
  });
  hook.unmount();
});

test("inactive overlays stop polling and reject late in-flight checks", async () => {
  let resolve!: (value: unknown) => void;
  const check = jest.fn().mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const api = { check } as unknown as DirectoryApi;
  const { result, rerender } = renderHook(
    ({ active }) => useDirectoryRevision(api, active),
    { initialProps: { active: true } },
  );
  rerender({ active: false });
  await act(async () =>
    resolve({ revision: "old", reset: true, poll_after_ms: 1000 }),
  );
  await act(() => jest.advanceTimersByTimeAsync(10_000));
  expect(result.current.ready).toBe(false);
  expect(result.current.generation).toBe(0);
  expect(check).toHaveBeenCalledTimes(1);
});
