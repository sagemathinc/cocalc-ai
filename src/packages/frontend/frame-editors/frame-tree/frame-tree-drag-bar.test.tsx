/** @jest-environment jsdom */

import React from "react";
import { act, render } from "@testing-library/react";
import { fromJS } from "immutable";
import { FrameTreeDragBar } from "./frame-tree-drag-bar";

let mockStop: (event: unknown, ui: unknown) => void;
jest.mock("react-draggable", () => ({
  __esModule: true,
  default: ({ onStop, children }) => {
    mockStop = onStop;
    return children;
  },
}));
jest.mock("@cocalc/frontend/feature", () => ({ IS_TOUCH: false }));
jest.mock("@cocalc/frontend/misc", () => ({
  drag_start_iframe_disable: jest.fn(),
  drag_stop_iframe_enable: jest.fn(),
}));

it("resizes visible neighbors across a hidden shell without changing its saved size", () => {
  const actions = { set_frame_tree: jest.fn(), focus: jest.fn() };
  render(
    <FrameTreeDragBar
      actions={actions as any}
      dir="col"
      frame_tree={fromJS({ id: "split", sizes: [0.4, 0.2, 0.4] }) as any}
      childIndex={2}
      visibleChildIndices={[0, 2]}
      containerRef={{ current: { offsetLeft: 0, offsetWidth: 1000 } } as any}
    />,
  );
  act(() => mockStop(null, { node: { offsetLeft: 247 }, x: 0 }));
  const update = actions.set_frame_tree.mock.calls[0][0];
  expect(update.id).toBe("split");
  expect(update.sizes[0]).toBeCloseTo(0.2);
  expect(update.sizes[1]).toBe(0.2);
  expect(update.sizes[2]).toBeCloseTo(0.6);
});
