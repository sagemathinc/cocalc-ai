/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

type FileEditorRegistryState = {
  file_editors: { [ext: string]: any };
  altExt: { [project_id_path: string]: string | undefined };
  known_extensions: Set<string>;
};

const FILE_EDITOR_REGISTRY_KEY = "__COCALC_FILE_EDITOR_REGISTRY__";

export function getFileEditorRegistryState(): FileEditorRegistryState {
  const g = globalThis as typeof globalThis & {
    [FILE_EDITOR_REGISTRY_KEY]?: FileEditorRegistryState;
  };
  const existing = g[FILE_EDITOR_REGISTRY_KEY];
  if (existing != null) {
    return existing;
  }
  const created: FileEditorRegistryState = {
    // Keep the editor registry stable across long-lived sessions where
    // individual modules may be re-evaluated after frontend updates.
    file_editors: {},
    altExt: {},
    known_extensions: new Set<string>(),
  };
  g[FILE_EDITOR_REGISTRY_KEY] = created;
  return created;
}

export function markEditorExtensionRegistered(ext: string): void {
  getFileEditorRegistryState().known_extensions.add(ext);
}

export function wasEditorExtensionRegistered(ext: string): boolean {
  return getFileEditorRegistryState().known_extensions.has(ext);
}

export function resetFileEditorRegistryForTests(): void {
  const g = globalThis as typeof globalThis & {
    [FILE_EDITOR_REGISTRY_KEY]?: FileEditorRegistryState;
  };
  delete g[FILE_EDITOR_REGISTRY_KEY];
}
