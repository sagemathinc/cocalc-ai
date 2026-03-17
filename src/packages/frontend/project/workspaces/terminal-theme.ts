/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Map as ImmutableMap } from "immutable";
import type { WorkspaceRecord } from "./types";

export function normalizeWorkspaceTerminalTheme(
  theme?: string | null,
): string | null {
  const trimmed = `${theme ?? ""}`.trim();
  return trimmed || null;
}

export function workspaceTerminalTheme(
  record?: Pick<WorkspaceRecord, "terminal_theme"> | null,
): string | null {
  return normalizeWorkspaceTerminalTheme(record?.terminal_theme);
}

export function effectiveTerminalColorScheme(
  terminal?: ImmutableMap<string, any> | null,
  record?: Pick<WorkspaceRecord, "terminal_theme"> | null,
): string {
  return (
    workspaceTerminalTheme(record) ?? terminal?.get("color_scheme") ?? "default"
  );
}
