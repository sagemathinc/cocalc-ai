import type { Command } from "commander";
import type { ProjectCommandDeps } from "../project";
import { sendIdentityMessage } from "../../core/agent-message";
import { randomUUID } from "node:crypto";
import { resolveRuntimeAgentName } from "../../core/agent-destination";
import { validateAgentEndpoint } from "@cocalc/conat/agents/rpc";

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
  const rpc = agent
    .command("rpc")
    .description("V2 single-attempt messaging; separate from legacy delivery");
  agent
    .command("destinations")
    .description(
      "discover destinations approved for this turn's human principal",
    )
    .action(async (_opts, cmd) => {
      const globals = globalsFrom(cmd);
      emitSuccess(
        { globals },
        "project chat agent destinations",
        await sendIdentityMessage(
          { version: 2, action: "destinations" },
          globals.api,
        ),
      );
    });
  agent
    .command("request-connection")
    .description(
      "request typed human approval; does not grant permission or send a message",
    )
    .option("--to <name>", "exact approved name or selected @mention")
    .option(
      "--to-agent <uuid>",
      "previously resolved target identity, requires --target-project",
    )
    .option("--target-project <uuid>", "previously resolved target project")
    .requiredOption("--reason <reason>", "why this connection is needed")
    .option(
      "--request-id <uuid>",
      "stable request id for subsequent inspection",
    )
    .option(
      "--ttl-seconds <seconds>",
      "duration, default one day, maximum 30 days",
    )
    .option("--never-expires", "request no expiry")
    .option("--both-directions", "request communication in both directions")
    .option(
      "--wait-seconds <seconds>",
      "wait for the human decision using read-only inspection; 0 returns immediately, maximum 900",
      "120",
    )
    .action(async (opts, cmd) => {
      if (opts.neverExpires && opts.ttlSeconds !== undefined)
        throw new Error("Choose --never-expires or --ttl-seconds, not both");
      const waitSeconds = Number(opts.waitSeconds);
      if (
        !Number.isInteger(waitSeconds) ||
        waitSeconds < 0 ||
        waitSeconds > 900
      )
        throw new Error("--wait-seconds must be an integer from 0 to 900");
      const globals = globalsFrom(cmd);
      if (
        (opts.to && (opts.toAgent || opts.targetProject)) ||
        (!opts.to && (!opts.toAgent || !opts.targetProject))
      )
        throw new Error(
          "Choose --to NAME or both --to-agent and --target-project",
        );
      const target = opts.to
        ? await resolveRuntimeAgentName(opts.to, globals.api)
        : { agent_id: opts.toAgent, project_id: opts.targetProject };
      validateAgentEndpoint(target);
      const request_id = opts.requestId ?? randomUUID();
      process.stderr.write(
        `Connection approval request ${request_id}; no message is sent.\n`,
      );
      let result = await sendIdentityMessage(
        {
          version: 2,
          action: "request-connection",
          request_id,
          target,
          reason: opts.reason,
          ttl_seconds: opts.neverExpires
            ? null
            : Number(opts.ttlSeconds ?? 86400),
          both_directions: opts.bothDirections === true,
        },
        globals.api,
      );
      const deadline = Date.now() + waitSeconds * 1000;
      while (result.state === "pending" && Date.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2000, deadline - Date.now())),
        );
        if (Date.now() >= deadline) break;
        result = await sendIdentityMessage(
          {
            version: 2,
            action: "connection-request",
            request_id: result.request_id,
          },
          globals.api,
        );
      }
      emitSuccess({ globals }, "project chat agent request-connection", result);
    });
  agent
    .command("connection-request <request-id>")
    .description(
      "inspect a typed approval request; never starts work or replays a message",
    )
    .action(async (request_id, _opts, cmd) => {
      const globals = globalsFrom(cmd);
      emitSuccess(
        { globals },
        "project chat agent connection-request",
        await sendIdentityMessage(
          { version: 2, action: "connection-request", request_id },
          globals.api,
        ),
      );
    });
  rpc.command("destinations").action(async (_opts, cmd) => {
    const globals = globalsFrom(cmd);
    emitSuccess(
      { globals },
      "project chat agent rpc destinations",
      await sendIdentityMessage(
        { version: 2, action: "destinations" },
        globals.api,
      ),
    );
  });
  rpc
    .command("inspect <attempt-id>")
    .requiredOption("--to-agent <id>", "target from the original receipt")
    .requiredOption(
      "--target-project <id>",
      "target project from the original receipt; no bay routing needed",
    )
    .action(async (attempt_id, opts, cmd) => {
      const globals = globalsFrom(cmd);
      emitSuccess(
        { globals },
        "project chat agent rpc inspect",
        await sendIdentityMessage(
          {
            version: 2,
            action: "inspect",
            attempt_id,
            target: { project_id: opts.targetProject, agent_id: opts.toAgent },
          },
          globals.api,
        ),
      );
    });
  rpc
    .command("link <source-agent-id> <target-agent-id>")
    .requiredOption("--source-project <id>", "source project")
    .requiredOption("--target-project <id>", "target project")
    .requiredOption("--reason <reason>", "human approval reason")
    .option("--ttl-seconds <seconds>", "expiry, maximum 30 days", "86400")
    .option("--allow-guidance", "permit explicit guidance")
    .action(async (source, target, opts, cmd) =>
      withContext(cmd, "project chat agent rpc link", (ctx) =>
        ctx.hub.agent.grantRpcLink({
          source: { project_id: opts.sourceProject, agent_id: source },
          target: { project_id: opts.targetProject, agent_id: target },
          link_id: randomUUID(),
          ttl_seconds: Number(opts.ttlSeconds),
          reason: opts.reason,
          allow_guidance: opts.allowGuidance === true,
        }),
      ),
    );
  rpc
    .command("revoke <link-id>")
    .requiredOption("--source-agent <id>", "source agent")
    .requiredOption("--source-project <id>", "source project")
    .action(async (link_id, opts, cmd) =>
      withContext(cmd, "project chat agent rpc revoke", (ctx) =>
        ctx.hub.agent.revokeRpcLink({
          link_id,
          source: {
            project_id: opts.sourceProject,
            agent_id: opts.sourceAgent,
          },
        }),
      ),
    );
  agent
    .command("whoami")
    .description(
      "inspect your runtime identity without account/project credential fallback",
    )
    .action(async (_opts, cmd) => {
      const globals = globalsFrom(cmd);
      emitSuccess(
        { globals },
        "project chat agent whoami",
        await sendIdentityMessage({ action: "whoami" }, globals.api),
      );
    });
  agent
    .command("links <agent-id>")
    .description("inspect retired V1 links only; new links use agent rpc link")
    .option(
      "-w, --project <project>",
      "endpoint project id or name for owning-bay routing (otherwise local bay)",
    )
    .option("--limit <count>", "page size, 1 to 100", "20")
    .option("--cursor <uuid>", "continuation cursor from the previous page")
    .action(async (agent_id, opts, cmd) =>
      withContext(cmd, "project chat agent links", async (ctx) => {
        const project =
          opts.project === undefined
            ? undefined
            : await resolveProjectFromArgOrContext(ctx, opts.project);
        return ctx.hub.agent.listGrants({
          agent_id,
          project_id: project?.project_id,
          limit: Number(opts.limit),
          cursor: opts.cursor,
        });
      }),
    );
  agent
    .command("receipts <agent-id>")
    .description("inspect retired V1 receipts without resuming delivery")
    .option(
      "-w, --project <project>",
      "endpoint project id or name for owning-bay routing (otherwise local bay)",
    )
    .option("--limit <count>", "page size, 1 to 100", "20")
    .option("--cursor <uuid>", "continuation cursor from the previous page")
    .action(async (agent_id, opts, cmd) =>
      withContext(cmd, "project chat agent receipts", async (ctx) => {
        const project =
          opts.project === undefined
            ? undefined
            : await resolveProjectFromArgOrContext(ctx, opts.project);
        return ctx.hub.agent.listMessageReceipts({
          agent_id,
          project_id: project?.project_id,
          limit: Number(opts.limit),
          cursor: opts.cursor,
        });
      }),
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
