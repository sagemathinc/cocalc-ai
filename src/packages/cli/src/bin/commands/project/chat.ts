import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { sendIdentityMessage } from "../../core/agent-message";
import {
  sendExternalAgentMessage,
  resolveExternalAgentName,
} from "../../core/external-agent-message";
import {
  readAgentFileReferences,
  readAgentAttachmentSnapshots,
} from "../../core/agent-attachments";
import type { AgentSelf } from "@cocalc/conat/agents/protocol";
import { resolveRuntimeAgentName } from "../../core/agent-destination";
import { registerChatAgentCommands } from "./chat-agents";
import { requireUuid } from "@cocalc/conat/agents/protocol";
import type {
  AgentEndpoint,
  AgentRpcLink,
  AgentRpcOutcome,
  AgentRpcPreparation,
  AgentRpcSend,
} from "@cocalc/conat/agents/rpc";
import { validateAgentRpcPreparation } from "@cocalc/conat/agents/rpc";

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
    projectChatSendData,
    readAllStdin,
  } = deps;

  const chat = project.command("chat").description("project chat operations");
  registerChatAgentCommands(chat, deps);

  const thread = chat.command("thread").description("project chat threads");

  chat
    .command("send")
    .description(
      "send to an existing Codex thread; start a turn or queue behind active work",
    )
    .argument(
      "[message...]",
      "message text (use --stdin for multiline text or JSON)",
    )
    .option("--path <path>", "chat document path inside the project")
    .option(
      "--thread-id <id>",
      "thread id from 'project chat thread list' or Codex settings",
    )
    .option("-w, --project <project>", "project id or name")
    .option(
      "--to <name>",
      "exact personal agent name or selected @mention; uses scoped RPC",
    )
    .option(
      "--to-agent <id>",
      "registered target agent; requires a runtime identity credential",
    )
    .option(
      "--request-id <uuid>",
      "stable idempotency key for identity sends and receipt lookup",
    )
    .option("--stdin", "read the message from standard input")
    .option(
      "--attach <path>",
      "attach a file (repeatable; same-project live references, cross-project snapshots up to 32 MiB total)",
      (value: string, paths: string[]) => [...paths, value],
      [],
    )
    .option("--rpc", "opt in to V2 single-attempt RPC (no delivery retries)")
    .option(
      "--external-agent <profile>",
      "use only this browser-approved external send profile",
    )
    .option(
      "--attempt-id <uuid>",
      "V2 attempt identifier; deliberate retries require a NEW identifier",
    )
    .option(
      "--guidance",
      "guide the running turn if possible; otherwise start a normal turn",
    )
    .action(
      async (
        message: string[],
        opts: {
          path: string;
          threadId: string;
          project?: string;
          stdin?: boolean;
          guidance?: boolean;
          toAgent?: string;
          to?: string;
          requestId?: string;
          rpc?: boolean;
          externalAgent?: string;
          attemptId?: string;
          attach?: string[];
        },
        command: Command,
      ) => {
        if (opts.stdin && message.length)
          throw new Error("use either message arguments or --stdin, not both");
        const prompt = opts.stdin ? await readAllStdin() : message.join(" ");
        if (!prompt.trim()) throw new Error("message must not be empty");
        if (opts.rpc || opts.to || opts.externalAgent) {
          if (opts.externalAgent && opts.guidance)
            throw new Error("External agents cannot steer turns");
          if (
            (!opts.toAgent && !opts.to) ||
            (opts.toAgent && opts.to) ||
            opts.requestId ||
            opts.project ||
            opts.path ||
            opts.threadId
          )
            throw new Error(
              "Use --to name or --rpc --to-agent ID, not both; cannot use legacy --request-id or project/path/thread options",
            );
          if (opts.toAgent) requireUuid(opts.toAgent, "to-agent");
          const attempt_id = opts.attemptId || randomUUID();
          requireUuid(attempt_id, "attempt-id");
          const globals = deps.globalsFrom(command);
          const send = (
            request: import("@cocalc/conat/agents/rpc").AgentRpcRequest,
          ) =>
            opts.externalAgent
              ? sendExternalAgentMessage(opts.externalAgent, request)
              : sendIdentityMessage(request, globals.api);
          let target: AgentEndpoint;
          if (opts.to) {
            target = opts.externalAgent
              ? await resolveExternalAgentName(opts.externalAgent, opts.to)
              : await resolveRuntimeAgentName(opts.to, globals.api);
          } else {
            const destinations = (await send({
              version: 2,
              action: "destinations",
            })) as AgentRpcLink[];
            const destination = destinations.find(
              (link) =>
                link.target.agent_id === opts.toAgent &&
                (!opts.guidance || link.allow_guidance),
            );
            if (!destination)
              throw new Error(
                "No approved RPC destination; no submission attempted",
              );
            target = destination.target;
          }
          process.stderr.write(
            `Agent RPC attempt ${attempt_id}; target ${JSON.stringify(target)}\n`,
          );
          let file_references;
          let snapshots:
            | Awaited<ReturnType<typeof readAgentAttachmentSnapshots>>
            | undefined;
          if (opts.attach?.length) {
            const self = opts.externalAgent
              ? undefined
              : ((await sendIdentityMessage(
                  { action: "whoami" },
                  globals.api,
                )) as AgentSelf);
            if (self?.identity?.project_id !== target.project_id) {
              snapshots = await readAgentAttachmentSnapshots(opts.attach);
            } else {
              const metadata = await readAgentFileReferences(opts.attach);
              if (metadata.kind !== "project-files")
                throw new Error("invalid file references");
              file_references = metadata.files;
            }
          }
          const request: AgentRpcSend = {
            version: 2,
            attempt_id,
            target,
            body: prompt,
            guidance: opts.guidance,
            ...(file_references ? { file_references } : {}),
          };
          if (snapshots) {
            if (snapshots.metadata.kind !== "snapshots")
              throw new Error("invalid snapshot metadata");
            request.snapshot_manifest = snapshots.metadata.files;
            const ready = (await send({
              ...request,
              action: "prepare-attachments",
            })) as AgentRpcPreparation;
            validateAgentRpcPreparation(ready, request);
            if (ready.outcome !== "prepared") {
              deps.emitSuccess({ globals }, "project chat send", ready);
              process.exitCode =
                ready.outcome === "accepted"
                  ? 0
                  : ready.outcome === "rejected"
                    ? 2
                    : 3;
              return;
            }
            request.attachment_reservation = ready.reservation_id;
            if (ready.expires_at <= Date.now())
              throw new Error(
                "Attachment preparation expired before transfer; no message was sent",
              );
          }
          const result = (await send({
            ...request,
            action: "send",
            ...(snapshots ? { snapshot_payload: snapshots.files } : {}),
          })) as AgentRpcOutcome;
          deps.emitSuccess({ globals }, "project chat send", result);
          process.exitCode =
            result.outcome === "accepted"
              ? 0
              : result.outcome === "rejected"
                ? 2
                : 3;
          return;
        }
        if (opts.attemptId) throw new Error("--attempt-id requires --rpc");
        if (opts.attach?.length)
          throw new Error(
            "--attach requires a scoped agent send with --to or --rpc",
          );
        if (
          opts.toAgent ||
          opts.requestId ||
          process.env.COCALC_AGENT_IDENTITY_FILE
        )
          throw new Error(
            "Scoped agent sends require --rpc and --to-agent; legacy delivery is retired",
          );
        await withContext(command, "project chat send", async (ctx) => {
          return await projectChatSendData({
            ctx,
            projectIdentifier: opts.project,
            path: normalizePath(opts.path),
            threadId: normalizeThreadId(opts.threadId),
            prompt,
            guidance: opts.guidance,
          });
        });
      },
    );

  thread
    .command("list")
    .description("list thread IDs, names, and agent kinds in a .chat document")
    .requiredOption("--path <path>", "chat document path inside the project")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (opts: { path: string; project?: string }, command: Command) => {
        await withContext(command, "project chat thread list", async (ctx) => {
          const result = await projectChatThreadStatusData({
            ctx,
            projectIdentifier: opts.project,
            path: normalizePath(opts.path),
          });
          return result.threads.map(
            ({
              thread_id,
              name,
              agent_kind,
              archived,
            }: {
              thread_id: string;
              name: string | null;
              agent_kind: string | null;
              archived: boolean;
            }) => ({ thread_id, name, agent_kind, archived }),
          );
        });
      },
    );

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
