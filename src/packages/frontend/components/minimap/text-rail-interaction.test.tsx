/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import React, { useRef } from "react";

import {
  computeTextMinimapGeometry,
  MINIMAP_SCROLLBAR_ARIA,
  type TextMinimapGeometry,
  useTextMinimapRail,
} from "./text-rail";

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

const GEOMETRY = computeTextMinimapGeometry({
  trackHeight: 2000,
  railHeight: 500,
  docContentHeight: 10000,
  docClientHeight: 500,
  docScrollTop: 0,
});

function Harness({
  geometry = GEOMETRY,
  scrollDocTo,
  scrollDocBy,
}: {
  geometry?: TextMinimapGeometry;
  scrollDocTo: (top: number) => void;
  scrollDocBy: (delta: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const rail = useTextMinimapRail({
    railRef,
    getGeometry: () => geometry,
    scrollDocTo,
    scrollDocBy,
  });
  return (
    <div
      ref={railRef}
      {...MINIMAP_SCROLLBAR_ARIA}
      aria-label="Test text minimap"
      onPointerDown={rail.onPointerDown}
      onPointerMove={rail.onPointerMove}
      onPointerUp={rail.onPointerUp}
      onKeyDown={rail.onKeyDown}
    />
  );
}

function mockRailBounds(rail: HTMLElement): void {
  jest.spyOn(rail, "getBoundingClientRect").mockReturnValue({
    top: 100,
    bottom: 600,
    left: 0,
    right: 40,
    width: 40,
    height: 500,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  });
  Object.defineProperty(rail, "setPointerCapture", { value: jest.fn() });
  Object.defineProperty(rail, "releasePointerCapture", { value: jest.fn() });
}

describe("text minimap rail interactions", () => {
  it("drags the viewport to the exact top, middle, and bottom", () => {
    const scrollDocTo = jest.fn();
    render(<Harness scrollDocTo={scrollDocTo} scrollDocBy={jest.fn()} />);
    const rail = screen.getByRole("scrollbar", {
      name: "Test text minimap",
    });
    mockRailBounds(rail);

    // Grab 25px below the top of the 100px viewport rectangle.
    fireEvent.pointerDown(rail, {
      button: 0,
      pointerId: 1,
      clientY: 125,
    });
    fireEvent.pointerMove(rail, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(rail, { pointerId: 1, clientY: 325 });
    fireEvent.pointerMove(rail, { pointerId: 1, clientY: 600 });
    fireEvent.pointerUp(rail, { pointerId: 1, clientY: 600 });

    expect(scrollDocTo.mock.calls.map(([top]) => top)).toEqual([
      0,
      GEOMETRY.docMax / 2,
      GEOMETRY.docMax,
    ]);
  });

  it("jumps on a track click and keeps dragging from there", () => {
    const scrollDocTo = jest.fn();
    render(<Harness scrollDocTo={scrollDocTo} scrollDocBy={jest.fn()} />);
    const rail = screen.getByRole("scrollbar", {
      name: "Test text minimap",
    });
    mockRailBounds(rail);

    fireEvent.pointerDown(rail, {
      button: 0,
      pointerId: 2,
      clientY: 350,
    });
    fireEvent.pointerMove(rail, { pointerId: 2, clientY: 600 });

    expect(scrollDocTo).toHaveBeenNthCalledWith(1, GEOMETRY.docMax / 2);
    expect(scrollDocTo).toHaveBeenLastCalledWith(GEOMETRY.docMax);
  });

  it("routes wheel and keyboard scrolling to the document", () => {
    const scrollDocTo = jest.fn();
    const scrollDocBy = jest.fn();
    render(<Harness scrollDocTo={scrollDocTo} scrollDocBy={scrollDocBy} />);
    const rail = screen.getByRole("scrollbar", {
      name: "Test text minimap",
    });

    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 123,
    });
    rail.dispatchEvent(wheel);
    fireEvent.keyDown(rail, { key: "PageDown" });
    fireEvent.keyDown(rail, { key: "Home" });
    fireEvent.keyDown(rail, { key: "End" });

    expect(wheel.defaultPrevented).toBe(true);
    expect(scrollDocBy).toHaveBeenNthCalledWith(1, 123);
    expect(scrollDocBy).toHaveBeenNthCalledWith(2, 450);
    expect(scrollDocTo).toHaveBeenNthCalledWith(1, 0);
    expect(scrollDocTo).toHaveBeenNthCalledWith(2, GEOMETRY.docMax);
  });
});
