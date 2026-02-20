/**
 * Workspace Codex integration commands.
 *
 * Provides remote codex execution and authentication/device-flow helpers that
 * run against workspace-hosted codex services.
 */
import { Command } from "commander";

import type { WorkspaceCommandDeps } from "../workspace";

export function registerWorkspaceCodexCommands(
  workspace: Command,
  deps: WorkspaceCommandDeps,
): void {
  const {
    withContext,
    readAllStdin,
    buildCodexSessionConfig,
    workspaceCodexExecData,
    streamCodexHumanMessage,
    workspaceCodexAuthStatusData,
    durationToMs,
    workspaceCodexDeviceAuthStartData,
    workspaceCodexDeviceAuthStatusData,
    workspaceCodexDeviceAuthCancelData,
    workspaceCodexAuthUploadFileData,
    resolveWorkspaceFromArgOrContext,
    toIso,
  } = deps;

const codex = workspace.command("codex").description("workspace codex operations");

codex
  .command("exec [prompt...]")
  .description("run a codex turn in a workspace using project-host containerized codex exec")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--stdin", "append stdin to prompt text")
  .option("--stream", "stream codex progress to stderr while running")
  .option("--jsonl", "emit raw codex stream messages as JSONL on stdout")
  .option("--session-id <id>", "reuse an existing codex session id")
  .option("--model <model>", "codex model name")
  .option("--reasoning <level>", "reasoning level (low|medium|high|extra_high)")
  .option(
    "--session-mode <mode>",
    "session mode (auto|read-only|workspace-write|full-access)",
  )
  .option("--workdir <path>", "working directory inside workspace")
  .action(
    async (
      promptArgs: string[],
      opts: {
        workspace?: string;
        stdin?: boolean;
        stream?: boolean;
        jsonl?: boolean;
        sessionId?: string;
        model?: string;
        reasoning?: string;
        sessionMode?: string;
        workdir?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace codex exec", async (ctx) => {
        const parts: string[] = [];
        const inlinePrompt = (promptArgs ?? []).join(" ").trim();
        if (inlinePrompt) {
          parts.push(inlinePrompt);
        }
        if (opts.stdin) {
          const stdinText = (await readAllStdin()).trim();
          if (stdinText) {
            parts.push(stdinText);
          }
        }
        const prompt = parts.join("\n\n").trim();
        if (!prompt) {
          throw new Error("prompt is required (pass text or use --stdin)");
        }
        const wantsJsonOutput = ctx.globals.json || ctx.globals.output === "json";
        const streamJsonl = !!opts.jsonl || (!!opts.stream && wantsJsonOutput);
        const streamHuman = !streamJsonl && (!!opts.stream || !!ctx.globals.verbose);
        const config = buildCodexSessionConfig({
          model: opts.model,
          reasoning: opts.reasoning,
          sessionMode: opts.sessionMode,
          workdir: opts.workdir,
        });
        const result = await workspaceCodexExecData({
          ctx,
          workspaceIdentifier: opts.workspace,
          prompt,
          sessionId: opts.sessionId,
          config,
          onMessage: (message) => {
            if (streamJsonl) {
              process.stdout.write(`${JSON.stringify(message)}\n`);
            } else if (streamHuman) {
              streamCodexHumanMessage(message);
            }
          },
        });
        if (opts.jsonl) {
          return null;
        }
        if (ctx.globals.json || ctx.globals.output === "json") {
          return result;
        }
        return result.final_response;
      });
    },
  );

const codexAuth = codex.command("auth").description("workspace codex authentication");

codexAuth
  .command("status")
  .description("show effective codex auth/payment source status for a workspace")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace codex auth status", async (ctx) => {
      return await workspaceCodexAuthStatusData({
        ctx,
        workspaceIdentifier: opts.workspace,
      });
    });
  });

const codexAuthSubscription = codexAuth
  .command("subscription")
  .description("manage ChatGPT subscription auth for codex");

codexAuthSubscription
  .command("login")
  .description("start device auth login flow (waits for completion by default)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--no-wait", "return immediately after starting the login flow")
  .option("--poll-ms <duration>", "poll interval while waiting", "1500ms")
  .action(
    async (
      opts: { workspace?: string; wait?: boolean; pollMs?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth subscription login", async (ctx) => {
        const pollMs = Math.max(200, durationToMs(opts.pollMs, 1_500));
        return await workspaceCodexDeviceAuthStartData({
          ctx,
          workspaceIdentifier: opts.workspace,
          wait: opts.wait !== false,
          pollMs,
        });
      });
    },
  );

codexAuthSubscription
  .command("status")
  .description("check a subscription device-auth login session")
  .requiredOption("--id <id>", "device auth session id")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(
    async (
      opts: { id: string; workspace?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth subscription status", async (ctx) => {
        return await workspaceCodexDeviceAuthStatusData({
          ctx,
          workspaceIdentifier: opts.workspace,
          id: opts.id,
        });
      });
    },
  );

codexAuthSubscription
  .command("cancel")
  .description("cancel a pending subscription device-auth login session")
  .requiredOption("--id <id>", "device auth session id")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(
    async (
      opts: { id: string; workspace?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth subscription cancel", async (ctx) => {
        return await workspaceCodexDeviceAuthCancelData({
          ctx,
          workspaceIdentifier: opts.workspace,
          id: opts.id,
        });
      });
    },
  );

codexAuthSubscription
  .command("upload <authJsonPath>")
  .description("upload an auth.json file for subscription auth")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(
    async (
      authJsonPath: string,
      opts: { workspace?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth subscription upload", async (ctx) => {
        return await workspaceCodexAuthUploadFileData({
          ctx,
          workspaceIdentifier: opts.workspace,
          localPath: authJsonPath,
        });
      });
    },
  );

const codexAuthApiKey = codexAuth
  .command("api-key")
  .description("manage OpenAI API keys used for codex auth");

codexAuthApiKey
  .command("status")
  .description("show OpenAI API key status for account and workspace")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace codex auth api-key status", async (ctx) => {
      const workspace = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      const status = await ctx.hub.system.getOpenAiApiKeyStatus({
        project_id: workspace.project_id,
      });
      return {
        workspace_id: workspace.project_id,
        workspace_title: workspace.title,
        account_api_key_configured: !!status?.account,
        account_api_key_updated: toIso(status?.account?.updated),
        account_api_key_last_used: toIso(status?.account?.last_used),
        workspace_api_key_configured: !!status?.project,
        workspace_api_key_updated: toIso(status?.project?.updated),
        workspace_api_key_last_used: toIso(status?.project?.last_used),
      };
    });
  });

codexAuthApiKey
  .command("set")
  .description("set an OpenAI API key for workspace (default) or account scope")
  .requiredOption("--api-key <key>", "OpenAI API key")
  .option("--scope <scope>", "workspace|account", "workspace")
  .option("-w, --workspace <workspace>", "workspace id or name (for workspace scope)")
  .action(
    async (
      opts: {
        apiKey: string;
        scope?: string;
        workspace?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth api-key set", async (ctx) => {
        const scope = `${opts.scope ?? "workspace"}`.trim().toLowerCase();
        const apiKey = `${opts.apiKey ?? ""}`.trim();
        if (!apiKey) {
          throw new Error("--api-key must be non-empty");
        }
        if (scope !== "workspace" && scope !== "account") {
          throw new Error("scope must be 'workspace' or 'account'");
        }
        if (scope === "workspace") {
          const workspace = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
          const result = await ctx.hub.system.setOpenAiApiKey({
            project_id: workspace.project_id,
            api_key: apiKey,
          });
          return {
            scope,
            workspace_id: workspace.project_id,
            workspace_title: workspace.title,
            credential_id: result.id,
            created: result.created,
            status: "saved",
          };
        }
        const result = await ctx.hub.system.setOpenAiApiKey({
          api_key: apiKey,
        });
        return {
          scope,
          credential_id: result.id,
          created: result.created,
          status: "saved",
        };
      });
    },
  );

codexAuthApiKey
  .command("delete")
  .description("delete OpenAI API key at workspace (default) or account scope")
  .option("--scope <scope>", "workspace|account", "workspace")
  .option("-w, --workspace <workspace>", "workspace id or name (for workspace scope)")
  .action(
    async (
      opts: { scope?: string; workspace?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth api-key delete", async (ctx) => {
        const scope = `${opts.scope ?? "workspace"}`.trim().toLowerCase();
        if (scope !== "workspace" && scope !== "account") {
          throw new Error("scope must be 'workspace' or 'account'");
        }
        if (scope === "workspace") {
          const workspace = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
          const result = await ctx.hub.system.deleteOpenAiApiKey({
            project_id: workspace.project_id,
          });
          return {
            scope,
            workspace_id: workspace.project_id,
            workspace_title: workspace.title,
            revoked: result.revoked,
          };
        }
        const result = await ctx.hub.system.deleteOpenAiApiKey({});
        return {
          scope,
          revoked: result.revoked,
        };
      });
    },
  );

}
