/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { computeTextMinimapGeometry, scrollDeltaForKey } from "./text-rail";

describe("computeTextMinimapGeometry", () => {
  // A long document: the minimap track is taller than the rail, so the track
  // scrolls inside the rail and the rectangle travels only the remainder.
  const long = (docScrollTop: number) =>
    computeTextMinimapGeometry({
      trackHeight: 2000,
      railHeight: 500,
      docContentHeight: 10000,
      docClientHeight: 500,
      docScrollTop,
    });

  it("puts the rectangle at the top when unscrolled", () => {
    const geo = long(0);
    expect(geo.ratio).toBe(0);
    expect(geo.miniScrollTop).toBe(0);
    expect(geo.thumbTop).toBe(0);
  });

  it("moves the rectangle and the track together", () => {
    const geo = long(9500); // fully scrolled
    expect(geo.ratio).toBe(1);
    expect(geo.miniScrollTop).toBe(1500); // track - rail
    expect(geo.thumbTop).toBeCloseTo(geo.thumbTravel);
    expect(geo.thumbTop + geo.thumbHeight).toBeLessThanOrEqual(500);
  });

  it("inverts: thumbTop/thumbTravel recovers the scroll ratio", () => {
    const geo = long(4750); // half way
    expect(geo.ratio).toBeCloseTo(0.5);
    expect(geo.thumbTop / geo.thumbTravel).toBeCloseTo(0.5);
  });

  it("clamps out-of-range scroll positions", () => {
    expect(long(-100).ratio).toBe(0);
    expect(long(1e9).ratio).toBe(1);
  });

  it("reports a scrollable document", () => {
    expect(long(0).scrollable).toBe(true);
  });

  it("fills the rail when the document fits on screen", () => {
    const geo = computeTextMinimapGeometry({
      trackHeight: 200,
      railHeight: 500,
      docContentHeight: 400,
      docClientHeight: 400,
      docScrollTop: 0,
    });
    expect(geo.miniScrollTop).toBe(0);
    expect(geo.thumbHeight).toBe(200); // whole (short) track
    expect(geo.thumbTravel).toBe(0);
    // nothing to scroll: callers hide the viewport rectangle
    expect(geo.scrollable).toBe(false);
  });
});

describe("scrollDeltaForKey", () => {
  it("maps the scrolling keys", () => {
    expect(scrollDeltaForKey("ArrowUp", 500)).toBeLessThan(0);
    expect(scrollDeltaForKey("ArrowDown", 500)).toBeGreaterThan(0);
    expect(scrollDeltaForKey("PageDown", 500)).toBe(450);
    expect(scrollDeltaForKey("PageUp", 500)).toBe(-450);
    expect(scrollDeltaForKey("Home", 500)).toBe("start");
    expect(scrollDeltaForKey("End", 500)).toBe("end");
  });

  it("keeps a usable page step for tiny minimaps", () => {
    expect(scrollDeltaForKey("PageDown", 10)).toBe(40);
  });

  it("ignores other keys", () => {
    expect(scrollDeltaForKey("a", 500)).toBeNull();
    expect(scrollDeltaForKey("Enter", 500)).toBeNull();
  });
});
