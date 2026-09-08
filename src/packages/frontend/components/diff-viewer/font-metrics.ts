import type { CSSProperties } from "react";

export function diffLineHeight(fontSize: number): number {
  return Math.ceil(fontSize * 1.5);
}

// Shadow-root code does not inherit the host's font-size. Keep Pierre's CSS
// variables and virtual line estimates in sync when the editor font changes.
export function diffFontStyle(fontSize: number): CSSProperties {
  return {
    fontSize,
    "--diffs-font-size": `${fontSize}px`,
    "--diffs-line-height": `${diffLineHeight(fontSize)}px`,
  } as CSSProperties;
}
