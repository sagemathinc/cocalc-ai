/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { sha1 } from "@cocalc/util/misc";

import type {
  BuildDiagnostic,
  BuildDocumentIdentity,
  BuildStageResult,
  DocumentBuildCallbacks,
  DocumentBuildRequest,
  DocumentBuildRuntime,
  DocumentBuildSnapshot,
} from "../contracts";
import {
  createInitialSnapshot,
  executeStage,
  failSnapshot,
  finishSnapshot,
  remainingTimeoutSeconds,
  terminalStateForStage,
} from "../pipeline";
import { joinPath, path_split, pdfPath } from "../path";
import {
  commandSpec,
  type LatexBuildCommand,
  withoutLatexOutputDirectory,
} from "./commands";
import { DocumentBuildConfigError, resolveLatexBuildConfig } from "./config";
import { knitrStage, parseKnitrDiagnostics, patchSynctexStage } from "./knitr";
import { parseLatexLog } from "./log-parser";
import { parsePythontexDiagnostics, pythontexStage } from "./pythontex";
import { parseSagetexDiagnostics, sagetexFile, sagetexStage } from "./sagetex";

const LATEX_TIMEOUT_S = 15 * 60;

function addDiagnostics(
  snapshot: DocumentBuildSnapshot,
  diagnostics: BuildDiagnostic[],
  stageId: string,
): void {
  snapshot.diagnostics.push(
    ...diagnostics.map((diagnostic) => ({
      ...diagnostic,
      stage_id: diagnostic.stage_id ?? stageId,
    })),
  );
}

function replaceLatexDiagnostics(
  snapshot: DocumentBuildSnapshot,
  stage: BuildStageResult,
): void {
  snapshot.diagnostics = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.source !== "latex",
  );
  const parsed = parseLatexLog(stage.stdout);
  snapshot.dependencies = parsed.deps.slice();
  addDiagnostics(
    snapshot,
    parsed.all.map((entry) => ({
      level: entry.level,
      source: "latex" as const,
      message: entry.message,
      file: entry.file || undefined,
      line: entry.line ?? undefined,
      content: entry.content,
      raw: entry.raw,
    })),
    stage.stage_id,
  );
}

function latexStage(options: {
  stageId: string;
  identity: BuildDocumentIdentity;
  command: LatexBuildCommand;
  timeoutS: number;
  force: boolean;
  generation?: string;
}): import("../contracts").BuildStageSpec {
  const command = commandSpec(options.command);
  return {
    stage_id: options.stageId,
    name: "latex",
    logical_path: options.identity.logical_path,
    working_path: options.identity.working_path,
    resource_key: options.identity.resource_key,
    command: command.command,
    args: command.args,
    cwd: path_split(options.identity.working_path).head,
    bash: command.bash,
    timeout_s: options.timeoutS,
    required: true,
    job_key: `latex:${options.identity.logical_path}`,
    aggregate_key: options.force ? undefined : options.generation,
  };
}

function shouldStop(stage: BuildStageResult): boolean {
  return stage.state === "canceled" || stage.state === "timed_out";
}

function markEarlierLatexPassesOptional(snapshot: DocumentBuildSnapshot): void {
  const latex = snapshot.stages.filter((stage) => stage.name === "latex");
  for (const stage of latex.slice(0, -1)) stage.required = false;
}

export async function runLatexPipeline(
  identity: BuildDocumentIdentity,
  request: DocumentBuildRequest,
  runtime: DocumentBuildRuntime,
  callbacks?: DocumentBuildCallbacks,
): Promise<DocumentBuildSnapshot> {
  const snapshot = createInitialSnapshot(identity, request, runtime, callbacks);
  const knitr = identity.kind === "knitr";
  let stageNumber = 0;
  const nextStageId = (name: string): string => `${name}-${++stageNumber}`;

  let source: string;
  let command: LatexBuildCommand;
  let outputDirectory: string | undefined;
  try {
    source = await runtime.readText(identity.logical_path);
    if (/\s\s+/.test(identity.logical_path)) {
      throw new DocumentBuildConfigError(
        `It is not possible to compile '${identity.logical_path}' because its name contains consecutive spaces.`,
      );
    }
    outputDirectory = knitr
      ? undefined
      : request.output_directory === null
        ? undefined
        : (request.output_directory ?? `/tmp/${sha1(identity.working_path)}`);
    const resolved = resolveLatexBuildConfig({
      source,
      workingPath: identity.working_path,
      knitr,
      saved: await runtime.readBuildConfig(identity.logical_path),
      outputDirectory,
    });
    command = resolved.build_command;
  } catch (error) {
    return failSnapshot(
      snapshot,
      runtime,
      {
        level: "error",
        source:
          error instanceof DocumentBuildConfigError
            ? "configuration"
            : "transport",
        file: identity.logical_path,
        message: error instanceof Error ? error.message : `${error}`,
      },
      callbacks,
    );
  }

  if (knitr) {
    const stage = await executeStage(
      snapshot,
      runtime,
      knitrStage({
        stageId: nextStageId("knitr"),
        logicalPath: identity.logical_path,
        workingPath: identity.working_path,
        resourceKey: identity.resource_key,
        timeoutS: remainingTimeoutSeconds(snapshot, runtime, LATEX_TIMEOUT_S),
        aggregateKey: request.force ? undefined : request.generation,
      }),
      callbacks,
    );
    addDiagnostics(
      snapshot,
      parseKnitrDiagnostics(stage.stderr),
      stage.stage_id,
    );
    if (
      shouldStop(stage) ||
      terminalStateForStage(stage) != null ||
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.source === "knitr" && diagnostic.level === "error",
      )
    ) {
      return finishSnapshot(snapshot, runtime, callbacks);
    }
    if (await runtime.exists(identity.working_path)) {
      snapshot.artifacts.push({ path: identity.working_path, type: "tex" });
    }
  }

  const runLatex = async (force: boolean): Promise<BuildStageResult> => {
    const stage = await executeStage(
      snapshot,
      runtime,
      latexStage({
        stageId: nextStageId("latex"),
        identity,
        command,
        timeoutS: remainingTimeoutSeconds(snapshot, runtime, LATEX_TIMEOUT_S),
        force,
        generation: request.generation,
      }),
      callbacks,
    );
    replaceLatexDiagnostics(snapshot, stage);
    if (outputDirectory != null) {
      const { head, tail } = path_split(identity.working_path);
      try {
        await runtime.copy(
          joinPath(outputDirectory, path_split(pdfPath(tail)).tail),
          joinPath(head, path_split(pdfPath(tail)).tail),
        );
      } catch {
        // latexmk can legitimately fail before producing a PDF.
      }
    }
    return stage;
  };

  let latex = await runLatex(request.force ?? false);
  if (shouldStop(latex)) return finishSnapshot(snapshot, runtime, callbacks);

  if (knitr) {
    const patch = await executeStage(
      snapshot,
      runtime,
      patchSynctexStage({
        stageId: nextStageId("patch-synctex"),
        logicalPath: identity.logical_path,
        workingPath: identity.working_path,
        resourceKey: identity.resource_key,
        timeoutS: remainingTimeoutSeconds(snapshot, runtime, 10),
        aggregateKey: request.force ? undefined : request.generation,
      }),
      callbacks,
    );
    if (terminalStateForStage(patch) != null) {
      snapshot.diagnostics.push({
        level: "warning",
        source: "knitr",
        file: identity.logical_path,
        message:
          patch.error ?? (patch.stderr.trim() || "Unable to patch SyncTeX"),
        stage_id: patch.stage_id,
      });
    }
  }

  const useSagetex = latex.stdout.includes("sagetex.sty");
  const usePythontex =
    latex.stdout.includes("pythontex.sty") ||
    latex.stdout.includes("PythonTeX");

  if ((useSagetex || usePythontex) && outputDirectory != null) {
    command = withoutLatexOutputDirectory(command, outputDirectory);
    outputDirectory = undefined;
    latex = await runLatex(true);
    if (shouldStop(latex)) return finishSnapshot(snapshot, runtime, callbacks);
  }

  if (useSagetex) {
    const runDirectory =
      outputDirectory ?? path_split(identity.working_path).head;
    const sageFile = joinPath(runDirectory, sagetexFile(identity.working_path));
    // The generated .sagetex.sage file can be missing even though this LaTeX
    // run reported sagetex.sty: a "clean" removes it, and the following
    // non-forced LaTeX pass can then be served from the aggregate cache
    // instead of regenerating it. Re-run LaTeX forced to get the file back
    // rather than failing the whole build. See cocalc#8680.
    let hash = "";
    try {
      if (!(await runtime.exists(sageFile))) {
        latex = await runLatex(true);
        if (shouldStop(latex))
          return finishSnapshot(snapshot, runtime, callbacks);
      }
      // An empty hash leaves aggregate_key unset, so sagetex is never deduped
      // against an earlier run when we could not identify its input.
      if (await runtime.exists(sageFile)) {
        hash = await runtime.hash(sageFile);
      }
    } catch (error) {
      snapshot.diagnostics.push({
        level: "error",
        source: "transport",
        file: sageFile,
        message: error instanceof Error ? error.message : `${error}`,
      });
      return finishSnapshot(snapshot, runtime, callbacks);
    }
    const sage = await executeStage(
      snapshot,
      runtime,
      sagetexStage({
        stageId: nextStageId("sagetex"),
        logicalPath: identity.logical_path,
        workingPath: identity.working_path,
        resourceKey: identity.resource_key,
        runDirectory,
        hash,
        force: request.force ?? false,
        timeoutS: remainingTimeoutSeconds(snapshot, runtime, LATEX_TIMEOUT_S),
      }),
      callbacks,
    );
    addDiagnostics(
      snapshot,
      parseSagetexDiagnostics(
        path_split(identity.working_path).tail,
        sage.stderr,
      ),
      sage.stage_id,
    );
    if (sage.stderr.includes("sagetex.VersionError")) {
      snapshot.diagnostics.push({
        level: "error",
        source: "sagetex",
        file: identity.working_path,
        message:
          "SageTeX only works with the default version of Sage; remove ~/bin/sage and retry.",
        stage_id: sage.stage_id,
      });
    }
    if (terminalStateForStage(sage) != null) {
      return finishSnapshot(snapshot, runtime, callbacks);
    }
    latex = await runLatex(request.force ?? false);
    if (shouldStop(latex)) return finishSnapshot(snapshot, runtime, callbacks);
  }

  if (usePythontex) {
    const python = await executeStage(
      snapshot,
      runtime,
      pythontexStage({
        stageId: nextStageId("pythontex"),
        logicalPath: identity.logical_path,
        workingPath: identity.working_path,
        resourceKey: identity.resource_key,
        runDirectory: outputDirectory,
        force: request.force ?? false,
        timeoutS: remainingTimeoutSeconds(snapshot, runtime, LATEX_TIMEOUT_S),
        aggregateKey: request.generation,
      }),
      callbacks,
    );
    addDiagnostics(
      snapshot,
      parsePythontexDiagnostics(
        path_split(identity.working_path).tail,
        python.stdout,
      ),
      python.stage_id,
    );
    if (terminalStateForStage(python) != null) {
      return finishSnapshot(snapshot, runtime, callbacks);
    }
    latex = await runLatex(request.force ?? false);
    if (shouldStop(latex)) return finishSnapshot(snapshot, runtime, callbacks);
  }

  markEarlierLatexPassesOptional(snapshot);
  const pdf = pdfPath(identity.working_path);
  if (await runtime.exists(pdf))
    snapshot.artifacts.push({ path: pdf, type: "pdf" });
  return finishSnapshot(snapshot, runtime, callbacks);
}
