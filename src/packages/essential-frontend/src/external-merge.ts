/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export type ExternalMergeResult =
  | { clean: true; dirty: boolean }
  | { clean: false; message: string };

export interface ExternalMergeHandle {
  mergeExternal(contents: string): ExternalMergeResult;
}
