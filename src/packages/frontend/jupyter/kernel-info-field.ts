/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

type KernelInfoLike =
  | {
      get?: (key: string) => unknown;
      [key: string]: unknown;
    }
  | undefined
  | null;

export function kernelInfoField(
  kernelInfo: KernelInfoLike,
  key: string,
  fallback: string,
): string {
  const value =
    kernelInfo?.get?.(key) ??
    (kernelInfo as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
