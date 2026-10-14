import { act, renderHook } from "@testing-library/react";

const mockList = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { hub: { computers: { listComputers: () => mockList() } } },
  },
}));

import { REFRESH_MS, useComputers } from "./use-computers";

const row = (name: string) => ({ computer_id: name, name }) as any;

beforeEach(() => {
  jest.useFakeTimers();
  mockList.mockReset();
});
afterEach(() => jest.useRealTimers());

test("refreshes while open, recovers from a failed load, and stops when closed", async () => {
  mockList.mockRejectedValueOnce(new Error("offline"));
  const { result, unmount } = renderHook(() => useComputers(true));
  await act(async () => {});
  expect(result.current).toEqual([]);

  // A machine connected meanwhile shows up on the next refresh.
  mockList.mockResolvedValue([row("m1")]);
  await act(async () => {
    jest.advanceTimersByTime(REFRESH_MS);
  });
  expect(result.current.map((c) => c.name)).toEqual(["m1"]);

  // Disconnected meanwhile: gone after the next one.
  mockList.mockResolvedValue([]);
  await act(async () => {
    jest.advanceTimersByTime(REFRESH_MS);
  });
  expect(result.current).toEqual([]);

  unmount();
  const calls = mockList.mock.calls.length;
  jest.advanceTimersByTime(5 * REFRESH_MS);
  expect(mockList.mock.calls.length).toBe(calls);
});

test("a composer that doesn't offer computers loads nothing", () => {
  const { result } = renderHook(() => useComputers(false));
  jest.advanceTimersByTime(2 * REFRESH_MS);
  expect(result.current).toEqual([]);
  expect(mockList).not.toHaveBeenCalled();
});
