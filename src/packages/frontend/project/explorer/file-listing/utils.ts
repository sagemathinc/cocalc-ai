/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  FileAction,
  ProjectActions,
} from "@cocalc/frontend/project_actions";
import { FILE_ACTIONS } from "@cocalc/frontend/project_actions";
import { triggerFileAction } from "@cocalc/frontend/project/file-action-trigger";

export const TERM_MODE_CHARS = ["/", "!"] as const;
export const TERM_MODE_CHAR = "/";
export const AGENT_MODE_CHAR = "@";

export function isTerminalMode(search: string): boolean {
  return search.length > 0 && TERM_MODE_CHARS.includes(search[0] as any);
}

export function isAgentMode(search: string): boolean {
  return search.length > 0 && search[0] === AGENT_MODE_CHAR;
}

export function extractAgentPrompt(search: string): string {
  if (!isAgentMode(search)) return "";
  return search.slice(1).trim();
}

type Extension =
  | "sagews"
  | "ipynb"
  | "tex"
  | "term"
  | "x11"
  | "rnw"
  | "rtex"
  | "rmd"
  | "md"
  | "tasks"
  | "course"
  | "sage"
  | "board"
  | "slides"
  | "py"
  | "chat"
  | "sage-chat"
  | "txt";

export const VIEWABLE_FILE_EXT: Readonly<string[]> = [
  "c",
  "cc",
  "cfg",
  "conf",
  "cpp",
  "css",
  "csv",
  "go",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "log",
  "lua",
  "md",
  "pdf",
  "pl",
  "png",
  "py",
  "qmd",
  "r",
  "rb",
  "rmd",
  "rs",
  "rst",
  "rtex",
  "sass",
  "scss",
  "sh",
  "svg",
  "tex",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
] as const;

// default extensions, in their order of precedence
// the order of these buttons also determines the precedence of suggested file extensions
// see also @cocalc/frontend/project-files.ts
export const EXTs: ReadonlyArray<Extension> = Object.freeze([
  "ipynb",
  "term",
  "board",
  "slides",
  "md",
  "sagews",
  "tex",
  "course",
  "py",
  "rnw",
  "rtex",
  "rmd",
  "tasks",
  "x11",
  "sage",
  "chat",
  "sage-chat",
]);

export function default_ext(disabled_ext: string[] | undefined): Extension {
  if (disabled_ext != null) {
    for (const ext of EXTs) {
      if (disabled_ext.includes(ext)) continue;
      return ext;
    }
  }
  // fallback, markdown files always work.
  return "md";
}

// Returns the full file_search text in addition to the default extension if applicable
// disabled_ext contains such file extensions, which aren't available in the project.
// e.g. do not autocomplete to a disabled extension
export function full_path_text(file_search: string, disabled_ext: string[]) {
  let ext;
  if (file_search.lastIndexOf(".") <= file_search.lastIndexOf("/")) {
    ext = default_ext(disabled_ext);
  }
  if (ext && file_search.slice(-1) !== "/") {
    return `${file_search}.${ext}`;
  } else {
    return `${file_search}`;
  }
}

export function generate_click_for(
  file_action_name: FileAction,
  full_path: string,
  project_actions: ProjectActions,
) {
  return (e) => {
    e.preventDefault();
    e.stopPropagation();
    triggerFileAction({
      actions: project_actions,
      action: file_action_name,
      path: full_path,
      multiple: !!FILE_ACTIONS[file_action_name].allows_multiple_files,
    });
  };
}

export function sortedTypeFilterOptions(
  extensions: Iterable<string>,
): string[] {
  const extSet = new Set(extensions);
  const result: string[] = [];

  if (extSet.has("folder")) {
    result.push("folder");
    extSet.delete("folder");
  }

  for (const ext of EXTs) {
    if (extSet.has(ext)) {
      result.push(ext);
      extSet.delete(ext);
    }
  }

  result.push(...Array.from(extSet).sort());
  return result;
}

export { TypeFilterLabel } from "./components";
