/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";

// Shared placement and box-sizing helpers for sparkline hover tooltips.

export type SparklineHoverPlacement = {
  left?: string;
  right?: string;
  transform: string;
};

function percent(value: number): string {
  return `${Number((value * 100).toFixed(2))}%`;
}

export function sparklineHoverPlacement(
  xFraction: number,
): SparklineHoverPlacement {
  const clamped = Math.max(0, Math.min(1, xFraction));
  if (clamped <= 0.18) {
    return {
      left: percent(clamped),
      transform: "translate(0, calc(-100% - 14px))",
    };
  }
  if (clamped >= 0.82) {
    return {
      right: percent(1 - clamped),
      transform: "translate(0, calc(-100% - 14px))",
    };
  }
  return {
    left: percent(clamped),
    transform: "translate(-50%, calc(-100% - 14px))",
  };
}

export function sparklineTooltipBoxStyle({
  placement,
  maxWidth,
}: {
  placement: SparklineHoverPlacement;
  maxWidth: number;
}): CSSProperties {
  return {
    ...placement,
    width: "max-content",
    maxWidth: `${maxWidth}px`,
    boxSizing: "border-box",
  };
}
