/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { computeMinimapLayout, viewportFromSegments } from "./block-minimap";
import type { MinimapBarSegment, MinimapBlock } from "./block-minimap";

describe("computeMinimapLayout", () => {
  const block = (id: string, pixelHeight: number): MinimapBlock => ({
    id,
    pixelHeight,
    color: "#ccc",
  });

  const stackBottom = (segments: MinimapBarSegment[]): number => {
    const last = segments[segments.length - 1];
    return last.top + last.height;
  };

  it("spans the minimap height for a few large blocks", () => {
    const segments = computeMinimapLayout(
      [block("a", 500), block("b", 300), block("c", 200)],
      400,
    );
    expect(segments).toHaveLength(3);
    // proportional: a is half the document
    expect(segments[0].height).toBeGreaterThan(segments[1].height);
    expect(stackBottom(segments)).toBeLessThanOrEqual(400);
    expect(stackBottom(segments)).toBeGreaterThan(390);
  });

  it("does not overflow with many small blocks (min-height clamp)", () => {
    // 200 blocks of 10px in a 300px minimap: unnormalized min heights + gaps
    // would need 800px
    const segments = computeMinimapLayout(
      Array.from({ length: 200 }, (_, i) => block(`c${i}`, 10)),
      300,
    );
    expect(stackBottom(segments)).toBeLessThanOrEqual(300);
    expect(stackBottom(segments)).toBeGreaterThan(295);
    for (const seg of segments) {
      expect(seg.height).toBeGreaterThan(0);
    }
  });

  it("returns [] for empty input or non-positive height", () => {
    expect(computeMinimapLayout([], 100)).toEqual([]);
    expect(computeMinimapLayout([block("a", 10)], 0)).toEqual([]);
  });
});

describe("viewportFromSegments", () => {
  const segments: MinimapBarSegment[] = [
    { block: { id: "a" } as any, top: 0, height: 100 },
    { block: { id: "b" } as any, top: 102, height: 100 },
    { block: { id: "c" } as any, top: 204, height: 96 },
  ];

  it("anchors the viewport to the visible block fractions", () => {
    const vp = viewportFromSegments(segments, {
      firstId: "a",
      firstFrac: 0.5,
      lastId: "b",
      lastFrac: 0.25,
    });
    expect(vp).toEqual({ top: 50, bottom: 127 });
  });

  it("is null without a range or with unknown blocks", () => {
    expect(viewportFromSegments(segments, null)).toBeNull();
    expect(
      viewportFromSegments(segments, {
        firstId: "nope",
        firstFrac: 0,
        lastId: "b",
        lastFrac: 1,
      }),
    ).toBeNull();
  });
});
