import type { Command } from "commander";
import type { ProjectCommandDeps } from "../project";
import { sendIdentityMessage } from "../../core/agent-message";

export function registerChatAgentCommands(
  chat: Command,
  deps: ProjectCommandDeps,
) {
  const {
    withContext,
    resolveProjectFromArgOrContext,
    emitSuccess,
    globalsFrom,
  } = deps;
  const agent = chat
    .command("agent")
    .description(
      "experimental registered agent identities and directional send-only links",
    );
  agent
    .command("register")
    .requiredOption("--path <path>", "chat path")
    .requiredOption("--thread-id <id>", "existing Codex thread")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts, cmd) =>
      withContext(cmd, "project chat agent register", async (ctx) => {
        const project = await resolveProjectFromArgOrContext(ctx, opts.project);
        return ctx.hub.agent.registerIdentity({
          project_id: project.project_id,
          path: opts.path,
          thread_id: opts.threadId,
        });
      }),
    );
  agent
    .command("list")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts, cmd) =>
      withContext(cmd, "project chat agent list", async (ctx) => {
        const project = await resolveProjectFromArgOrContext(ctx, opts.project);
        return ctx.hub.agent.listIdentities({ project_id: project.project_id });
      }),
    );
  agent
    .command("link <source-agent-id> <target-agent-id>")
    .requiredOption(
      "--ttl-seconds <seconds>",
      "link lifetime, 60 seconds to 30 days",
    )
    .requiredOption("--reason <reason>", "human approval reason")
    .option("--allow-guidance", "also permit steering a running turn")
    .action(async (source, target, opts, cmd) =>
      withContext(cmd, "project chat agent link", (ctx) =>
        ctx.hub.agent.grantMessaging({
          source_agent_id: source,
          target_agent_id: target,
          ttl_seconds: Number(opts.ttlSeconds),
          reason: opts.reason,
          allow_guidance: opts.allowGuidance === true,
        }),
      ),
    );
  agent
    .command("revoke <grant-id>")
    .action(async (grant_id, _opts, cmd) =>
      withContext(cmd, "project chat agent revoke", (ctx) =>
        ctx.hub.agent.revokeMessaging({ grant_id }),
      ),
    );
  agent
    .command("disable <agent-id>")
    .action(async (agent_id, _opts, cmd) =>
      withContext(cmd, "project chat agent disable", (ctx) =>
        ctx.hub.agent.disableIdentity({ agent_id }),
      ),
    );
  agent
    .command("receipt <request-id>")
    .description("read only the delivery state of your own message")
    .action(async (request_id, _opts, cmd) => {
      const globals = globalsFrom(cmd);
      const result = await sendIdentityMessage(
        { action: "receipt", request_id },
        globals.api,
      );
      emitSuccess({ globals }, "project chat agent receipt", result);
    });
}
