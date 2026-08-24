/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const READ_ONLY_PREVIEW_VISIBLE_MENU = "view";

export function frameTitleBarMenuVisible({
  name,
  readOnlyPreview,
}: {
  name: string;
  readOnlyPreview: boolean;
}): boolean {
  if (!readOnlyPreview) return true;
  return name === READ_ONLY_PREVIEW_VISIBLE_MENU;
}

export function frameTitleBarTerminalButtonVisible({
  readOnlyPreview,
  terminalsDisabled,
  type,
}: {
  readOnlyPreview: boolean;
  terminalsDisabled: boolean;
  type: string;
}): boolean {
  return !readOnlyPreview && !terminalsDisabled && type !== "terminal";
}

export function frameTitleBarRunButtonVisible({
  readOnlyPreview,
  terminalsDisabled,
}: {
  readOnlyPreview: boolean;
  terminalsDisabled: boolean;
}): boolean {
  // Running a file needs a terminal, and it needs the file on disk to be the
  // file being shown -- neither holds for a read-only preview.
  return !readOnlyPreview && !terminalsDisabled;
}

export function frameTitleBarTimeTravelButtonVisible({
  readOnlyPreview,
}: {
  readOnlyPreview: boolean;
}): boolean {
  return !readOnlyPreview;
}

export function frameTitleBarAgentButtonVisible({
  readOnlyPreview,
}: {
  readOnlyPreview: boolean;
}): boolean {
  return !readOnlyPreview;
}
