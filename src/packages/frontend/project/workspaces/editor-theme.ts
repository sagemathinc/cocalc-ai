/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WorkspaceRecord } from "./types";
import type { ResolvedAppearance } from "@cocalc/util/appearance";
import { resolveAppearanceEditorTheme } from "@cocalc/util/appearance-editor";

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

function accountEditorTheme(
  editorSettings?: {
    get?: (key: string, notSetValue?: any) => any;
    theme?: string | null;
  } | null,
): string | null {
  if (editorSettings == null) {
    return null;
  }
  if (typeof editorSettings.get === "function") {
    return normalizeWorkspaceEditorTheme(editorSettings.get("theme"));
  }
  return normalizeWorkspaceEditorTheme(editorSettings.theme);
}

export function effectiveEditorThemeName(
  editorSettings?: {
    get?: (key: string, notSetValue?: any) => any;
    theme?: string | null;
  } | null,
  record?: Pick<WorkspaceRecord, "editor_theme"> | null,
  appearance: ResolvedAppearance = "light",
): string | null {
  return resolveAppearanceEditorTheme(
    workspaceEditorTheme(record) ?? accountEditorTheme(editorSettings),
    appearance,
  );
}

export function effectiveImmutableEditorSettings<
  T extends
    | {
        get: (key: string, notSetValue?: any) => any;
        set: (key: string, value: any) => T;
      }
    | undefined
    | null,
>(
  editorSettings: T,
  record?: Pick<WorkspaceRecord, "editor_theme"> | null,
  appearance: ResolvedAppearance = "light",
): T {
  if (editorSettings == null) {
    return editorSettings;
  }
  const theme = effectiveEditorThemeName(editorSettings, record, appearance);
  if (!theme || editorSettings.get("theme") === theme) {
    return editorSettings;
  }
  return editorSettings.set("theme", theme) as T;
}

export function effectivePlainEditorSettings<T extends { theme?: string }>(
  editorSettings: T,
  record?: Pick<WorkspaceRecord, "editor_theme"> | null,
  appearance: ResolvedAppearance = "light",
): T {
  const theme = effectiveEditorThemeName(editorSettings, record, appearance);
  if (!theme || editorSettings.theme === theme) {
    return editorSettings;
  }
  return { ...editorSettings, theme };
}
