/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";

import { COLORS } from "@cocalc/util/theme";
import { BlockMinimap } from "./block-minimap";
import type { MinimapBlock, MinimapDocAdapter } from "./block-minimap";

// jsdom does not expose PointerEvent. React's pointer handlers still work
// with MouseEvent coordinates, which is all these interaction tests need.
const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: MouseEvent,
  });
});
afterAll(() => {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: originalPointerEvent,
  });
});

const BLOCKS: MinimapBlock[] = [
  { id: "a", pixelHeight: 400, color: COLORS.GRAY },
  { id: "b", pixelHeight: 300, color: COLORS.GRAY },
  { id: "c", pixelHeight: 300, color: COLORS.GRAY },
];

function makeAdapter() {
  let scrollTop = 0;
  let notify: (() => void) | undefined;
  const adapter: MinimapDocAdapter = {
    visibleRange: () => null,
    scrollToBlock: jest.fn(() => false),
    metrics: () => ({ scrollTop, scrollHeight: 1000, clientHeight: 200 }),
    scrollToPosition: jest.fn((top: number) => {
      scrollTop = top;
      notify?.();
    }),
    scrollBy: jest.fn(),
    subscribe: (onChange) => {
      notify = onChange;
      return () => {
        notify = undefined;
      };
    },
  };
  return { adapter };
}

function mockMinimapBounds(minimap: HTMLElement): void {
  jest.spyOn(minimap, "getBoundingClientRect").mockReturnValue({
    top: 0,
    bottom: 500,
    left: 0,
    right: 40,
    width: 40,
    height: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Object.defineProperty(minimap, "setPointerCapture", { value: jest.fn() });
}

describe("block minimap rendered interactions", () => {
  it("moves the viewport to the top, middle, and bottom while dragging", async () => {
    const { adapter } = makeAdapter();
    render(
      <BlockMinimap
        blocks={BLOCKS}
        height={516}
        width={40}
        adapter={adapter}
        label="Test block minimap"
      />,
    );
    const minimap = screen.getByRole("scrollbar", {
      name: "Test block minimap",
    });
    mockMinimapBounds(minimap);
    const viewport = minimap.querySelector<HTMLElement>(
      '[data-cocalc-minimap-viewport="1"]',
    );
    expect(viewport).not.toBeNull();
    expect(viewport).toHaveStyle({ top: "0px", height: "100px" });

    fireEvent.pointerDown(minimap, {
      button: 0,
      pointerId: 1,
      clientY: 25,
    });
    fireEvent.pointerMove(minimap, { pointerId: 1, clientY: 0 });
    await waitFor(() => expect(minimap).toHaveAttribute("aria-valuenow", "0"));

    fireEvent.pointerMove(minimap, { pointerId: 1, clientY: 225 });
    await waitFor(() => {
      expect(minimap).toHaveAttribute("aria-valuenow", "50");
      expect(viewport).toHaveStyle({ top: "200px" });
    });

    fireEvent.pointerMove(minimap, { pointerId: 1, clientY: 500 });
    await waitFor(() => {
      expect(minimap).toHaveAttribute("aria-valuenow", "100");
      expect(viewport).toHaveStyle({ top: "400px" });
    });
    fireEvent.pointerUp(minimap, { pointerId: 1, clientY: 500 });

    expect(adapter.scrollToPosition).toHaveBeenCalledWith(0);
    expect(adapter.scrollToPosition).toHaveBeenCalledWith(400);
    expect(adapter.scrollToPosition).toHaveBeenCalledWith(800);
  });

  it("jumps on track clicks and routes wheel and keyboard scrolling", () => {
    const { adapter } = makeAdapter();
    render(
      <BlockMinimap
        blocks={BLOCKS}
        height={516}
        width={40}
        adapter={adapter}
        label="Test block minimap"
      />,
    );
    const minimap = screen.getByRole("scrollbar", {
      name: "Test block minimap",
    });
    mockMinimapBounds(minimap);

    fireEvent.pointerDown(minimap, {
      button: 0,
      pointerId: 2,
      clientY: 250,
    });
    expect(adapter.scrollToBlock).toHaveBeenCalled();
    expect(adapter.scrollToPosition).toHaveBeenCalledWith(400);

    fireEvent.wheel(minimap, { deltaY: 123 });
    fireEvent.keyDown(minimap, { key: "PageDown" });
    fireEvent.keyDown(minimap, { key: "Home" });
    fireEvent.keyDown(minimap, { key: "End" });

    expect(adapter.scrollBy).toHaveBeenNthCalledWith(1, 123);
    expect(adapter.scrollBy).toHaveBeenNthCalledWith(2, 180);
    expect(adapter.scrollToPosition).toHaveBeenCalledWith(0);
    expect(adapter.scrollToPosition).toHaveBeenCalledWith(800);
  });

  it("does not scroll or expose a scrollbar for a short document", () => {
    const adapter: MinimapDocAdapter = {
      visibleRange: () => null,
      scrollToBlock: jest.fn(() => false),
      metrics: () => ({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }),
      scrollToPosition: jest.fn(),
      scrollBy: jest.fn(),
      subscribe: () => () => {},
    };
    render(
      <BlockMinimap
        blocks={[{ id: "a", pixelHeight: 100, color: COLORS.GRAY }]}
        height={516}
        adapter={adapter}
        label="Short document minimap"
      />,
    );
    const minimap = screen.getByRole("presentation");
    mockMinimapBounds(minimap);

    act(() => {
      fireEvent.pointerDown(minimap, {
        button: 0,
        pointerId: 3,
        clientY: 250,
      });
    });

    expect(adapter.scrollToBlock).not.toHaveBeenCalled();
    expect(adapter.scrollToPosition).not.toHaveBeenCalled();
    expect(
      minimap.querySelector('[data-cocalc-minimap-viewport="1"]'),
    ).toBeNull();
  });
});
