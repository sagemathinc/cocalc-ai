/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  BuildDiagnostic,
  BuildStageResult,
  DocumentBuildSnapshot,
} from "@cocalc/app-document-build";
import type { AsyncStatus } from "@cocalc/util/types/execute-code";

import type {
  Error as LatexError,
  IProcessedLatexLog,
} from "./latex-log-parser";
import type { BuildLog, BuildSpecName } from "./types";

export const TERMINAL_DOCUMENT_BUILD_STATES = new Set([
  "succeeded",
  "failed",
  "canceled",
  "timed_out",
]);

export function isDocumentBuildTerminal(snapshot: DocumentBuildSnapshot) {
  return TERMINAL_DOCUMENT_BUILD_STATES.has(snapshot.state);
}

function stageStatus(stage: BuildStageResult): AsyncStatus {
  switch (stage.state) {
    case "succeeded":
      return "completed";
    case "canceled":
      return "killed";
    case "failed":
    case "timed_out":
      return "error";
    default:
      return "running";
  }
}

function buildSpecName(stage: BuildStageResult): BuildSpecName | undefined {
  switch (stage.name) {
    case "latex":
    case "knitr":
    case "sagetex":
    case "pythontex":
      return stage.name;
    default:
      return;
  }
}

function emptyParsedLog(dependencies: string[] = []): IProcessedLatexLog {
  return {
    errors: [],
    warnings: [],
    typesetting: [],
    all: [],
    files: [],
    deps: dependencies,
  };
}

function diagnosticToLatexError(
  diagnostic: BuildDiagnostic,
  fallbackFile: string,
): LatexError {
  return {
    line: diagnostic.line ?? null,
    file: diagnostic.file ?? fallbackFile,
    level: diagnostic.level,
    message: diagnostic.message,
    content: diagnostic.content ?? "",
    raw: diagnostic.raw ?? diagnostic.message,
  };
}

export function parsedLogFromDiagnostics(
  diagnostics: BuildDiagnostic[],
  fallbackFile: string,
  dependencies: string[] = [],
): IProcessedLatexLog {
  const parsed = emptyParsedLog(dependencies);
  for (const diagnostic of diagnostics) {
    const error = diagnosticToLatexError(diagnostic, fallbackFile);
    const group =
      diagnostic.level === "error"
        ? parsed.errors
        : diagnostic.level === "warning"
          ? parsed.warnings
          : parsed.typesetting;
    group.push(error);
    parsed.all.push(error);
  }
  return parsed;
}

function stageBuildLog(
  snapshot: DocumentBuildSnapshot,
  stage: BuildStageResult,
): BuildLog {
  const diagnostics = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.stage_id === stage.stage_id,
  );
  return {
    type: "async",
    job_id: stage.job_id ?? stage.stage_id,
    start: stage.started_at ?? snapshot.started_at ?? snapshot.submitted_at,
    status: stageStatus(stage),
    stdout: stage.stdout,
    stderr: stage.stderr,
    exit_code: stage.exit_code ?? 0,
    elapsed_s:
      stage.started_at != null && stage.ended_at != null
        ? Math.max(0, (stage.ended_at - stage.started_at) / 1000)
        : undefined,
    stats: stage.stats as any,
    time: Math.max(
      0,
      (stage.ended_at ?? Date.now()) -
        (stage.started_at ?? snapshot.started_at ?? snapshot.submitted_at),
    ),
    parse: parsedLogFromDiagnostics(
      diagnostics,
      snapshot.identity.logical_path,
    ),
  };
}

export function snapshotBuildLogs(
  snapshot: DocumentBuildSnapshot,
): Partial<Record<BuildSpecName, BuildLog>> {
  const logs: Partial<Record<BuildSpecName, BuildLog>> = {};
  for (const stage of snapshot.stages) {
    const name = buildSpecName(stage);
    if (name != null) logs[name] = stageBuildLog(snapshot, stage);
  }
  return logs;
}

/**
 * Whether a diagnostic actually shows up in the output panel.
 *
 * snapshotBuildLogs() keeps only stages that map to a build spec, and
 * stageBuildLog() then keeps only the diagnostics belonging to that stage --
 * and `build_logs` is what both the problems tab and the errors/warnings panel
 * render.  So a diagnostic with no stage, such as a transport failure raised
 * before any stage ran, is displayed nowhere and must not be suppressed.
 */
export function isDiagnosticRendered(
  snapshot: DocumentBuildSnapshot,
  diagnostic: BuildDiagnostic,
): boolean {
  if (diagnostic.stage_id == null) return false;
  return snapshot.stages.some(
    (stage) =>
      stage.stage_id === diagnostic.stage_id && buildSpecName(stage) != null,
  );
}

export function snapshotParsedLog(
  snapshot: DocumentBuildSnapshot,
): IProcessedLatexLog {
  return parsedLogFromDiagnostics(
    snapshot.diagnostics,
    snapshot.identity.logical_path,
    snapshot.dependencies,
  );
}
