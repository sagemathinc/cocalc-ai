import { act, renderHook } from "@testing-library/react";
import { useDirectoryRevision } from "./use-directory-revision";
import type { DirectoryApi } from "./workspace-api";

const settle = () =>
  act(async () => {
    await Promise.resolve();
  });
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

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
