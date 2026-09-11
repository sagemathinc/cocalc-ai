import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ProjectCommandDeps } from "../project";

function parsePositiveIntegerOrThrow(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function normalizePath(value?: string): string {
  const path = `${value ?? ""}`.trim();
  if (!path) throw new Error("--path is required");
  return path;
}

function normalizeThreadId(value?: string): string {
  const threadId = `${value ?? ""}`.trim();
  if (!threadId) throw new Error("--thread-id is required");
  return threadId;
}

export function registerProjectChatCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    buildCodexSessionConfig,
    projectChatThreadCreateData,
    projectChatThreadStatusData,
    projectChatAutomationData,
    projectChatActivityData,
  } = deps;

  const chat = project.command("chat").description("project chat operations");

  const artifact = chat
    .command("artifact")
    .description(
      "experimental Markdown, file-reference, proposed-action, GitHub PR, and commit artifacts with shared appearance",
    );
  artifact
    .command("publish")
    .description(
      "publish a reviewable result using current turn context; returns verified card and retry identity",
    )
    .option("-w, --project <project>", "target project")
    .option("--path <path>", "chat path (defaults to COCALC_CODEX_CHAT_PATH)")
    .option(
      "--thread-id <id>",
      "originating thread (defaults to COCALC_CODEX_THREAD_ID)",
    )
    .option(
      "--message-date <date>",
      "exact producing timestamp (defaults to COCALC_CODEX_MESSAGE_DATE)",
    )
    .option(
      "--source <path>",
      "absolute project file path to preview, including plans and images",
    )
    .option(
      "--commit <revision>",
      "pin a commit resolved from the local repository",
    )
    .option(
      "--repo <path>",
      "local repository/worktree for --commit",
      process.cwd(),
    )
    .option(
      "--file <path>",
      "publication JSON: title, markdown, optional file/actions/github_pr/commit/theme; - for stdin",
    )
    .option(
      "--title <title>",
      "card title (defaults to filename or commit subject for shortcuts)",
    )
    .option(
      "--update <id>",
      "update this artifact; requires --base from a prior read",
    )
    .option(
      "--base <base>",
      "reviewed update base; never automatically rebased",
    )
    .option(
      "--experimental",
      "explicitly enable publication outside a workbench-enabled turn",
    )
    .action(async (opts, command: Command) => {
      await withContext(
        command,
        "project chat artifact publish",
        async (ctx) => {
          if (!opts.experimental && process.env.COCALC_WORKBENCH !== "1")
            throw Error(
              "Publication requires a workbench-enabled turn or --experimental",
            );
          if (
            [opts.source, opts.commit, opts.file].filter(Boolean).length !== 1
          )
            throw Error("Choose exactly one of --source, --commit, --file");
          let payload: any;
          if (opts.source) {
            if (!opts.source.startsWith("/"))
              throw Error("--source must be an absolute project file path");
            payload = {
              title: basename(opts.source),
              file: { path: opts.source },
            };
          } else if (opts.commit) {
            const git = async (...args: string[]) =>
              (
                await promisify(execFile)("git", args, {
                  cwd: resolve(opts.repo),
                  maxBuffer: 1024 * 1024,
                })
              ).stdout.trim();
            const sha = await git(
              "rev-parse",
              "--verify",
              "--end-of-options",
              `${opts.commit}^{commit}`,
            );
            payload = {
              title: await git("show", "-s", "--format=%s", sha),
              commit: {
                sha,
                path: await git("rev-parse", "--show-toplevel"),
                common_directory: await git(
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-common-dir",
                ),
              },
            };
          } else {
            let source = "";
            if (opts.file === "-") {
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const chunk of process.stdin) {
                const b = Buffer.from(chunk);
                size += b.length;
                if (size > 128 * 1024)
                  throw Error("artifact payload exceeds 128 KiB");
                chunks.push(b);
              }
              source = Buffer.concat(chunks).toString("utf8");
            } else source = await readFile(opts.file, "utf8");
            if (Buffer.byteLength(source) > 128 * 1024)
              throw Error("artifact payload exceeds 128 KiB");
            payload = JSON.parse(source);
          }
          if (opts.title) payload.title = opts.title;
          if (opts.base !== undefined) payload.base = opts.base;
          return deps.projectChatArtifactData({
            ctx,
            action: "publish",
            experimental: true,
            projectIdentifier: opts.project,
            path: normalizePath(
              opts.path ?? process.env.COCALC_CODEX_CHAT_PATH,
            ),
            threadId: normalizeThreadId(
              opts.threadId ?? process.env.COCALC_CODEX_THREAD_ID,
            ),
            messageDate:
              opts.messageDate ?? process.env.COCALC_CODEX_MESSAGE_DATE,
            artifactId: opts.update,
            payload,
          });
        },
      );
    });
  for (const action of [
    "create",
    "update",
    "read",
    "list",
    "context",
  ] as const) {
    artifact
      .command(action)
      .requiredOption("--path <path>", "chat document path")
      .requiredOption("--thread-id <id>", "originating thread")
      .option("-w, --project <project>", "project id or name")
      .option("--artifact-id <id>", "stable artifact id (required except list)")
      .option("--operation-id <id>", "read an exact published snapshot")
      .option(
        "--message-date <date>",
        "exact producing message timestamp for context",
      )
      .option(
        "--file <path>",
        "JSON publication payload (Markdown, or one of file, actions, github_pr, commit; optional theme); - for stdin. See exec-api for payload types",
      )
      .option("--experimental", "opt into prototype artifact writes")
      .action(async (opts, command: Command) => {
        await withContext(
          command,
          `project chat artifact ${action}`,
          async (ctx) => {
            if (action !== "list" && action !== "context" && !opts.artifactId)
              throw Error("--artifact-id is required");
            let payload;
            if (action === "create" || action === "update") {
              if (!opts.file)
                throw Error(
                  "--file <path> (or --file - for stdin) is required",
                );
              let source: string;
              if (opts.file === "-") {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of process.stdin) {
                  const buffer = Buffer.from(chunk);
                  size += buffer.length;
                  if (size > 128 * 1024)
                    throw Error("artifact payload exceeds 128 KiB");
                  chunks.push(buffer);
                }
                source = Buffer.concat(chunks).toString("utf8");
              } else {
                source = await readFile(opts.file, "utf8");
              }
              if (Buffer.byteLength(source) > 128 * 1024)
                throw Error("artifact payload exceeds 128 KiB");
              payload = JSON.parse(source);
            }
            return deps.projectChatArtifactData({
              ctx,
              action,
              projectIdentifier: opts.project,
              path: normalizePath(opts.path),
              threadId: normalizeThreadId(opts.threadId),
              artifactId: opts.artifactId,
              operationId: opts.operationId,
              messageDate: opts.messageDate,
              experimental: opts.experimental,
              payload,
            });
          },
        );
      });
  }

  const thread = chat.command("thread").description("project chat threads");

  thread
    .command("create")
    .description("create a thread in a .chat document")
    .requiredOption("--path <path>", "chat document path inside the project")
    .option("-w, --project <project>", "project id or name")
    .option("--thread-id <id>", "explicit thread id (defaults to random uuid)")
    .option("--name <name>", "thread display name")
    .option("--agent-kind <kind>", "agent kind (acp|llm|none)", "acp")
    .option(
      "--agent-mode <mode>",
      "agent mode (interactive|single_turn)",
      "interactive",
    )
    .option("--agent-model <model>", "agent model label shown in the UI")
    .option("--model <model>", "Codex model name for ACP threads")
    .option(
      "--reasoning <level>",
      "reasoning level (low|medium|high|extra_high|max|ultra)",
    )
    .option(
      "--service-tier <tier>",
      "codex service tier (standard|fast); standard is the default",
    )
    .option("--fast", "use Codex Fast mode with higher credit usage")
    .option(
      "--session-mode <mode>",
      "session mode (auto|read-only|workspace-write|full-access)",
    )
    .option("--workdir <path>", "working directory inside project")
    .action(
      async (
        opts: {
          path: string;
          project?: string;
          threadId?: string;
          name?: string;
          agentKind?: "acp" | "llm" | "none";
          agentMode?: "interactive" | "single_turn";
          agentModel?: string;
          model?: string;
          reasoning?: string;
          serviceTier?: string;
          fast?: boolean;
          sessionMode?: string;
          workdir?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "project chat thread create",
          async (ctx) => {
            const acpConfig =
              opts.agentKind === "acp"
                ? buildCodexSessionConfig({
                    model: opts.model,
                    reasoning: opts.reasoning,
                    serviceTier: opts.serviceTier,
                    fast: opts.fast,
                    sessionMode: opts.sessionMode,
                    workdir: opts.workdir,
                  })
                : undefined;
            return await projectChatThreadCreateData({
              ctx,
              projectIdentifier: opts.project,
              path: normalizePath(opts.path),
              threadId: opts.threadId,
              name: opts.name,
              agentKind: opts.agentKind,
              agentModel:
                opts.agentModel ??
                (opts.agentKind === "acp" ? opts.model : undefined),
              agentMode: opts.agentMode,
              acpConfig,
            });
          },
        );
      },
    );

  thread
    .command("status")
    .description("show thread config/state for a .chat document")
    .requiredOption("--path <path>", "chat document path inside the project")
    .option("-w, --project <project>", "project id or name")
    .option("--thread-id <id>", "specific thread id (omit to list all threads)")
    .action(
      async (
        opts: { path: string; project?: string; threadId?: string },
        command: Command,
      ) => {
        await withContext(
          command,
          "project chat thread status",
          async (ctx) => {
            return await projectChatThreadStatusData({
              ctx,
              projectIdentifier: opts.project,
              path: normalizePath(opts.path),
              threadId: opts.threadId,
            });
          },
        );
      },
    );

  chat
    .command("activity")
    .description("fetch persisted Codex activity log for a chat thread")
    .requiredOption("--path <path>", "chat document path inside the project")
    .requiredOption("--thread-id <id>", "thread id")
    .option(
      "--message-id <id>",
      "specific assistant message id (defaults to the latest persisted activity in the thread)",
    )
    .option("-w, --project <project>", "project id or name")
    .action(
      async (
        opts: {
          path: string;
          threadId: string;
          messageId?: string;
          project?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "project chat activity", async (ctx) => {
          return await projectChatActivityData({
            ctx,
            projectIdentifier: opts.project,
            path: normalizePath(opts.path),
            threadId: normalizeThreadId(opts.threadId),
            messageId: opts.messageId,
          });
        });
      },
    );

  const automation = chat
    .command("automation")
    .description("project chat scheduled automation");

  automation
    .command("upsert")
    .description("create or update a scheduled automation for a thread")
    .requiredOption("--path <path>", "chat document path inside the project")
    .requiredOption("--thread-id <id>", "thread id")
    .requiredOption("--prompt <prompt>", "automation prompt")
    .requiredOption("--local-time <HH:MM>", "daily local time")
    .requiredOption("--timezone <iana>", "IANA timezone")
    .option("-w, --project <project>", "project id or name")
    .option("--title <title>", "automation title")
    .option(
      "--pause-after-unacknowledged-runs <n>",
      "pause after this many unacknowledged runs",
    )
    .option("--disabled", "create/update the automation in a paused state")
    .action(
      async (
        opts: {
          path: string;
          threadId: string;
          prompt: string;
          localTime: string;
          timezone: string;
          project?: string;
          title?: string;
          pauseAfterUnacknowledgedRuns?: string;
          disabled?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "project chat automation upsert",
          async (ctx) => {
            return await projectChatAutomationData({
              ctx,
              projectIdentifier: opts.project,
              path: normalizePath(opts.path),
              threadId: normalizeThreadId(opts.threadId),
              action: "upsert",
              config: {
                enabled: opts.disabled ? false : true,
                prompt: opts.prompt,
                local_time: opts.localTime,
                timezone: opts.timezone,
                ...(opts.title?.trim()
                  ? { title: opts.title.trim() }
                  : undefined),
                ...(parsePositiveIntegerOrThrow(
                  opts.pauseAfterUnacknowledgedRuns,
                  "--pause-after-unacknowledged-runs",
                ) != null
                  ? {
                      pause_after_unacknowledged_runs:
                        parsePositiveIntegerOrThrow(
                          opts.pauseAfterUnacknowledgedRuns,
                          "--pause-after-unacknowledged-runs",
                        ),
                    }
                  : undefined),
              },
            });
          },
        );
      },
    );

  for (const action of [
    ["pause", "pause a scheduled automation"],
    ["resume", "resume a scheduled automation"],
    ["run-now", "enqueue an automation run immediately"],
    ["acknowledge", "acknowledge the latest automation run"],
    ["delete", "delete a scheduled automation"],
    ["status", "show automation config/state for a thread"],
  ] as const) {
    const [name, description] = action;
    automation
      .command(name)
      .description(description)
      .requiredOption("--path <path>", "chat document path inside the project")
      .requiredOption("--thread-id <id>", "thread id")
      .option("-w, --project <project>", "project id or name")
      .action(
        async (
          opts: { path: string; threadId: string; project?: string },
          command: Command,
        ) => {
          await withContext(
            command,
            `project chat automation ${name}`,
            async (ctx) => {
              return await projectChatAutomationData({
                ctx,
                projectIdentifier: opts.project,
                path: normalizePath(opts.path),
                threadId: normalizeThreadId(opts.threadId),
                action:
                  name === "run-now"
                    ? "run_now"
                    : (name as
                        | "pause"
                        | "resume"
                        | "acknowledge"
                        | "delete"
                        | "status"),
              });
            },
          );
        },
      );
  }
}
