import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type {
  AgentNetworkDiscovery,
  AgentNetworkMemberLocator,
} from "@cocalc/conat/agents/personal";
import type { AgentRpcTarget } from "@cocalc/conat/agents/rpc";
import type { ProjectCommandDeps } from "../project";
import { sendIdentityMessage } from "../../core/agent-message";
import { sendExternalAgentMessage } from "../../core/external-agent-message";

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
    .description("registered agent identities and two-way Agent Networks");
  const rpc = agent
    .command("rpc")
    .description("network-authorized agent messaging protocol v3");

  const stdin = async () => {
    let value = "";
    for await (const chunk of process.stdin) value += chunk;
    return value;
  };

  const destinations = async (
    opts,
    cmd,
    label: string,
    includeInternalIds = false,
  ) => {
    const globals = globalsFrom(cmd);
    const result = (
      opts.externalAgent
        ? await sendExternalAgentMessage(opts.externalAgent, {
            version: 3,
            action: "destinations",
          })
        : await sendIdentityMessage(
            { version: 3, action: "destinations" },
            globals.api,
          )
    ) as AgentNetworkDiscovery;
    emitSuccess(
      { globals },
      label,
      includeInternalIds ? result : friendlyAgentDestinations(result),
    );
  };

  agent
    .command("destinations")
    .option("--external-agent <profile>", "use an enrolled external agent")
    .description("discover peers and Agent Networks available to this runtime")
    .action((opts, cmd) =>
      destinations(opts, cmd, "project chat agent destinations"),
    );
  rpc
    .command("destinations")
    .option("--external-agent <profile>", "use an enrolled external agent")
    .description("discover peers and exact network identifiers")
    .action((opts, cmd) =>
      destinations(opts, cmd, "project chat agent rpc destinations", true),
    );
  agent
    .command("inbox")
    .requiredOption(
      "--external-agent <profile>",
      "enrolled external-agent profile",
    )
    .option("--limit <count>", "maximum messages to return", "50")
    .description("list pending messages for an external network member")
    .action(async (opts, cmd) => {
      const globals = globalsFrom(cmd);
      const limit = Number(opts.limit);
      emitSuccess(
        { globals },
        "project chat agent inbox",
        await sendExternalAgentMessage(opts.externalAgent, {
          version: 3,
          action: "inbox",
          limit,
        }),
      );
    });
  agent
    .command("ack-inbox <message-id>")
    .requiredOption(
      "--external-agent <profile>",
      "enrolled external-agent profile",
    )
    .description("acknowledge one external-agent inbox message")
    .action(async (message_id, opts, cmd) => {
      const globals = globalsFrom(cmd);
      emitSuccess(
        { globals },
        "project chat agent ack-inbox",
        await sendExternalAgentMessage(opts.externalAgent, {
          version: 3,
          action: "ack-inbox",
          message_id,
        }),
      );
    });
  agent
    .command("propose-network")
    .requiredOption(
      "--members <json>",
      "JSON array of explicit registered/external member locators",
    )
    .option("--proposal-id <uuid>", "stable retry id")
    .option("--title <title>", "proposed title")
    .option("--delivery <mode>", "queued or live", "queued")
    .option("--reason <text>", "short human-facing reason")
    .option("--external-agent <profile>", "use an enrolled external agent")
    .description("propose a network for explicit human approval")
    .action(async (opts, cmd) => {
      const globals = globalsFrom(cmd);
      let members: AgentNetworkMemberLocator[];
      try {
        members = JSON.parse(opts.members);
      } catch {
        throw new Error("--members must be a JSON array");
      }
      const request = {
        version: 3 as const,
        action: "propose-network" as const,
        proposal_id: opts.proposalId ?? randomUUID(),
        title: opts.title,
        delivery_mode: opts.delivery,
        members,
        reason: opts.reason,
      };
      emitSuccess(
        { globals },
        "project chat agent propose-network",
        opts.externalAgent
          ? await sendExternalAgentMessage(opts.externalAgent, request)
          : await sendIdentityMessage(request, globals.api),
      );
    });
  agent
    .command("broadcast [message...]")
    .requiredOption("--agent-network <uuid>", "exact Agent Network")
    .requiredOption("--targets <json>", "JSON array of explicit targets")
    .option("--broadcast-id <uuid>", "stable parent retry id")
    .option("--stdin", "read the message from standard input")
    .option("--external-agent <profile>", "use an enrolled external agent")
    .description("send one bounded message to several network members")
    .action(async (message: string[], opts, cmd) => {
      if (opts.stdin && message.length)
        throw new Error("use either message arguments or --stdin, not both");
      const body = opts.stdin ? await stdin() : message.join(" ");
      let targets: AgentRpcTarget[];
      try {
        targets = JSON.parse(opts.targets);
      } catch {
        throw new Error("--targets must be a JSON array");
      }
      const request = {
        version: 3 as const,
        action: "broadcast" as const,
        broadcast_id: opts.broadcastId ?? randomUUID(),
        agent_network_id: opts.agentNetwork,
        targets,
        body,
      };
      const globals = globalsFrom(cmd);
      emitSuccess(
        { globals },
        "project chat agent broadcast",
        opts.externalAgent
          ? await sendExternalAgentMessage(opts.externalAgent, request)
          : await sendIdentityMessage(request, globals.api),
      );
    });
  rpc
    .command("inspect <attempt-id>")
    .option("--external-agent <profile>", "use an enrolled external agent")
    .requiredOption("--agent-network <uuid>", "exact Agent Network")
    .requiredOption("--to-agent <uuid>", "target from the original outcome")
    .requiredOption("--target-project <uuid>", "target project")
    .description("inspect an exact attempt without retrying or starting work")
    .action(async (attempt_id, opts, cmd) => {
      const globals = globalsFrom(cmd);
      const request = {
        version: 3 as const,
        action: "inspect" as const,
        attempt_id,
        agent_network_id: opts.agentNetwork,
        target: { project_id: opts.targetProject, agent_id: opts.toAgent },
      };
      emitSuccess(
        { globals },
        "project chat agent rpc inspect",
        opts.externalAgent
          ? await sendExternalAgentMessage(opts.externalAgent, request)
          : await sendIdentityMessage(request, globals.api),
      );
    });
  agent
    .command("whoami")
    .description("inspect this runtime identity without credential fallback")
    .action(async (_opts, cmd) => {
      const globals = globalsFrom(cmd);
      emitSuccess(
        { globals },
        "project chat agent whoami",
        await sendIdentityMessage({ action: "whoami" }, globals.api),
      );
    });
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
}

export function friendlyAgentDestinations(directory: AgentNetworkDiscovery) {
  return {
    peers: directory.peers.map(({ member, networks }) => ({
      kind: member.kind,
      name: member.kind === "registered" ? member.name : member.label,
      ...(member.kind === "registered" && member.project_title
        ? { project: member.project_title }
        : {}),
      available: member.available,
      networks: networks.map(({ title, delivery_mode }) => ({
        title,
        delivery_mode,
      })),
    })),
  };
}
