import { act, renderHook } from "@testing-library/react";
import {
  AGENT_WORKSPACE_IDLE_MS,
  AGENT_WORKSPACE_IDLE_TICK_MS,
  useRetainedWorkspaces,
} from "../use-retained-workspaces";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

function visit(
  sequence: string[],
  options: Parameters<typeof useRetainedWorkspaces>[1] = { maxRetained: 3 },
) {
  const hook = renderHook(
    ({ active }: { active?: string }) => useRetainedWorkspaces(active, options),
    { initialProps: { active: sequence[0] } },
  );
  for (const active of sequence.slice(1)) hook.rerender({ active });
  return hook;
}

const keys = (hook: ReturnType<typeof visit>) => [
  ...hook.result.current.mountedWorkspaces.keys(),
];

test("evicts the least recently used view beyond the limit", () => {
  const hook = visit(["A", "B", "C", "A", "D"]);
  expect(keys(hook)).toEqual(["A", "C", "D"]);
});

test("revisiting a retained workspace keeps render order stable", () => {
  // Reordering keyed views moves their DOM, which resets scroll positions.
  const hook = visit(["A"]);
  for (const active of ["B", "C", "A", "B", "A"]) {
    hook.rerender({ active });
    const current = keys(hook);
    expect(current).toEqual(["A", "B", "C"].slice(0, current.length));
  }
  expect(keys(hook)).toHaveLength(3);
});

test("never evicts the view shown just before the active one", () => {
  // A B C D: C is the previous view when D opens; B is the least recent
  // unprotected view.
  const hook = visit(["A", "B", "C", "D"], { maxRetained: 2 });
  expect(keys(hook)).toEqual(["C", "D"]);
});

test("protected views (e.g. running agents) are never evicted", () => {
  const running = new Set(["A"]);
  const hook = visit(["A", "B", "C", "D", "E"], {
    maxRetained: 3,
    isProtected: (key) => running.has(key),
  });
  expect(keys(hook)).toEqual(["A", "D", "E"]);
  // Once it stops running it is an ordinary candidate again.
  running.clear();
  hook.rerender({ active: "F" });
  expect(keys(hook)).toEqual(["D", "E", "F"]);
});

test("the limit may be exceeded when every retained view is protected", () => {
  const hook = visit(["A", "B", "C", "D"], {
    maxRetained: 2,
    isProtected: () => true,
  });
  expect(keys(hook)).toEqual(["A", "B", "C", "D"]);
});

test("idle views are evicted after time spent elsewhere, but not while the tab is hidden", () => {
  const hook = visit(["A", "B", "C"], { maxRetained: 8 });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  act(() => jest.advanceTimersByTime(AGENT_WORKSPACE_IDLE_MS * 4));
  expect(keys(hook)).toEqual(["A", "B", "C"]);

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  act(() =>
    jest.advanceTimersByTime(
      AGENT_WORKSPACE_IDLE_MS - AGENT_WORKSPACE_IDLE_TICK_MS,
    ),
  );
  expect(keys(hook)).toEqual(["A", "B", "C"]);
  act(() => jest.advanceTimersByTime(AGENT_WORKSPACE_IDLE_TICK_MS));
  // A aged out; B (previous) and C (active) are kept.
  expect(keys(hook)).toEqual(["B", "C"]);
});

test("returning to a view resets its idle time", () => {
  // Active D, previous C; A and B age.
  const hook = visit(["A", "B", "C", "D"], { maxRetained: 8 });
  act(() => jest.advanceTimersByTime(AGENT_WORKSPACE_IDLE_MS / 2));
  // Visiting A resets it; B keeps aging.
  hook.rerender({ active: "A" });
  hook.rerender({ active: "D" });
  act(() => jest.advanceTimersByTime(AGENT_WORKSPACE_IDLE_MS / 2));
  expect(keys(hook)).toEqual(["A", "C", "D"]);
});

test("manual close is not undone by timer ticks, and explicit reopening works", () => {
  const { result } = renderHook(() => useRetainedWorkspaces("A"));
  act(() => result.current.unmountWorkspace("A"));
  act(() => jest.advanceTimersByTime(AGENT_WORKSPACE_IDLE_MS));
  expect(result.current.mountedWorkspaces.size).toBe(0);
  act(() => result.current.mountWorkspace("A"));
  expect(result.current.mountedWorkspaces.has("A")).toBe(true);
});
