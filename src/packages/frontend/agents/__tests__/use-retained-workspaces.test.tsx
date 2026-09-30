import { act, renderHook } from "@testing-library/react";
import {
  AGENT_WORKSPACE_IDLE_MS,
  useRetainedWorkspaces,
} from "../use-retained-workspaces";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("keeps at most three recently visited workspaces and revisits update recency", () => {
  const { result, rerender } = renderHook(
    ({ active }) => useRetainedWorkspaces(active),
    { initialProps: { active: "A" } },
  );
  for (const active of ["B", "C", "A", "D"]) {
    act(() => jest.advanceTimersByTime(1000));
    rerender({ active });
  }
  expect([...result.current.mountedWorkspaces.keys()]).toEqual(["A", "C", "D"]);
});

test("revisiting a retained workspace keeps render order stable", () => {
  // Reordering keyed views moves their DOM, which resets scroll positions.
  const { result, rerender } = renderHook(
    ({ active }) => useRetainedWorkspaces(active),
    { initialProps: { active: "A" } },
  );
  for (const active of ["B", "C", "A", "B", "A"]) {
    act(() => jest.advanceTimersByTime(1000));
    rerender({ active });
    const keys = [...result.current.mountedWorkspaces.keys()];
    expect(keys).toEqual(["A", "B", "C"].slice(0, keys.length));
  }
  expect(result.current.mountedWorkspaces.size).toBe(3);
});

test("evicts inactive views but preserves the active view even after a long visit", () => {
  const { result, rerender } = renderHook(
    ({ active }: { active?: string }) => useRetainedWorkspaces(active),
    { initialProps: { active: "A" } },
  );
  act(() => jest.advanceTimersByTime(AGENT_WORKSPACE_IDLE_MS * 3));
  expect(result.current.mountedWorkspaces.has("A")).toBe(true);
  rerender({ active: "B" });
  act(() => jest.advanceTimersByTime(AGENT_WORKSPACE_IDLE_MS - 30_000));
  expect(result.current.mountedWorkspaces.has("A")).toBe(true);
  act(() => jest.advanceTimersByTime(30_000));
  expect([...result.current.mountedWorkspaces.keys()]).toEqual(["B"]);
  rerender({ active: undefined });
  act(() => jest.advanceTimersByTime(AGENT_WORKSPACE_IDLE_MS));
  expect(result.current.mountedWorkspaces.size).toBe(0);
});

test("manual close is not undone by timer ticks, and explicit reopening works", () => {
  const { result } = renderHook(() => useRetainedWorkspaces("A"));
  act(() => result.current.unmountWorkspace("A"));
  act(() => jest.advanceTimersByTime(AGENT_WORKSPACE_IDLE_MS));
  expect(result.current.mountedWorkspaces.size).toBe(0);
  act(() => result.current.mountWorkspace("A"));
  expect(result.current.mountedWorkspaces.has("A")).toBe(true);
});
