import { act, renderHook } from "@testing-library/react";
import { useActivityVisibility } from "./activity-visibility";

it("retains expansion and explicit collapse for the open document, not the row lifetime", () => {
  const document = {};
  const first = renderHook(() => useActivityVisibility(document));
  act(() =>
    first.result.current.setExpanded(() => ({ live: true, hidden: false })),
  );
  first.unmount();
  const second = renderHook(() => useActivityVisibility(document));
  expect(second.result.current.expanded).toEqual({ live: true, hidden: false });
  const other = renderHook(() => useActivityVisibility({}));
  expect(other.result.current.expanded).toEqual({});
  second.unmount();
  other.unmount();
});

it("keeps simultaneous views of the same chat consistent", () => {
  const document = {};
  const first = renderHook(() => useActivityVisibility(document));
  const second = renderHook(() => useActivityVisibility(document));
  act(() => first.result.current.setExplicit(() => ({ turn: true })));
  expect(second.result.current.explicit.turn).toBe(true);
  first.unmount();
  second.unmount();
});
