import { createInterface } from "node:readline/promises";
import { Command } from "commander";

import type { OutputMessage } from "@cocalc/conat/project/jupyter/run-code";
import type { ProjectCommandDeps } from "../project";

function normalizePath(value?: string): string {
  const path = `${value ?? ""}`.trim();
  if (!path) throw new Error("--path is required");
  return path;
}

function collectString(value: string, previous: string[] = []): string[] {
  previous.push(`${value ?? ""}`.trim());
  return previous;
}

function collectPositiveInteger(
  value: string,
  previous: number[] = [],
): number[] {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("cell indexes must be non-negative integers");
  }
  previous.push(parsed);
  return previous;
}

function normalizeRichText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => normalizeRichText(part)).join("");
  }
  if (value == null) {
    return "";
  }
  return `${value}`;
}

function humanTextForOutputMessage(mesg: OutputMessage): {
  stream?: string;
  error?: string;
} | null {
  if (mesg.more_output) {
    return { error: "\n...[more output omitted]\n" };
  }
  switch (mesg.msg_type) {
    case "stream": {
      const text = normalizeRichText((mesg as any)?.content?.text);
      return text ? { stream: text } : null;
    }
    case "error": {
      const traceback = normalizeRichText((mesg as any)?.content?.traceback);
      const ename = normalizeRichText((mesg as any)?.content?.ename);
      const evalue = normalizeRichText((mesg as any)?.content?.evalue);
      const text =
        traceback ||
        [ename, evalue].filter(Boolean).join(": ") ||
        "Jupyter execution error";
      return { error: text.endsWith("\n") ? text : `${text}\n` };
    }
    case "display_data":
    case "execute_result": {
      const text = normalizeRichText(
        (mesg as any)?.content?.data?.["text/plain"] ??
          (mesg as any)?.content?.data?.["text/markdown"],
      );
      if (!text) return null;
      return { stream: text.endsWith("\n") ? text : `${text}\n` };
    }
    default:
      return null;
  }
}

export function registerProjectJupyterCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    projectJupyterCellsData,
    projectJupyterRunSession,
    projectJupyterLiveRunSession,
    durationToMs,
  } = deps;

  const jupyter = project
    .command("jupyter")
    .description("project Jupyter notebook execution");

  jupyter
    .command("cells")
    .description("list cells in a notebook with stable ids and indexes")
    .requiredOption("--path <path>", "notebook path inside the project")
    .option("-w, --project <project>", "project id or name")
    .option("--code-only", "only list code cells")
    .action(
      async (
        opts: { path: string; project?: string; codeOnly?: boolean },
        command: Command,
      ) => {
        await withContext(command, "project jupyter cells", async (ctx) => {
          return await projectJupyterCellsData({
            ctx,
            projectIdentifier: opts.project,
            path: normalizePath(opts.path),
            codeOnly: opts.codeOnly,
          });
        });
      },
    );

  jupyter
    .command("run")
    .description("run selected code cells in a notebook and stream output")
    .requiredOption("--path <path>", "notebook path inside the project")
    .option("-w, --project <project>", "project id or name")
    .option("--cell-id <id>", "cell id to execute", collectString, [])
    .option(
      "--cell-index <n>",
      "0-based cell index from `project jupyter cells`",
      collectPositiveInteger,
      [],
    )
    .option("--all-code", "run all code cells in notebook order")
    .option("--no-halt", "continue after a cell emits an error")
    .option("--allow-errors", "exit zero even if Jupyter emits error output")
    .option("--jsonl", "emit raw Jupyter output messages as JSONL")
    .option("--limit <n>", "visible output limit passed to backend")
    .action(
      async (
        opts: {
          path: string;
          project?: string;
          cellId?: string[];
          cellIndex?: number[];
          allCode?: boolean;
          noHalt?: boolean;
          allowErrors?: boolean;
          jsonl?: boolean;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "project jupyter run", async (ctx) => {
          const startedAt = Date.now();
          const wantsJsonSummary =
            ctx.globals.json || ctx.globals.output === "json";
          const limit =
            opts.limit == null || `${opts.limit}`.trim() === ""
              ? undefined
              : (() => {
                  const parsed = Number(opts.limit);
                  if (!Number.isInteger(parsed) || parsed <= 0) {
                    throw new Error("--limit must be a positive integer");
                  }
                  return parsed;
                })();
          let rl: ReturnType<typeof createInterface> | undefined;
          const session = await projectJupyterRunSession({
            ctx,
            projectIdentifier: opts.project,
            path: normalizePath(opts.path),
            cellIds: opts.cellId,
            cellIndices: opts.cellIndex,
            allCode: opts.allCode,
            noHalt: opts.noHalt,
            limit,
            stdin: async ({ prompt }) => {
              if (!process.stdin.isTTY) {
                throw new Error(
                  "kernel requested stdin, but this CLI process is not interactive",
                );
              }
              rl ??= createInterface({
                input: process.stdin,
                output: process.stderr,
              });
              return await rl.question(prompt);
            },
            onAck: () => {
              if (ackAt == null) {
                ackAt = Date.now();
              }
            },
          });

          let batchCount = 0;
          let messageCount = 0;
          let errorCount = 0;
          let moreOutputCount = 0;
          let ackAt: number | null = null;
          let firstBatchAt: number | null = null;
          let firstMessageAt: number | null = null;
          const lifecycleCounts: Record<string, number> = {};

          try {
            for await (const batch of session.iter) {
              if (firstBatchAt == null) {
                firstBatchAt = Date.now();
              }
              batchCount += 1;
              for (const mesg of batch) {
                if (firstMessageAt == null) {
                  firstMessageAt = Date.now();
                }
                messageCount += 1;
                if (mesg.more_output) {
                  moreOutputCount += 1;
                }
                if (mesg.msg_type === "error") {
                  errorCount += 1;
                }
                if (
                  mesg.lifecycle != null &&
                  typeof mesg.lifecycle === "string"
                ) {
                  lifecycleCounts[mesg.lifecycle] =
                    (lifecycleCounts[mesg.lifecycle] ?? 0) + 1;
                }
                if (opts.jsonl) {
                  process.stdout.write(`${JSON.stringify(mesg)}\n`);
                  continue;
                }
                if (wantsJsonSummary) {
                  continue;
                }
                const human = humanTextForOutputMessage(mesg);
                if (human?.stream) {
                  process.stdout.write(human.stream);
                }
                if (human?.error) {
                  process.stderr.write(human.error);
                }
              }
            }
          } finally {
            rl?.close();
            session.close();
          }

          const summary = {
            project_id: session.project_id,
            project_title: session.project_title,
            path: session.path,
            run_id: session.run_id || null,
            cells: session.cells.map((cell) => ({
              id: cell.id,
              index: cell.index,
              cell_type: cell.cell_type,
              preview: cell.preview,
            })),
            batch_count: batchCount,
            message_count: messageCount,
            error_count: errorCount,
            more_output_count: moreOutputCount,
            lifecycle_counts: lifecycleCounts,
            duration_ms: Date.now() - startedAt,
            to_ack_ms: ackAt == null ? null : Math.max(0, ackAt - startedAt),
            to_first_batch_ms:
              firstBatchAt == null
                ? null
                : Math.max(0, firstBatchAt - startedAt),
            first_batch_before_ack:
              ackAt == null || firstBatchAt == null
                ? null
                : firstBatchAt < ackAt,
            ack_to_first_batch_ms:
              ackAt == null || firstBatchAt == null
                ? null
                : Math.max(0, firstBatchAt - ackAt),
            to_first_message_ms:
              firstMessageAt == null
                ? null
                : Math.max(0, firstMessageAt - startedAt),
            wait_for_ack: false,
            nominal_extra_rtts_before_first_output: 0,
          };
          if (errorCount > 0 && opts.allowErrors !== true) {
            throw new Error(
              `jupyter execution emitted ${errorCount} error message${
                errorCount === 1 ? "" : "s"
              }`,
            );
          }
          if (opts.jsonl) {
            return null;
          }
          if (wantsJsonSummary) {
            return summary;
          }
          return null;
        });
      },
    );

  jupyter
    .command("live")
    .description(
      "attach to the latest live Jupyter run for a notebook and stream current output",
    )
    .requiredOption("--path <path>", "notebook path inside the project")
    .option("-w, --project <project>", "project id or name")
    .option("--run-id <id>", "specific run id to follow")
    .option("--timeout <duration>", "max time to wait/follow (default: 30s)")
    .option("--poll-ms <n>", "poll interval for live run snapshots", "200")
    .option("--no-follow", "replay current snapshot only; do not wait for more")
    .option("--jsonl", "emit raw Jupyter output messages as JSONL")
    .action(
      async (
        opts: {
          path: string;
          project?: string;
          runId?: string;
          timeout?: string;
          pollMs?: string;
          follow?: boolean;
          jsonl?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project jupyter live", async (ctx) => {
          const startedAt = Date.now();
          const wantsJsonSummary =
            ctx.globals.json || ctx.globals.output === "json";
          const waitMs =
            opts.timeout == null || `${opts.timeout}`.trim() === ""
              ? 30_000
              : durationToMs(opts.timeout, 30_000);
          const pollMs =
            opts.pollMs == null || `${opts.pollMs}`.trim() === ""
              ? 200
              : (() => {
                  const parsed = Number(opts.pollMs);
                  if (!Number.isInteger(parsed) || parsed <= 0) {
                    throw new Error("--poll-ms must be a positive integer");
                  }
                  return parsed;
                })();
          const session = await projectJupyterLiveRunSession({
            ctx,
            projectIdentifier: opts.project,
            path: normalizePath(opts.path),
            runId: opts.runId,
            follow: opts.follow !== false,
            waitMs,
            pollMs,
          });
          let batchCount = 0;
          let messageCount = 0;
          let errorCount = 0;
          let moreOutputCount = 0;
          const lifecycleCounts: Record<string, number> = {};

          try {
            for await (const batch of session.iter) {
              batchCount += 1;
              for (const mesg of batch) {
                messageCount += 1;
                if (mesg.more_output) {
                  moreOutputCount += 1;
                }
                if (mesg.msg_type === "error") {
                  errorCount += 1;
                }
                if (
                  mesg.lifecycle != null &&
                  typeof mesg.lifecycle === "string"
                ) {
                  lifecycleCounts[mesg.lifecycle] =
                    (lifecycleCounts[mesg.lifecycle] ?? 0) + 1;
                }
                if (opts.jsonl) {
                  process.stdout.write(`${JSON.stringify(mesg)}\n`);
                  continue;
                }
                if (wantsJsonSummary) {
                  continue;
                }
                const human = humanTextForOutputMessage(mesg);
                if (human?.stream) {
                  process.stdout.write(human.stream);
                }
                if (human?.error) {
                  process.stderr.write(human.error);
                }
              }
            }
          } finally {
            session.close();
          }

          const summary = {
            project_id: session.project_id,
            project_title: session.project_title,
            path: session.path,
            run_id: session.getRunId(),
            batch_count: batchCount,
            message_count: messageCount,
            error_count: errorCount,
            more_output_count: moreOutputCount,
            lifecycle_counts: lifecycleCounts,
            duration_ms: Date.now() - startedAt,
            follow: opts.follow !== false,
            wait_ms: waitMs,
            poll_ms: pollMs,
          };
          if (opts.jsonl) {
            return null;
          }
          if (wantsJsonSummary) {
            return summary;
          }
          return null;
        });
      },
    );
}
