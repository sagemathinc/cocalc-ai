import { Command } from "commander";

import {
  coerceWorkspaceSelection,
  createStoredWorkspaceRecord,
  deleteStoredWorkspaceRecord,
  openWorkspaceStore,
  readStoredWorkspaceRecords,
  resolveWorkspaceForPath,
  resolveWorkspaceIdentifier,
  type WorkspaceRecord,
  type WorkspaceSelection,
  type WorkspaceUpdatePatch,
  updateStoredWorkspaceRecord,
} from "@cocalc/conat/workspaces";
import { createBrowserSessionClient } from "@cocalc/conat/service/browser-session";
import { resolveBrowserPolicyAndPosture } from "./browser/exec-helpers";
import {
  browserHintFromOption,
  chooseBrowserSession,
  loadProfileSelection,
  sessionTargetContext,
} from "./browser/targeting";
import { createWorkspaceChatOps } from "../core/workspace-chat";

type ProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export type WorkspacesCommandDeps = {
  withContext: any;
  resolveProjectConatClient: (
    ctx: any,
    projectIdentifier?: string,
    cwd?: string,
  ) => Promise<{ project: ProjectIdentity; client: any }>;
  authConfigPath: (env?: NodeJS.ProcessEnv) => string;
  loadAuthConfig: (path: string) => any;
  saveAuthConfig: (config: any, path: string) => void;
  selectedProfileName: (
    globals: any,
    config: any,
    env?: NodeJS.ProcessEnv,
  ) => string;
  globalsFrom: (command: Command) => any;
};

type WorkspaceThemeCliOptions = {
  title?: string;
  description?: string;
  color?: string;
  accentColor?: string;
  icon?: string;
  imageBlob?: string;
  pinned?: string;
};

type WorkspaceProjectCliOptions = {
  project?: string;
};

type WorkspaceUpdateCliOptions = WorkspaceProjectCliOptions &
  WorkspaceThemeCliOptions & {
    rootPath?: string;
  };

type WorkspaceCreateCliOptions = WorkspaceProjectCliOptions &
  WorkspaceThemeCliOptions;

type WorkspaceSelectCliOptions = WorkspaceProjectCliOptions & {
  browser?: string;
  sessionProjectId?: string;
  activeOnly?: boolean;
  requireDiscovery?: boolean;
  posture?: string;
  policyFile?: string;
  allowRawExec?: boolean;
};

type WorkspaceBrowserCliOptions = WorkspaceSelectCliOptions;

type WorkspaceMessageCliOptions = WorkspaceBrowserCliOptions & {
  stdin?: boolean;
  open?: boolean;
  foreground?: boolean;
  background?: boolean;
  tag?: string;
};

type WorkspaceNoticeCliOptions = WorkspaceProjectCliOptions & {
  title?: string;
  level?: string;
  stdin?: boolean;
};

function normalizeWorkspaceCliPath(path: string): string {
  const raw = `${path ?? ""}`.trim();
  if (!raw) {
    throw new Error("workspace path must be non-empty");
  }
  if (!raw.startsWith("/")) {
    throw new Error("workspace paths must be absolute");
  }
  return raw.replace(/\/+$/g, "") || "/";
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`invalid boolean value '${value}'`);
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseWorkspaceNoticeLevel(
  value: string | undefined,
): "info" | "success" | "warning" | "error" {
  const normalized = `${value ?? "info"}`.trim().toLowerCase();
  if (
    normalized === "info" ||
    normalized === "success" ||
    normalized === "warning" ||
    normalized === "error"
  ) {
    return normalized;
  }
  throw new Error(`invalid notice level '${value}'`);
}

function workspaceSummary(record: WorkspaceRecord): Record<string, unknown> {
  return {
    workspace_id: record.workspace_id,
    project_id: record.project_id,
    root_path: record.root_path,
    title: record.theme?.title ?? "",
    description: record.theme?.description ?? "",
    color: record.theme?.color ?? null,
    accent_color: record.theme?.accent_color ?? null,
    icon: record.theme?.icon ?? null,
    image_blob: record.theme?.image_blob ?? null,
    pinned: record.pinned === true,
    last_used_at: record.last_used_at ?? null,
    last_active_path: record.last_active_path ?? null,
    chat_path: record.chat_path ?? null,
    notice: record.notice ?? null,
    source: record.source ?? null,
  };
}

function buildThemePatch(
  opts: WorkspaceThemeCliOptions,
): WorkspaceUpdatePatch["theme"] | undefined {
  const theme: WorkspaceUpdatePatch["theme"] = {};
  if (opts.title != null) theme.title = opts.title;
  if (opts.description != null) theme.description = opts.description;
  if (opts.color != null) theme.color = opts.color || null;
  if (opts.accentColor != null) theme.accent_color = opts.accentColor || null;
  if (opts.icon != null) theme.icon = opts.icon || null;
  if (opts.imageBlob != null) theme.image_blob = opts.imageBlob || null;
  return Object.keys(theme).length > 0 ? theme : undefined;
}

function requireWorkspaceRecord(
  records: WorkspaceRecord[],
  identifier: string,
): WorkspaceRecord {
  const record = resolveWorkspaceIdentifier(records, identifier);
  if (!record) {
    throw new Error(`workspace '${identifier}' not found`);
  }
  return record;
}

export function registerWorkspacesCommand(
  program: Command,
  deps: WorkspacesCommandDeps,
): Command {
  const { appendWorkspaceMessageData } = createWorkspaceChatOps({
    resolveProjectConatClient: deps.resolveProjectConatClient,
  });
  const workspaces = program
    .command("workspaces")
    .description(
      "manage project-scoped workspaces and browser workspace selection",
    );

  workspaces
    .command("list")
    .description("list saved workspaces for a project")
    .option("--project <project>", "project id/title")
    .action(async (opts: WorkspaceProjectCliOptions, command: Command) => {
      await deps.withContext(command, "workspaces list", async (ctx) => {
        const { project, client } = await deps.resolveProjectConatClient(
          ctx,
          opts.project,
        );
        const store = await openWorkspaceStore({
          client,
          project_id: project.project_id,
          account_id: ctx.accountId,
        });
        try {
          return readStoredWorkspaceRecords(store).map(workspaceSummary);
        } finally {
          store.close();
        }
      });
    });

  workspaces
    .command("create <root_path>")
    .description("create a workspace for an absolute directory")
    .option("--project <project>", "project id/title")
    .option("--title <title>", "workspace title")
    .option("--description <description>", "workspace description")
    .option("--color <color>", "primary color")
    .option("--accent-color <color>", "accent color")
    .option("--icon <icon>", "icon name")
    .option("--image-blob <blob>", "image blob hash")
    .option("--pinned <bool>", "whether the workspace should be pinned")
    .action(
      async (
        root_path: string,
        opts: WorkspaceCreateCliOptions,
        command: Command,
      ) => {
        await deps.withContext(command, "workspaces create", async (ctx) => {
          const { project, client } = await deps.resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const store = await openWorkspaceStore({
            client,
            project_id: project.project_id,
            account_id: ctx.accountId,
          });
          try {
            const record = createStoredWorkspaceRecord(store, {
              project_id: project.project_id,
              input: {
                root_path: normalizeWorkspaceCliPath(root_path),
                title: opts.title,
                description: opts.description,
                color: opts.color ?? null,
                accent_color: opts.accentColor ?? null,
                icon: opts.icon ?? null,
                image_blob: opts.imageBlob ?? null,
                pinned: parseOptionalBoolean(opts.pinned) === true,
                source: "manual",
              },
            });
            await store.save();
            return workspaceSummary(record);
          } finally {
            store.close();
          }
        });
      },
    );

  workspaces
    .command("update <workspace>")
    .description("update a workspace by id or root path")
    .option("--project <project>", "project id/title")
    .option("--root-path <path>", "new root path")
    .option("--title <title>", "workspace title")
    .option("--description <description>", "workspace description")
    .option("--color <color>", "primary color")
    .option("--accent-color <color>", "accent color")
    .option("--icon <icon>", "icon name")
    .option("--image-blob <blob>", "image blob hash")
    .option("--pinned <bool>", "whether the workspace should be pinned")
    .action(
      async (
        workspace: string,
        opts: WorkspaceUpdateCliOptions,
        command: Command,
      ) => {
        await deps.withContext(command, "workspaces update", async (ctx) => {
          const { project, client } = await deps.resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const store = await openWorkspaceStore({
            client,
            project_id: project.project_id,
            account_id: ctx.accountId,
          });
          try {
            const records = readStoredWorkspaceRecords(store);
            const record = requireWorkspaceRecord(records, workspace);
            const patch: WorkspaceUpdatePatch = {
              ...(opts.rootPath
                ? { root_path: normalizeWorkspaceCliPath(opts.rootPath) }
                : {}),
              ...(buildThemePatch(opts)
                ? { theme: buildThemePatch(opts) }
                : {}),
              ...(opts.pinned != null
                ? { pinned: parseOptionalBoolean(opts.pinned) === true }
                : {}),
            };
            const updated = updateStoredWorkspaceRecord(
              store,
              record.workspace_id,
              patch,
            );
            if (!updated) {
              throw new Error(`workspace '${workspace}' not found`);
            }
            await store.save();
            return workspaceSummary(updated);
          } finally {
            store.close();
          }
        });
      },
    );

  workspaces
    .command("delete <workspace>")
    .description("delete a workspace by id or root path")
    .option("--project <project>", "project id/title")
    .action(
      async (
        workspace: string,
        opts: WorkspaceProjectCliOptions,
        command: Command,
      ) => {
        await deps.withContext(command, "workspaces delete", async (ctx) => {
          const { project, client } = await deps.resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const store = await openWorkspaceStore({
            client,
            project_id: project.project_id,
            account_id: ctx.accountId,
          });
          try {
            const records = readStoredWorkspaceRecords(store);
            const record = requireWorkspaceRecord(records, workspace);
            deleteStoredWorkspaceRecord(store, record.workspace_id);
            await store.save();
            return {
              deleted: true,
              workspace_id: record.workspace_id,
              root_path: record.root_path,
            };
          } finally {
            store.close();
          }
        });
      },
    );

  workspaces
    .command("resolve <path>")
    .description("resolve a path to the most specific matching workspace")
    .option("--project <project>", "project id/title")
    .action(
      async (
        path: string,
        opts: WorkspaceProjectCliOptions,
        command: Command,
      ) => {
        await deps.withContext(command, "workspaces resolve", async (ctx) => {
          const { project, client } = await deps.resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const store = await openWorkspaceStore({
            client,
            project_id: project.project_id,
            account_id: ctx.accountId,
          });
          try {
            const resolved = resolveWorkspaceForPath(
              readStoredWorkspaceRecords(store),
              normalizeWorkspaceCliPath(path),
            );
            return resolved ? workspaceSummary(resolved) : null;
          } finally {
            store.close();
          }
        });
      },
    );

  workspaces
    .command("select <selection>")
    .description(
      "set the selected workspace in a target browser session (all, unscoped, workspace id, or workspace root path)",
    )
    .option("--project <project>", "project id/title")
    .option("--browser <id>", "browser id or unique prefix")
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this project open",
    )
    .option("--active-only", "only target active browser sessions")
    .option("--require-discovery", "force browser session discovery")
    .option("--posture <posture>", "browser exec posture")
    .option("--policy-file <path>", "browser exec policy file")
    .option("--allow-raw-exec", "allow raw browser exec")
    .action(
      async (
        selectionArg: string,
        opts: WorkspaceSelectCliOptions,
        command: Command,
      ) => {
        await deps.withContext(command, "workspaces select", async (ctx) => {
          const { project, client } = await deps.resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const store = await openWorkspaceStore({
            client,
            project_id: project.project_id,
            account_id: ctx.accountId,
          });
          let selection: WorkspaceSelection;
          try {
            const raw = `${selectionArg ?? ""}`.trim();
            if (raw === "all" || raw === "unscoped") {
              selection = { kind: raw };
            } else {
              const record = requireWorkspaceRecord(
                readStoredWorkspaceRecords(store),
                raw,
              );
              selection = {
                kind: "workspace",
                workspace_id: record.workspace_id,
              };
            }
          } finally {
            store.close();
          }

          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser) ?? "",
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: !!opts.requireDiscovery,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() || project.project_id,
            activeOnly: !!opts.activeOnly,
          });
          const browserClient = createBrowserSessionClient({
            client: ctx.remote.client,
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            allowRawExec: opts.allowRawExec,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const response = await browserClient.exec({
            project_id: project.project_id,
            code: `return await api.workspaces.setSelection(${JSON.stringify(
              coerceWorkspaceSelection(selection),
            )});`,
            posture,
            policy,
          });
          return {
            project_id: project.project_id,
            browser_id: sessionInfo.browser_id,
            selection: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project.project_id),
          };
        });
      },
    );

  workspaces
    .command("open-chat <workspace>")
    .description(
      "open the canonical chat for a workspace in a target browser session",
    )
    .option("--project <project>", "project id/title")
    .option("--browser <id>", "browser id or unique prefix")
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this project open",
    )
    .option("--active-only", "only target active browser sessions")
    .option("--require-discovery", "force browser session discovery")
    .option("--posture <posture>", "browser exec posture")
    .option("--policy-file <path>", "browser exec policy file")
    .option("--allow-raw-exec", "allow raw browser exec")
    .option("--background", "open the workspace chat without focusing it")
    .action(
      async (
        workspace: string,
        opts: WorkspaceBrowserCliOptions & { background?: boolean },
        command: Command,
      ) => {
        await deps.withContext(command, "workspaces open-chat", async (ctx) => {
          const { project, client } = await deps.resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const store = await openWorkspaceStore({
            client,
            project_id: project.project_id,
            account_id: ctx.accountId,
          });
          let record: WorkspaceRecord;
          try {
            record = requireWorkspaceRecord(
              readStoredWorkspaceRecords(store),
              workspace,
            );
          } finally {
            store.close();
          }

          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser) ?? "",
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: !!opts.requireDiscovery,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() || project.project_id,
            activeOnly: !!opts.activeOnly,
          });
          const browserClient = createBrowserSessionClient({
            client: ctx.remote.client,
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            allowRawExec: opts.allowRawExec,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const response = await browserClient.exec({
            project_id: project.project_id,
            code: `return await api.workspaces.openChat(${JSON.stringify({
              workspace_id: record.workspace_id,
              foreground: !opts.background,
            })});`,
            posture,
            policy,
          });
          return {
            project_id: project.project_id,
            browser_id: sessionInfo.browser_id,
            workspace: workspaceSummary(record),
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project.project_id),
          };
        });
      },
    );

  workspaces
    .command("message <workspace> [text...]")
    .description(
      "append a durable message to a workspace's canonical chat, optionally opening that chat in a browser",
    )
    .option("--project <project>", "project id/title")
    .option("--browser <id>", "browser id or unique prefix")
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this project open",
    )
    .option("--active-only", "only target active browser sessions")
    .option("--require-discovery", "force browser session discovery")
    .option("--posture <posture>", "browser exec posture")
    .option("--policy-file <path>", "browser exec policy file")
    .option("--allow-raw-exec", "allow raw browser exec")
    .option("--stdin", "append stdin to the message text")
    .option(
      "--open",
      "after writing the durable message, open/focus the canonical workspace chat in a target browser session",
    )
    .option(
      "--background",
      "when opening, keep the workspace chat in the background",
    )
    .option("--tag <tag>", "optional message tag")
    .action(
      async (
        workspace: string,
        textParts: string[],
        opts: WorkspaceMessageCliOptions,
        command: Command,
      ) => {
        await deps.withContext(command, "workspaces message", async (ctx) => {
          const stdinText = opts.stdin ? (await readAllStdin()).trim() : "";
          const text = [textParts.join(" ").trim(), stdinText]
            .filter((part) => part.length > 0)
            .join("\n\n")
            .trim();
          if (!text) {
            throw new Error(
              "message text is required (pass text arguments or use --stdin)",
            );
          }
          const durable = await appendWorkspaceMessageData({
            ctx,
            projectIdentifier: opts.project,
            workspaceIdentifier: workspace,
            text,
            tag: opts.tag?.trim() || undefined,
          });

          const data: Record<string, unknown> = {
            project_id: durable.project.project_id,
            workspace: workspaceSummary(durable.workspace),
            result: {
              ok: true,
              workspace_id: durable.workspace.workspace_id,
              chat_path: durable.chat_path,
              notice_thread_id: durable.notice_thread_id,
              assigned: durable.assigned,
              created_thread: durable.created_thread,
              message_id: durable.message_id,
              timestamp: durable.timestamp,
            },
          };

          if (opts.open === true) {
            const profileSelection = loadProfileSelection(deps, command);
            const sessionInfo = await chooseBrowserSession({
              ctx,
              browserHint: browserHintFromOption(opts.browser) ?? "",
              fallbackBrowserId: profileSelection.browser_id,
              requireDiscovery: !!opts.requireDiscovery,
              sessionProjectId:
                `${opts.sessionProjectId ?? ""}`.trim() ||
                durable.project.project_id,
              activeOnly: !!opts.activeOnly,
            });
            const browserClient = createBrowserSessionClient({
              client: ctx.remote.client,
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
            });
            const { posture, policy } = await resolveBrowserPolicyAndPosture({
              posture: opts.posture,
              policyFile: opts.policyFile,
              allowRawExec: opts.allowRawExec,
              apiBaseUrl: ctx.apiBaseUrl,
            });
            const response = await browserClient.exec({
              project_id: durable.project.project_id,
              code: `return await api.workspaces.openChat(${JSON.stringify({
                workspace_id: durable.workspace.workspace_id,
                foreground: !opts.background,
              })});`,
              posture,
              policy,
            });
            Object.assign(data, {
              browser_id: sessionInfo.browser_id,
              open_result: response?.result ?? null,
              ...sessionTargetContext(
                ctx,
                sessionInfo,
                durable.project.project_id,
              ),
            });
          }

          return data;
        });
      },
    );

  workspaces
    .command("notify <workspace> [text...]")
    .description("set a card-level notice on a workspace")
    .option("--project <project>", "project id/title")
    .option("--title <title>", "optional notice title")
    .option(
      "--level <level>",
      "notice level (info|success|warning|error)",
      "info",
    )
    .option("--stdin", "append stdin to the notice text")
    .action(
      async (
        workspace: string,
        textParts: string[],
        opts: WorkspaceNoticeCliOptions,
        command: Command,
      ) => {
        await deps.withContext(command, "workspaces notify", async (ctx) => {
          const stdinText = opts.stdin ? (await readAllStdin()).trim() : "";
          const text = [textParts.join(" ").trim(), stdinText]
            .filter((part) => part.length > 0)
            .join("\n\n")
            .trim();
          if (!text) {
            throw new Error(
              "notice text is required (pass text arguments or use --stdin)",
            );
          }
          const { project, client } = await deps.resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const store = await openWorkspaceStore({
            client,
            project_id: project.project_id,
            account_id: ctx.accountId,
          });
          try {
            const record = requireWorkspaceRecord(
              readStoredWorkspaceRecords(store),
              workspace,
            );
            const updated = updateStoredWorkspaceRecord(
              store,
              record.workspace_id,
              {
                notice: {
                  title: `${opts.title ?? ""}`.trim(),
                  text,
                  level: parseWorkspaceNoticeLevel(opts.level),
                  updated_at: Date.now(),
                },
              },
            );
            if (!updated) {
              throw new Error(`workspace '${workspace}' not found`);
            }
            await store.save();
            return workspaceSummary(updated);
          } finally {
            store.close();
          }
        });
      },
    );

  workspaces
    .command("clear-notice <workspace>")
    .description("clear a card-level notice from a workspace")
    .option("--project <project>", "project id/title")
    .action(
      async (
        workspace: string,
        opts: WorkspaceProjectCliOptions,
        command: Command,
      ) => {
        await deps.withContext(
          command,
          "workspaces clear-notice",
          async (ctx) => {
            const { project, client } = await deps.resolveProjectConatClient(
              ctx,
              opts.project,
            );
            const store = await openWorkspaceStore({
              client,
              project_id: project.project_id,
              account_id: ctx.accountId,
            });
            try {
              const record = requireWorkspaceRecord(
                readStoredWorkspaceRecords(store),
                workspace,
              );
              const updated = updateStoredWorkspaceRecord(
                store,
                record.workspace_id,
                { notice: null },
              );
              if (!updated) {
                throw new Error(`workspace '${workspace}' not found`);
              }
              await store.save();
              return workspaceSummary(updated);
            } finally {
              store.close();
            }
          },
        );
      },
    );

  return workspaces;
}
