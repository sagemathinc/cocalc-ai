/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Read whatever an editor recorded about its last build.

Shared by the browser exec API and by the reply a frame editor sends when a
backend caller requested the build, so both report the same thing.
*/

import { asOptionalFiniteNumber } from "@cocalc/frontend/conat/browser-session/common-utils";

export const MAX_EDITOR_BUILD_LOG_CHARS = 20_000;
// a successful build keeps far less of its log -- see truncateBuildLogTail
export const MAX_SUCCESSFUL_BUILD_LOG_CHARS = 2_000;

export type BrowserEditorBuildJob = {
  name: string;
  exit_code?: number;
};

export type EditorBuildOutcome = {
  exit_code?: number;
  error?: string;
  error_count?: number;
  log?: string;
  jobs?: BrowserEditorBuildJob[];
};

function readField(source: any, key: string): unknown {
  if (source == null) return undefined;
  if (typeof source.get === "function") {
    return source.get(key);
  }
  return source[key];
}

function readPath(source: any, keys: string[]): unknown {
  let current: any = source;
  for (const key of keys) {
    current = readField(current, key);
    if (current == null) return undefined;
  }
  return current;
}

function entriesOf(value: any): [string, any][] {
  if (value == null) return [];
  if (typeof value.entrySeq === "function") {
    return value.entrySeq().toArray() as [string, any][];
  }
  if (typeof value.entries === "function") {
    return [...value.entries()] as [string, any][];
  }
  if (typeof value === "object") {
    return Object.entries(value);
  }
  return [];
}

function countOf(value: any): number | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.length;
  if (typeof value.size === "number") return value.size;
  if (typeof value.length === "number") return value.length;
  return undefined;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function truncateBuildLog(
  text: string,
  max = MAX_EDITOR_BUILD_LOG_CHARS,
): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} chars]`;
}

/*
A build that exited 0 is already verified by its exit code, so its log is
context rather than evidence, and latexmk's is mostly font paths and a
dependency listing -- thousands of characters that cost an agent context and
tell it nothing.  Keep the end, where what the run produced is reported
("Output written on ... (1 page)"), rather than the beginning.
*/
export function truncateBuildLogTail(
  text: string,
  max = MAX_SUCCESSFUL_BUILD_LOG_CHARS,
): string {
  if (text.length <= max) return text;
  return `[... truncated ${text.length - max} earlier chars]\n${text.slice(
    text.length - max,
  )}`;
}

function summarizeLog(text: string, exit_code: number | undefined): string {
  return exit_code === 0 ? truncateBuildLogTail(text) : truncateBuildLog(text);
}

/*
Read whatever the editor recorded about the last build.

LaTeX keeps one entry per build stage in `build_logs` (latex, knitr, bibtex,
sagetex, pythontex); R Markdown and Quarto keep a single `build_exit` /
`build_log` / `build_err` triple.  Both shapes are Immutable at runtime, so all
reads go through readField/readPath.
*/
export function readEditorBuildOutcome(store: any): EditorBuildOutcome {
  if (store == null) return {};
  const out: EditorBuildOutcome = {};

  const error = asTrimmedString(readField(store, "error"));
  if (error) {
    out.error = truncateBuildLog(error);
  }

  const buildLogs = readField(store, "build_logs");
  const logEntries = entriesOf(buildLogs);
  if (logEntries.length > 0) {
    const jobs: BrowserEditorBuildJob[] = [];
    let failing: { stdout: string; stderr: string } | undefined;
    let sawExitCode = false;
    for (const [name, log] of logEntries) {
      const exit_code = asOptionalFiniteNumber(readField(log, "exit_code"));
      jobs.push({ name, ...(exit_code != null ? { exit_code } : {}) });
      if (exit_code == null) continue;
      sawExitCode = true;
      if (exit_code !== 0 && failing == null) {
        out.exit_code = exit_code;
        failing = {
          stdout: asTrimmedString(readField(log, "stdout")),
          stderr: asTrimmedString(readField(log, "stderr")),
        };
      }
    }
    out.jobs = jobs;
    if (out.exit_code == null && sawExitCode) {
      out.exit_code = 0;
    }
    const errorCount = countOf(
      readPath(buildLogs, ["latex", "parse", "errors"]),
    );
    if (errorCount != null) {
      out.error_count = errorCount;
    }
    const log =
      failing != null
        ? [failing.stderr, failing.stdout].filter((x) => x).join("\n")
        : asTrimmedString(readPath(buildLogs, ["latex", "stdout"]));
    if (log) {
      out.log = summarizeLog(log, out.exit_code);
    }
    return out;
  }

  const exit_code = asOptionalFiniteNumber(readField(store, "build_exit"));
  if (exit_code != null) {
    out.exit_code = exit_code;
  }
  const stderr = asTrimmedString(readField(store, "build_err"));
  const stdout = asTrimmedString(readField(store, "build_log"));
  const log =
    exit_code != null && exit_code !== 0
      ? [stderr, stdout].filter((x) => x).join("\n")
      : stdout || stderr;
  if (log) {
    out.log = summarizeLog(log, exit_code);
  }
  if (!out.error && exit_code != null && exit_code !== 0 && stderr) {
    out.error = truncateBuildLog(stderr);
  }
  return out;
}
