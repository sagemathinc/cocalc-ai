/**
 * Project Codex integration commands.
 *
 * Provides remote codex execution and authentication/device-flow helpers that
 * run against project-hosted codex services.
 */
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";

export function registerProjectCodexCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    readAllStdin,
    buildCodexSessionConfig,
    projectCodexExecData,
    streamCodexHumanMessage,
    projectCodexAuthStatusData,
    durationToMs,
    projectCodexDeviceAuthStartData,
    projectCodexDeviceAuthStatusData,
    projectCodexDeviceAuthCancelData,
    projectCodexAuthUploadFileData,
    resolveProjectFromArgOrContext,
    toIso,
  } = deps;

const codex = project.command("codex").description("project codex operations");

codex
  .command("exec [prompt...]")
  .description("run a codex turn in a project using project-host containerized codex exec")
  .option("-w, --project <project>", "project id or name")
  .option("--stdin", "append stdin to prompt text")
  .option("--stream", "stream codex progress to stderr while running")
  .option("--jsonl", "emit raw codex stream messages as JSONL on stdout")
  .option("--session-id <id>", "reuse an existing codex session id")
  .option("--model <model>", "codex model name")
  .option("--reasoning <level>", "reasoning level (low|medium|high|extra_high)")
  .option(
    "--session-mode <mode>",
    "session mode (auto|read-only|project-write|full-access)",
  )
  .option("--workdir <path>", "working directory inside project")
  .action(
    async (
      promptArgs: string[],
      opts: {
        project?: string;
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
      await withContext(command, "project codex exec", async (ctx) => {
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
        const result = await projectCodexExecData({
          ctx,
          projectIdentifier: opts.project,
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

const codexAuth = codex.command("auth").description("project codex authentication");

codexAuth
  .command("status")
  .description("show effective codex auth/payment source status for a project")
  .option("-w, --project <project>", "project id or name")
  .action(async (opts: { project?: string }, command: Command) => {
    await withContext(command, "project codex auth status", async (ctx) => {
      return await projectCodexAuthStatusData({
        ctx,
        projectIdentifier: opts.project,
      });
    });
  });

const codexAuthSubscription = codexAuth
  .command("subscription")
  .description("manage ChatGPT subscription auth for codex");

codexAuthSubscription
  .command("login")
  .description("start device auth login flow (waits for completion by default)")
  .option("-w, --project <project>", "project id or name")
  .option("--no-wait", "return immediately after starting the login flow")
  .option("--poll-ms <duration>", "poll interval while waiting", "1500ms")
  .action(
    async (
      opts: { project?: string; wait?: boolean; pollMs?: string },
      command: Command,
    ) => {
      await withContext(command, "project codex auth subscription login", async (ctx) => {
        const pollMs = Math.max(200, durationToMs(opts.pollMs, 1_500));
        return await projectCodexDeviceAuthStartData({
          ctx,
          projectIdentifier: opts.project,
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
  .option("-w, --project <project>", "project id or name")
  .action(
    async (
      opts: { id: string; project?: string },
      command: Command,
    ) => {
      await withContext(command, "project codex auth subscription status", async (ctx) => {
        return await projectCodexDeviceAuthStatusData({
          ctx,
          projectIdentifier: opts.project,
          id: opts.id,
        });
      });
    },
  );

codexAuthSubscription
  .command("cancel")
  .description("cancel a pending subscription device-auth login session")
  .requiredOption("--id <id>", "device auth session id")
  .option("-w, --project <project>", "project id or name")
  .action(
    async (
      opts: { id: string; project?: string },
      command: Command,
    ) => {
      await withContext(command, "project codex auth subscription cancel", async (ctx) => {
        return await projectCodexDeviceAuthCancelData({
          ctx,
          projectIdentifier: opts.project,
          id: opts.id,
        });
      });
    },
  );

codexAuthSubscription
  .command("upload <authJsonPath>")
  .description("upload an auth.json file for subscription auth")
  .option("-w, --project <project>", "project id or name")
  .action(
    async (
      authJsonPath: string,
      opts: { project?: string },
      command: Command,
    ) => {
      await withContext(command, "project codex auth subscription upload", async (ctx) => {
        return await projectCodexAuthUploadFileData({
          ctx,
          projectIdentifier: opts.project,
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
  .description("show OpenAI API key status for account and project")
  .option("-w, --project <project>", "project id or name")
  .action(async (opts: { project?: string }, command: Command) => {
    await withContext(command, "project codex auth api-key status", async (ctx) => {
      const project = await resolveProjectFromArgOrContext(ctx, opts.project);
      const status = await ctx.hub.system.getOpenAiApiKeyStatus({
        project_id: project.project_id,
      });
      return {
        project_id: project.project_id,
        project_title: project.title,
        account_api_key_configured: !!status?.account,
        account_api_key_updated: toIso(status?.account?.updated),
        account_api_key_last_used: toIso(status?.account?.last_used),
        project_api_key_configured: !!status?.project,
        project_api_key_updated: toIso(status?.project?.updated),
        project_api_key_last_used: toIso(status?.project?.last_used),
      };
    });
  });

codexAuthApiKey
  .command("set")
  .description("set an OpenAI API key for project (default) or account scope")
  .requiredOption("--api-key <key>", "OpenAI API key")
  .option("--scope <scope>", "project|account", "project")
  .option("-w, --project <project>", "project id or name (for project scope)")
  .action(
    async (
      opts: {
        apiKey: string;
        scope?: string;
        project?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "project codex auth api-key set", async (ctx) => {
        const scope = `${opts.scope ?? "project"}`.trim().toLowerCase();
        const apiKey = `${opts.apiKey ?? ""}`.trim();
        if (!apiKey) {
          throw new Error("--api-key must be non-empty");
        }
        if (scope !== "project" && scope !== "account") {
          throw new Error("scope must be 'project' or 'account'");
        }
        if (scope === "project") {
          const project = await resolveProjectFromArgOrContext(ctx, opts.project);
          const result = await ctx.hub.system.setOpenAiApiKey({
            project_id: project.project_id,
            api_key: apiKey,
          });
          return {
            scope,
            project_id: project.project_id,
            project_title: project.title,
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
  .description("delete OpenAI API key at project (default) or account scope")
  .option("--scope <scope>", "project|account", "project")
  .option("-w, --project <project>", "project id or name (for project scope)")
  .action(
    async (
      opts: { scope?: string; project?: string },
      command: Command,
    ) => {
      await withContext(command, "project codex auth api-key delete", async (ctx) => {
        const scope = `${opts.scope ?? "project"}`.trim().toLowerCase();
        if (scope !== "project" && scope !== "account") {
          throw new Error("scope must be 'project' or 'account'");
        }
        if (scope === "project") {
          const project = await resolveProjectFromArgOrContext(ctx, opts.project);
          const result = await ctx.hub.system.deleteOpenAiApiKey({
            project_id: project.project_id,
          });
          return {
            scope,
            project_id: project.project_id,
            project_title: project.title,
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
