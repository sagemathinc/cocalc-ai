/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WorkspaceRecord } from "./types";

export function normalizeWorkspaceEditorTheme(
  theme?: string | null,
): string | null {
  const trimmed = `${theme ?? ""}`.trim();
  return trimmed || null;
}

export function workspaceEditorTheme(
  record?: Pick<WorkspaceRecord, "editor_theme"> | null,
): string | null {
  return normalizeWorkspaceEditorTheme(record?.editor_theme);
}

export function effectiveImmutableEditorSettings<
  T extends
    | {
        get: (key: string, notSetValue?: any) => any;
        set: (key: string, value: any) => T;
      }
    | undefined
    | null,
>(editorSettings: T, record?: Pick<WorkspaceRecord, "editor_theme"> | null): T {
  if (editorSettings == null) {
    return editorSettings;
  }
  const theme = workspaceEditorTheme(record);
  if (!theme || editorSettings.get("theme") === theme) {
    return editorSettings;
  }
  return editorSettings.set("theme", theme) as T;
}

export function effectivePlainEditorSettings<T extends { theme?: string }>(
  editorSettings: T,
  record?: Pick<WorkspaceRecord, "editor_theme"> | null,
): T {
  const theme = workspaceEditorTheme(record);
  if (!theme || editorSettings.theme === theme) {
    return editorSettings;
  }
  return { ...editorSettings, theme };
}
