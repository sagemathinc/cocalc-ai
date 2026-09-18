/** @jest-environment jsdom */

import {
  canShowCellDragHandle,
  captureNotebookScrollPosition,
  notebookScrollTarget,
  restoreNotebookScroll,
  updateLazyCellHeights,
} from "./cell-list";

function makeScroller({
  scrollTop,
  getScrollHeight,
}: {
  scrollTop: number;
  getScrollHeight: () => number;
}): HTMLElement {
  const element = document.createElement("div");
  element.scrollTop = scrollTop;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: getScrollHeight,
  });
  return element;
}

describe("restoreNotebookScroll", () => {
  it("keeps restoring while rendering changes scroll height", async () => {
    let scrollHeight = 100;
    const scroller = makeScroller({
      scrollTop: 0,
      getScrollHeight: () => scrollHeight,
    });
    const waits: number[] = [];

    await restoreNotebookScroll({
      scrollTop: 25,
      getElement: () => scroller,
      isMounted: () => true,
      wait: async (ms) => {
        waits.push(ms);
        scrollHeight += 100;
      },
    });

    expect(scroller.scrollTop).toBe(25);
    expect(waits).toEqual([0, 1, 100, 250, 500, 1000]);
  });

  it("stops restoring when the user scrolls away from the saved position", async () => {
    let cancelled = false;
    let scrollHeight = 100;
    const scroller = makeScroller({
      scrollTop: 0,
      getScrollHeight: () => scrollHeight,
    });

    await restoreNotebookScroll({
      scrollTop: 25,
      getElement: () => scroller,
      isMounted: () => true,
      shouldCancel: () => cancelled,
      wait: async (ms) => {
        if (ms !== 0) return;
        scrollHeight = 300;
        scroller.scrollTop = 180;
        cancelled = true;
      },
    });

    expect(scroller.scrollTop).toBe(180);
  });

  it("captures and restores a visible cell anchor when content above changes", () => {
    const scroller = makeScroller({
      scrollTop: 300,
      getScrollHeight: () => 2000,
    });
    scroller.getBoundingClientRect = jest
      .fn()
      .mockReturnValue({ top: 100, bottom: 600 });
    const hidden = document.createElement("div");
    hidden.setAttribute("data-jupyter-lazy-cell-id", "hidden");
    hidden.getBoundingClientRect = jest
      .fn()
      .mockReturnValue({ top: 0, bottom: 90 });
    const visible = document.createElement("div");
    visible.setAttribute("data-jupyter-lazy-cell-id", "visible");
    visible.getBoundingClientRect = jest
      .fn()
      .mockReturnValue({ top: 80, bottom: 300 });
    scroller.append(hidden, visible);
    const position = { current: 0 };

    captureNotebookScrollPosition(scroller, position);
    expect(position).toEqual({
      current: 300,
      anchor: { cellId: "visible", offset: -20 },
    });

    visible.getBoundingClientRect = jest
      .fn()
      .mockReturnValue({ top: 180, bottom: 400 });
    expect(notebookScrollTarget(scroller, position)).toBe(400);
  });
});

describe("canShowCellDragHandle", () => {
  it("fails closed while notebook actions have no store", () => {
    expect(canShowCellDragHandle({} as any, "cell-1")).toBe(false);
  });

  it("uses the notebook store's editability decision", () => {
    const is_cell_editable = jest.fn(() => true);
    const actions = { store: { is_cell_editable } } as any;

    expect(canShowCellDragHandle(actions, "cell-1")).toBe(true);
    expect(is_cell_editable).toHaveBeenCalledWith("cell-1");
  });
});

describe("updateLazyCellHeights", () => {
  it("updates measured hydrated cell heights only when they change", () => {
    const container = document.createElement("div");
    const cell = document.createElement("div");
    cell.setAttribute("data-jupyter-lazy-cell-id", "cell-1");
    cell.setAttribute("data-jupyter-lazy-cell-hydrated", "1");
    cell.getBoundingClientRect = jest
      .fn()
      .mockReturnValueOnce({ height: 120 })
      .mockReturnValueOnce({ height: 120 })
      .mockReturnValueOnce({ height: 140 });
    container.appendChild(cell);
    const heights: Record<string, number> = {};

    expect(updateLazyCellHeights(container, heights)).toBe(true);
    expect(heights).toEqual({ "cell-1": 120 });
    expect(updateLazyCellHeights(container, heights)).toBe(false);
    expect(updateLazyCellHeights(container, heights)).toBe(true);
    expect(heights).toEqual({ "cell-1": 140 });
  });
});
