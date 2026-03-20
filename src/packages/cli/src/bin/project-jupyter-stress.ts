#!/usr/bin/env node

import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { Command } from "commander";

import { dko } from "@cocalc/conat/sync/dko";
import { jupyterClient } from "@cocalc/conat/project/jupyter/run-code";
import { syncdb as openSyncDb } from "@cocalc/conat/sync-doc/syncdb";
import { ipynbPath, syncdbPath } from "@cocalc/util/jupyter/names";
import { createJupyterApi } from "../api/jupyter";
import { openCurrentProjectConnection } from "../api/current-project";
import {
  evaluateStressRunInvariants,
  normalizeExecCount,
  resolveJupyterStressCode,
  summarizeOutput,
  type JupyterStressPreset,
} from "../core/jupyter-stress";

type StressHarnessOptions = {
  projectId?: string;
  apiBaseUrl?: string;
  bearer?: string;
  path: string;
  cellId: string;
  preset?: JupyterStressPreset;
  code?: string;
  codeFile?: string;
  runs: number;
  delayMs: number;
  settleMs: number;
  timeoutMs: number;
  limit?: number;
  json?: boolean;
  report?: string;
  failFast?: boolean;
};

type StressRunReport = {
  run_index: number;
  requested_at_ms: number;
  completed_at_ms: number | null;
  prev_exec_count: number | null;
  next_exec_count: number | null;
  runtime_state: string | null;
  output_present: boolean;
  output_stable_after_settle: boolean;
  output_entries: number;
  output_bytes: number;
  lifecycle_counts: Record<string, number>;
  message_count: number;
  error_count: number;
  more_output_count: number;
  errors: string[];
};

type StressReport = {
  project_id: string;
  path: string;
  cell_id: string;
  runs_requested: number;
  runs_completed: number;
  ok: boolean;
  code: string;
  failures: Array<{ run_index: number; errors: string[] }>;
  runs: StressRunReport[];
};

type PlainCellRecord = {
  type?: string;
  id?: string;
  input?: string;
  output?: unknown;
  exec_count?: unknown;
};

type RuntimeCellRecord = {
  state?: string | null;
  start?: number | null;
  end?: number | null;
};

const JUPYTER_RUNTIME_STATE_VERSION = 1;
const JUPYTER_SYNCDB_OPTIONS = {
  change_throttle: 25,
  patch_interval: 25,
  primary_keys: ["type", "id"],
  string_cols: ["input"],
  cursors: true,
  persistent: true,
  noSaveToDisk: true,
};

function normalizeNotebookPath(path: string): string {
  const trimmed = `${path ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("--path is required");
  }
  if (isAbsolute(trimmed)) {
    return resolvePath(trimmed);
  }
  return resolvePath(process.env.HOME?.trim() || process.cwd(), trimmed);
}

function jupyterRuntimeStateName(path: string): string {
  return `jupyter-runtime-v${JUPYTER_RUNTIME_STATE_VERSION}:${ipynbPath(path)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPlainValue(value: any): any {
  if (value?.toJS instanceof Function) {
    return value.toJS();
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function readCellRecord(
  syncdb: any,
  cellId: string,
): PlainCellRecord | undefined {
  return toPlainValue(syncdb.get_one({ type: "cell", id: cellId })) as
    | PlainCellRecord
    | undefined;
}

function readRuntimeCellRecord(
  runtimeState: any,
  cellId: string,
): RuntimeCellRecord | undefined {
  const key = `cell:${cellId}`;
  return toPlainValue(runtimeState.get(key)) as RuntimeCellRecord | undefined;
}

async function waitUntil<T>({
  desc,
  timeoutMs,
  intervalMs = 50,
  fn,
}: {
  desc: string;
  timeoutMs: number;
  intervalMs?: number;
  fn: () => T | Promise<T>;
}): Promise<T> {
  const started = Date.now();
  for (;;) {
    const result = await fn();
    if (result) {
      return result;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`timed out waiting for ${desc}`);
    }
    await sleep(intervalMs);
  }
}

async function resolveRequestedCode(
  opts: StressHarnessOptions,
): Promise<string> {
  if (opts.codeFile?.trim()) {
    return (await readFile(opts.codeFile.trim(), "utf8")).trimEnd();
  }
  return resolveJupyterStressCode({
    preset: opts.preset,
    code: opts.code,
  });
}

function summarizeRunFailure(
  run: StressRunReport,
): { run_index: number; errors: string[] } | null {
  if (run.errors.length === 0) {
    return null;
  }
  return {
    run_index: run.run_index,
    errors: [...run.errors],
  };
}

async function collectRunStream({
  project_id,
  path,
  client,
  cellId,
  code,
  limit,
  runIndex,
  timeoutMs,
}: {
  project_id: string;
  path: string;
  client: any;
  cellId: string;
  code: string;
  limit?: number;
  runIndex: number;
  timeoutMs: number;
}): Promise<{
  lifecycleCounts: Record<string, number>;
  messageCount: number;
  errorCount: number;
  moreOutputCount: number;
  streamError: string | null;
}> {
  const runClient = jupyterClient({
    path,
    project_id,
    client,
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const iter = await runClient.run([{ id: cellId, input: code }], {
      waitForAck: false,
      run_id: `stress-${Date.now().toString(36)}-${runIndex}`,
      limit,
    });
    let messageCount = 0;
    let errorCount = 0;
    let moreOutputCount = 0;
    const lifecycleCounts: Record<string, number> = {};
    let streamError: string | null = null;
    try {
      await Promise.race([
        (async () => {
          for await (const batch of iter) {
            for (const mesg of batch) {
              messageCount += 1;
              if (mesg.msg_type === "error") {
                errorCount += 1;
              }
              if (mesg.more_output) {
                moreOutputCount += 1;
              }
              const lifecycle =
                typeof mesg.lifecycle === "string"
                  ? mesg.lifecycle
                  : typeof mesg.msg_type === "string"
                    ? mesg.msg_type
                    : null;
              if (lifecycle != null) {
                lifecycleCounts[lifecycle] =
                  (lifecycleCounts[lifecycle] ?? 0) + 1;
              }
            }
          }
        })(),
        new Promise<void>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("timed out waiting for run stream to end"));
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      streamError = `${err}`;
    }
    return {
      lifecycleCounts,
      messageCount,
      errorCount,
      moreOutputCount,
      streamError,
    };
  } finally {
    if (timeout != null) {
      clearTimeout(timeout);
    }
    runClient.close();
  }
}

async function main() {
  const program = new Command();
  program
    .name("project-jupyter-stress")
    .description(
      "repo-local backend-only stress harness for project jupyter execution",
    )
    .requiredOption("--path <path>", "notebook path inside the current project")
    .requiredOption("--cell-id <id>", "stable code cell id to execute")
    .option("--project-id <uuid>", "override current project id")
    .option("--api-base-url <url>", "override current CoCalc API base url")
    .option("--bearer <token>", "override bearer token")
    .option("--preset <preset>", "code preset: smoke|stress", "stress")
    .option("--code <python>", "explicit code to write into the target cell")
    .option("--code-file <path>", "read code from a file instead of --code")
    .option("--runs <n>", "number of repeated runs", "25")
    .option("--delay-ms <n>", "delay between runs", "0")
    .option("--settle-ms <n>", "delay before final post-run reread", "500")
    .option(
      "--timeout-ms <n>",
      "timeout for authoritative completion per run",
      "30000",
    )
    .option("--limit <n>", "visible output limit passed to backend")
    .option("--json", "emit a JSON report")
    .option("--report <path>", "write the JSON report to a file")
    .option("--fail-fast", "stop at the first failed run");
  program.parse();

  const opts0 = program.opts<{
    path: string;
    cellId: string;
    projectId?: string;
    apiBaseUrl?: string;
    bearer?: string;
    preset?: string;
    code?: string;
    codeFile?: string;
    runs: string;
    delayMs: string;
    settleMs: string;
    timeoutMs: string;
    limit?: string;
    json?: boolean;
    report?: string;
    failFast?: boolean;
  }>();

  if (
    opts0.preset != null &&
    opts0.preset !== "smoke" &&
    opts0.preset !== "stress"
  ) {
    throw new Error("--preset must be smoke or stress");
  }

  const opts: StressHarnessOptions = {
    projectId: opts0.projectId,
    apiBaseUrl: opts0.apiBaseUrl,
    bearer: opts0.bearer,
    path: opts0.path,
    cellId: opts0.cellId,
    preset: opts0.preset as JupyterStressPreset | undefined,
    code: opts0.code,
    codeFile: opts0.codeFile,
    runs: parsePositiveInteger(opts0.runs, "--runs"),
    delayMs: parsePositiveInteger(opts0.delayMs, "--delay-ms"),
    settleMs: parsePositiveInteger(opts0.settleMs, "--settle-ms"),
    timeoutMs: parsePositiveInteger(opts0.timeoutMs, "--timeout-ms"),
    limit:
      opts0.limit == null
        ? undefined
        : parsePositiveInteger(opts0.limit, "--limit"),
    json: opts0.json,
    report: opts0.report,
    failFast: opts0.failFast,
  };

  const normalizedPath = normalizeNotebookPath(opts.path);
  const requestedCode = await resolveRequestedCode(opts);
  const connection = await openCurrentProjectConnection({
    apiBaseUrl: opts.apiBaseUrl,
    bearer: opts.bearer,
    projectId: opts.projectId,
    timeoutMs: opts.timeoutMs,
  });
  const api = createJupyterApi<undefined, typeof connection.project>({
    async resolveProjectConatClient() {
      return { project: connection.project, client: connection.client };
    },
  });
  const binding = api.bindDocument(undefined, { path: normalizedPath });
  const syncdb = openSyncDb({
    ...JUPYTER_SYNCDB_OPTIONS,
    project_id: connection.project.project_id,
    path: syncdbPath(normalizedPath),
    client: connection.client,
  });
  const runtimeState = await dko({
    name: jupyterRuntimeStateName(normalizedPath),
    project_id: connection.project.project_id,
    client: connection.client,
    ephemeral: true,
    noInventory: true,
  });

  try {
    if (syncdb.get_state?.() === "init") {
      await once(syncdb, "ready");
    }
    const cells = await binding.listCells();
    const targetCell = cells.cells.find((cell) => cell.id === opts.cellId);
    if (!targetCell) {
      throw new Error(`unknown cell id '${opts.cellId}'`);
    }
    if (targetCell.cell_type !== "code") {
      throw new Error(`cell '${opts.cellId}' is not a code cell`);
    }

    const report: StressReport = {
      project_id: connection.project.project_id,
      path: normalizedPath,
      cell_id: opts.cellId,
      runs_requested: opts.runs,
      runs_completed: 0,
      ok: true,
      code: requestedCode,
      failures: [],
      runs: [],
    };

    for (let i = 0; i < opts.runs; i += 1) {
      const startedAt = Date.now();
      const beforeCell = readCellRecord(syncdb, opts.cellId);
      const prevExecCount = normalizeExecCount(beforeCell?.exec_count);
      const {
        lifecycleCounts,
        messageCount,
        errorCount,
        moreOutputCount,
        streamError,
      } = await collectRunStream({
        project_id: connection.project.project_id,
        path: normalizedPath,
        client: connection.client,
        cellId: opts.cellId,
        code: requestedCode,
        limit: opts.limit,
        runIndex: i + 1,
        timeoutMs: opts.timeoutMs,
      });

      let completionError: string | null = null;
      try {
        await waitUntil({
          desc: `runtime state done for run ${i + 1}`,
          timeoutMs: opts.timeoutMs,
          fn: async () => {
            const runtimeCell = readRuntimeCellRecord(
              runtimeState,
              opts.cellId,
            );
            return runtimeCell?.state === "done" ? runtimeCell : false;
          },
        });
      } catch (err) {
        completionError = `${err}`;
      }

      const afterCell = readCellRecord(syncdb, opts.cellId);
      const afterRuntime = readRuntimeCellRecord(runtimeState, opts.cellId);
      const afterOutput = summarizeOutput(afterCell?.output);
      await sleep(opts.settleMs);
      const settleCell = readCellRecord(syncdb, opts.cellId);
      const settleOutput = summarizeOutput(settleCell?.output);
      const settleRuntime = readRuntimeCellRecord(runtimeState, opts.cellId);
      const nextExecCount = normalizeExecCount(settleCell?.exec_count);
      const runtimeStateValue =
        settleRuntime?.state ?? afterRuntime?.state ?? null;
      const errors = evaluateStressRunInvariants({
        prev_exec_count: prevExecCount,
        next_exec_count: nextExecCount,
        runtime_state: runtimeStateValue,
        output_after: afterOutput,
        output_after_settle: settleOutput,
      });
      if (streamError != null) {
        errors.unshift(streamError);
      }
      if (completionError != null) {
        errors.unshift(completionError);
      }
      const runReport: StressRunReport = {
        run_index: i + 1,
        requested_at_ms: startedAt,
        completed_at_ms: Date.now(),
        prev_exec_count: prevExecCount,
        next_exec_count: nextExecCount,
        runtime_state: runtimeStateValue,
        output_present: settleOutput.present,
        output_stable_after_settle:
          afterOutput.signature != null &&
          afterOutput.signature === settleOutput.signature,
        output_entries: settleOutput.entries,
        output_bytes: settleOutput.bytes,
        lifecycle_counts: lifecycleCounts,
        message_count: messageCount,
        error_count: errorCount,
        more_output_count: moreOutputCount,
        errors,
      };
      report.runs.push(runReport);
      report.runs_completed += 1;
      const failure = summarizeRunFailure(runReport);
      if (failure != null) {
        report.ok = false;
        report.failures.push(failure);
      }

      if (!opts.json) {
        const status = runReport.errors.length === 0 ? "ok" : "FAIL";
        const promptText =
          runReport.next_exec_count == null
            ? "null"
            : `${runReport.next_exec_count}`;
        process.stderr.write(
          `[jupyter-stress] run ${runReport.run_index}/${opts.runs}: ${status} prompt=${promptText} state=${runReport.runtime_state ?? "null"} output_entries=${runReport.output_entries}\n`,
        );
        if (runReport.errors.length > 0) {
          for (const error of runReport.errors) {
            process.stderr.write(`  - ${error}\n`);
          }
        }
      }

      if (report.failures.length > 0 && opts.failFast) {
        break;
      }
      if (opts.delayMs > 0 && i + 1 < opts.runs) {
        await sleep(opts.delayMs);
      }
    }

    const json = JSON.stringify(report, null, 2);
    if (opts.report?.trim()) {
      await writeFile(opts.report.trim(), `${json}\n`, "utf8");
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    if (opts.json) {
      process.stdout.write(`${json}\n`);
    } else if (report.ok) {
      process.stdout.write(
        `ok: ${report.runs_completed}/${report.runs_requested} runs passed for ${report.cell_id}\n`,
      );
    } else {
      process.stdout.write(
        `failed: ${report.failures.length}/${report.runs_completed} runs failed for ${report.cell_id}\n`,
      );
    }
  } finally {
    try {
      await runtimeState.close();
    } catch {
      // ignore cleanup failures
    }
    try {
      await syncdb.close();
    } catch {
      // ignore cleanup failures
    }
    try {
      const internal = api as typeof api & { close?: () => Promise<void> };
      await internal.close?.();
    } catch {
      // ignore cleanup failures
    }
    connection.client.close();
  }
}

void main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
