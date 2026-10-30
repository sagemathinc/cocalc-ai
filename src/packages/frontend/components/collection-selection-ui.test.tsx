/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, renderHook } from "@testing-library/react";
import { useCollectionSelection } from "./collection-selection-ui";

test("an item hidden by a search leaves the selection, and doesn't come back", () => {
  const { result, rerender } = renderHook(
    ({ order }) => useCollectionSelection({ order }),
    { initialProps: { order: ["a", "b", "c"] } },
  );
  act(() => result.current.toggle("a", true, false));
  act(() => result.current.toggle("c", true, false));
  expect(result.current.selectedIds).toEqual(["a", "c"]);
  // A search hides "c".
  rerender({ order: ["a", "b"] });
  expect(result.current.selectedIds).toEqual(["a"]);
  // The search is cleared: "c" is shown again, but not selected.
  rerender({ order: ["a", "b", "c"] });
  expect(result.current.selectedIds).toEqual(["a"]);
  expect(result.current.isSelected("c")).toBe(false);
});

test("select all covers what is shown; a reset key starts over", () => {
  const { result, rerender } = renderHook(
    ({ order, resetKey }) => useCollectionSelection({ order, resetKey }),
    { initialProps: { order: ["a", "b"], resetKey: "mine" } },
  );
  act(() => result.current.setAll(true));
  expect(result.current.allSelected).toBe(true);
  rerender({ order: ["a", "b"], resetKey: "shared" });
  expect(result.current.selectedIds).toEqual([]);
});
