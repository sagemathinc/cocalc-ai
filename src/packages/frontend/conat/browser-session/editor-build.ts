/*
Trigger a document build (LaTeX, R Markdown, Quarto, ...) from the browser exec
API and report what the editor's own build state says afterwards.

This is deliberately separate from `bash.run`: running `latexmk` in a shell
produces output the agent can read, but leaves the editor's build log and error
panel showing the previous failure.  Going through the editor actions updates
exactly the UI the user is looking at.
*/

import { documentExtension } from "@cocalc/util/document-build";
import {
  readEditorBuildOutcome,
  truncateBuildLog,
  type BrowserEditorBuildJob,
} from "@cocalc/frontend/frame-editors/generic/build-outcome";

import { asFinitePositive } from "./common-utils";

export { readEditorBuildOutcome, truncateBuildLog };
export type {
  BrowserEditorBuildJob,
  EditorBuildOutcome,
} from "@cocalc/frontend/frame-editors/generic/build-outcome";

export const DEFAULT_EDITOR_BUILD_TIMEOUT_S = 600;
export const MAX_EDITOR_BUILD_TIMEOUT_S = 3600;

export type BrowserEditorBuildOptions = {
  /*
  Force a fresh build.  Defaults to TRUE, which is not the editors' own
  default, on purpose: build() returns without doing anything when another
  build is already running, and the Rmd/qmd path is debounced with
  leading:true/trailing:false, so an unforced call can silently be a no-op and
  we would then report stale store state as the result of "this" build.
  */
  force?: boolean;
  // wait for the build to finish (default true).  With wait=false the call
  // returns as soon as the build has been kicked off.
  wait?: boolean;
  // seconds to wait for the build; only relevant when wait is true.
  timeout?: number;
};

export function normalizeEditorBuildTimeoutMs(timeout: unknown): number {
  const seconds = asFinitePositive(timeout);
  if (seconds == null) {
    return DEFAULT_EDITOR_BUILD_TIMEOUT_S * 1000;
  }
  return Math.min(seconds, MAX_EDITOR_BUILD_TIMEOUT_S) * 1000;
}

export type BrowserEditorBuildResult = {
  path: string;
  ext: string;
  // whether a build was actually started
  started: boolean;
  // whether the build was forced (see BrowserEditorBuildOptions.force)
  forced: boolean;
  // whether we waited for the build to finish.
  awaited: boolean;
  timed_out?: boolean;
  exit_code?: number;
  error?: string;
  error_count?: number;
  log?: string;
  jobs?: BrowserEditorBuildJob[];
};

/*
Run `editorActions.build()` for an already-resolved editor and summarize the
result.  The caller is responsible for resolving (and, if necessary, opening)
the editor -- see getEditorActionsForPath.
*/
export async function runEditorBuild({
  editorActions,
  path,
  options,
}: {
  editorActions: any;
  path: string;
  options?: BrowserEditorBuildOptions;
}): Promise<BrowserEditorBuildResult> {
  const ext = documentExtension(path);
  if (typeof editorActions?.build !== "function") {
    throw Error(
      `editor for '${path}' does not support building; only document editors such as LaTeX, R Markdown and Quarto have a build action`,
    );
  }
  if (editorActions.is_read_only_preview?.()) {
    throw Error(
      `editor for '${path}' is a read-only preview and will not build`,
    );
  }
  const force = options?.force ?? true;
  const wait = options?.wait ?? true;
  const base: BrowserEditorBuildResult = {
    path,
    ext,
    started: true,
    forced: force,
    awaited: false,
  };

  const build = Promise.resolve(editorActions.build("", force));
  if (!wait) {
    // do not leave an unhandled rejection behind
    build.catch(() => {});
    return base;
  }

  const timeout_ms = normalizeEditorBuildTimeoutMs(options?.timeout);
  let timer: any;
  let timedOut = false;
  try {
    await Promise.race([
      build,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeout_ms);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
  if (timedOut) {
    build.catch(() => {});
    return { ...base, timed_out: true };
  }
  return {
    ...base,
    awaited: true,
    ...readEditorBuildOutcome(editorActions?.store),
  };
}
