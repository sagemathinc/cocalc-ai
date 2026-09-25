import { act, renderHook } from "@testing-library/react";
import { useNavigationIntent } from "./use-navigation-intent";

test("Back/Forward supersedes delayed navigation, but an intentional push does not", async () => {
  const view = renderHook(() => useNavigationIntent(true, "alice"));
  const token = view.result.current;
  const request = ++token.current;
  const open = jest.fn();
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  }).then(() => {
    if (request === token.current) open();
  });
  window.history.pushState({}, "", "/library");
  expect(token.current).toBe(request);
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  complete();
  await pending;
  expect(open).not.toHaveBeenCalled();
});

test("account changes, leaving the workspace, and unmount cancel pending work", () => {
  const view = renderHook(
    ({ active, account }) => useNavigationIntent(active, account),
    {
      initialProps: { active: true, account: "alice" },
    },
  );
  const token = view.result.current;
  let request = token.current;
  view.rerender({ active: true, account: "bob" });
  expect(token.current).toBeGreaterThan(request);
  request = token.current;
  view.rerender({ active: false, account: "bob" });
  expect(token.current).toBeGreaterThan(request);
  request = token.current;
  view.unmount();
  expect(token.current).toBeGreaterThan(request);
  request = token.current;
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(token.current).toBe(request);
});
