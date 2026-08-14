/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  FILE_RECENCY_BORDER_WIDTH_PX,
  FILE_RECENCY_COLOR_NONE,
  fileRecencyBorder,
  fileRecencyColor,
} from "./file-recency";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("fileRecencyColor", () => {
  const now = Date.now();

  it("is green for files touched within the last hour", () => {
    expect(fileRecencyColor(now - MINUTE)).toEqual(fileRecencyColor(now));
    expect(fileRecencyColor(now)).toMatch(/^rgba\(/);
    // green channel dominates
    const [r, g] = parseRGBA(fileRecencyColor(now));
    expect(g).toBeGreaterThan(r);
  });

  it("fades within the last day, but stays visible", () => {
    const [, , , alpha] = parseRGBA(fileRecencyColor(now - 12 * HOUR));
    expect(alpha).toBeGreaterThan(0.5);
    expect(alpha).toBeLessThan(1);
  });

  it("is transparent for files older than two weeks", () => {
    expect(fileRecencyColor(now - 20 * DAY)).toEqual(FILE_RECENCY_COLOR_NONE);
    // no mtime at all, e.g. the parent directory entry
    expect(fileRecencyColor()).toEqual(FILE_RECENCY_COLOR_NONE);
  });

  it("does not break for timestamps in the future", () => {
    expect(fileRecencyColor(now + DAY)).toEqual(fileRecencyColor(now));
  });
});

describe("fileRecencyBorder", () => {
  it("always sets a left border of the same width, so rows line up", () => {
    const recent = fileRecencyBorder(Date.now());
    const old = fileRecencyBorder(Date.now() - 100 * DAY);
    expect(recent.borderLeft).toContain(
      `${FILE_RECENCY_BORDER_WIDTH_PX} solid`,
    );
    expect(old.borderLeft).toEqual(
      `${FILE_RECENCY_BORDER_WIDTH_PX} solid ${FILE_RECENCY_COLOR_NONE}`,
    );
  });
});

function parseRGBA(color: string): [number, number, number, number] {
  const m = color.match(
    /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/,
  );
  if (m == null) {
    throw Error(`unable to parse color '${color}'`);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}
