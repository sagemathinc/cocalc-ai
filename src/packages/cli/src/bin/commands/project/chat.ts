import { Command } from "commander";

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
    durationToMs,
    projectChatThreadCreateData,
    projectChatThreadStatusData,
    projectChatLoopSetData,
    projectChatLoopClearData,
    projectChatAutomationData,
  } = deps;

  const chat = project.command("chat").description("project chat operations");

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
      "reasoning level (low|medium|high|extra_high)",
    )
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

  const loop = chat.command("loop").description("project chat loop config");

  loop
    .command("set")
    .description("set loop config for a chat thread")
    .requiredOption("--path <path>", "chat document path inside the project")
    .requiredOption("--thread-id <id>", "thread id")
    .option("-w, --project <project>", "project id or name")
    .option("--max-turns <n>", "maximum loop turns")
    .option("--max-wall-time <duration>", "maximum wall time", "30m")
    .option("--check-in-every-turns <n>", "human check-in cadence")
    .option(
      "--stop-on-repeated-blocker-count <n>",
      "stop after this many repeated blockers",
    )
    .option("--sleep <duration>", "delay between turns", "0s")
    .action(
      async (
        opts: {
          path: string;
          threadId: string;
          project?: string;
          maxTurns?: string;
          maxWallTime?: string;
          checkInEveryTurns?: string;
          stopOnRepeatedBlockerCount?: string;
          sleep?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "project chat loop set", async (ctx) => {
          return await projectChatLoopSetData({
            ctx,
            projectIdentifier: opts.project,
            path: normalizePath(opts.path),
            threadId: normalizeThreadId(opts.threadId),
            config: {
              enabled: true,
              ...(parsePositiveIntegerOrThrow(opts.maxTurns, "--max-turns") !=
              null
                ? {
                    max_turns: parsePositiveIntegerOrThrow(
                      opts.maxTurns,
                      "--max-turns",
                    ),
                  }
                : undefined),
              max_wall_time_ms: durationToMs(opts.maxWallTime, 30 * 60 * 1000),
              ...(parsePositiveIntegerOrThrow(
                opts.checkInEveryTurns,
                "--check-in-every-turns",
              ) != null
                ? {
                    check_in_every_turns: parsePositiveIntegerOrThrow(
                      opts.checkInEveryTurns,
                      "--check-in-every-turns",
                    ),
                  }
                : undefined),
              ...(parsePositiveIntegerOrThrow(
                opts.stopOnRepeatedBlockerCount,
                "--stop-on-repeated-blocker-count",
              ) != null
                ? {
                    stop_on_repeated_blocker_count: parsePositiveIntegerOrThrow(
                      opts.stopOnRepeatedBlockerCount,
                      "--stop-on-repeated-blocker-count",
                    ),
                  }
                : undefined),
              sleep_ms_between_turns: durationToMs(opts.sleep, 0),
            },
          });
        });
      },
    );

  loop
    .command("clear")
    .description("clear loop config/state for a chat thread")
    .requiredOption("--path <path>", "chat document path inside the project")
    .requiredOption("--thread-id <id>", "thread id")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (
        opts: { path: string; threadId: string; project?: string },
        command: Command,
      ) => {
        await withContext(command, "project chat loop clear", async (ctx) => {
          return await projectChatLoopClearData({
            ctx,
            projectIdentifier: opts.project,
            path: normalizePath(opts.path),
            threadId: normalizeThreadId(opts.threadId),
          });
        });
      },
    );

  loop
    .command("status")
    .description("show loop config/state for a chat thread")
    .requiredOption("--path <path>", "chat document path inside the project")
    .requiredOption("--thread-id <id>", "thread id")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (
        opts: { path: string; threadId: string; project?: string },
        command: Command,
      ) => {
        await withContext(command, "project chat loop status", async (ctx) => {
          const result = await projectChatThreadStatusData({
            ctx,
            projectIdentifier: opts.project,
            path: normalizePath(opts.path),
            threadId: normalizeThreadId(opts.threadId),
          });
          const thread = (result as any).thread ?? {};
          return {
            project_id: (result as any).project_id,
            path: (result as any).path,
            thread_id: thread.thread_id ?? normalizeThreadId(opts.threadId),
            loop_config: thread.loop_config ?? null,
            loop_state: thread.loop_state ?? null,
          };
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
