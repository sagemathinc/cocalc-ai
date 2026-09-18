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
  AgentRpcOutcome,
  AgentRpcPreparation,
  AgentRpcSend,
  AgentRpcTarget,
} from "@cocalc/conat/agents/rpc";
import type { AgentSessionDiscovery } from "@cocalc/conat/agents/personal";
import {
  isExternalAgentSource,
  validateAgentRpcPreparation,
} from "@cocalc/conat/agents/rpc";
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
    projectChatSendData,
    readAllStdin,
  } = deps;

  const chat = project.command("chat").description("project chat operations");
  registerChatAgentCommands(chat, deps);

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
    .option("--rpc", "send one session-authorized attempt (no retries)")
    .option(
      "--external-agent <profile>",
      "use only this session-enrolled external agent profile",
    )
    .option(
      "--attempt-id <uuid>",
      "attempt identifier; deliberate retries require a NEW identifier",
    )
    .option(
      "--agent-session <uuid>",
      "exact Agent Session authorizing the send",
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
          agentSession?: string;
          attach?: string[];
        },
        command: Command,
      ) => {
        if (opts.stdin && message.length)
          throw new Error("use either message arguments or --stdin, not both");
        const prompt = opts.stdin ? await readAllStdin() : message.join(" ");
        if (!prompt.trim()) throw new Error("message must not be empty");
        if (opts.rpc || opts.to || opts.externalAgent) {
          if (opts.guidance)
            throw new Error(
              "Agent delivery is determined by --agent-session; --guidance is not accepted",
            );
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
          requireUuid(opts.agentSession, "agent-session");
          const attempt_id = opts.attemptId || randomUUID();
          requireUuid(attempt_id, "attempt-id");
          const globals = deps.globalsFrom(command);
          const send = (
            request: import("@cocalc/conat/agents/rpc").AgentRpcRequest,
          ) =>
            opts.externalAgent
              ? sendExternalAgentMessage(opts.externalAgent, request)
              : sendIdentityMessage(request, globals.api);
          let target: AgentRpcTarget;
          let agent_session_id = opts.agentSession!;
          if (opts.to) {
            const resolved = opts.externalAgent
              ? await resolveExternalAgentName(
                  opts.externalAgent,
                  opts.to,
                  agent_session_id,
                )
              : await resolveRuntimeAgentName(
                  opts.to,
                  globals.api,
                  agent_session_id,
                );
            target = resolved.target;
            agent_session_id = resolved.agent_session_id;
          } else {
            const destinations = (await send({
              version: 3,
              action: "destinations",
            })) as AgentSessionDiscovery;
            const destination = destinations.peers.find(
              ({ member, sessions }) =>
                member.kind === "registered" &&
                member.endpoint.agent_id === opts.toAgent &&
                sessions.some(
                  (session) => session.agent_session_id === agent_session_id,
                ),
            );
            if (!destination || destination.member.kind !== "registered")
              throw new Error(
                "Target is not a registered member of the exact Agent Session; no submission attempted",
              );
            target = destination.member.endpoint;
          }
          process.stderr.write(
            `Agent RPC attempt ${attempt_id}; target ${JSON.stringify(target)}\n`,
          );
          let file_references;
          let snapshots:
            | Awaited<ReturnType<typeof readAgentAttachmentSnapshots>>
            | undefined;
          if (opts.attach?.length) {
            if (isExternalAgentSource(target))
              throw new Error(
                "Attachments to external session members are not supported",
              );
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
            version: 3,
            attempt_id,
            agent_session_id,
            target,
            body: prompt,
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
