import { acceptAgentRpc, acceptExternalAgentRpc } from "./rpc";
import {
  parseExternalAgentSubject,
  externalAgentInbox,
} from "@cocalc/conat/agents/external";
import type { Client } from "@cocalc/conat/core/client";
import {
  agentInboxPrefix,
  parseAgentMessagingSubject,
  validateAgentInspection,
  type AgentInspectionRequest,
  type AgentInspectionResult,
} from "@cocalc/conat/agents/protocol";
import getLogger from "@cocalc/backend/logger";
import { agentStore } from "./store";
import { assertAgent, assertRun } from "./access";
import { startAgentMessagingMaintenance } from "./maintenance";

const logger = getLogger("agents:messaging");
export function acceptAgentMessage(
  subject: string,
  request: AgentInspectionRequest,
): Promise<AgentInspectionResult>;
export async function acceptAgentMessage(
  subject: string,
  request: AgentInspectionRequest,
): Promise<AgentInspectionResult> {
  validateAgentInspection(request);
  const { agent_id, run_id } = parseAgentMessagingSubject(subject);
  const db = agentStore();
  const run = await db.activeRun(agent_id, run_id);
  await assertRun(run);
  const source = await db.get(agent_id);
  await assertAgent(source);
  return {
    identity: source,
    run_id,
    protocol_version: 3,
    capabilities: ["whoami"],
  };
}

export async function startAgentMessaging(
  client: Client,
  external = false,
): Promise<() => Promise<void>> {
  const binary = true;
  const stopExternal = !external
    ? await startAgentMessaging(client, true)
    : undefined;
  const stopMaintenance = !external
    ? startAgentMessagingMaintenance()
    : undefined;
  const subscription = await client.subscribe(
    external ? "agent-external.*.*" : "agent-messaging.*.*",
    {
      queue: "agent-messaging-v1",
      receiveLimits: binary
        ? {
            maxMessageBytes: 33 * 1024 * 1024,
            maxInflightBytes: 132 * 1024 * 1024,
            maxInflightMessages: 4,
            maxFragmentsPerMessage: 4096,
          }
        : {
            maxMessageBytes: 128 * 1024,
            maxInflightBytes: 4 * 1024 * 1024,
            maxInflightMessages: 32,
          },
      maxQueue: binary ? 4 : 32,
    },
  );
  let closed = false;
  const activeRpc = new Set<Promise<void>>();
  const requests = (async () => {
    for await (const message of subscription) {
      if (closed) break;
      try {
        const replyPrefix = external
          ? (() => {
              const { account_id, installation_id } = parseExternalAgentSubject(
                message.subject,
              );
              return externalAgentInbox(account_id, installation_id);
            })()
          : (() => {
              const { agent_id, run_id } = parseAgentMessagingSubject(
                message.subject,
              );
              return agentInboxPrefix(agent_id, run_id);
            })();
        const reply = message.headers?.["CN-Reply"];
        if (typeof reply !== "string" || !reply.startsWith(`${replyPrefix}.`))
          continue;
        const request = message.data;
        if (request?.version === 3) {
          if (activeRpc.size >= (binary ? 4 : 32)) {
            await message.respond({
              error: "agent RPC admission capacity reached",
            });
            continue;
          }
          const task = (async () => {
            try {
              await message.respond({
                result: await (
                  external ? acceptExternalAgentRpc : acceptAgentRpc
                )(message.subject, request),
              });
            } catch (error) {
              await message
                .respond({
                  error:
                    error instanceof Error &&
                    /^(approval_required|network_paused|network_closed|network_stale|not_a_member|principal_mismatch|account_disabled|agent_unavailable)$/.test(
                      error.message,
                    )
                      ? error.message
                      : "agent RPC unavailable or unauthorized",
                })
                .catch(() => undefined);
            }
          })();
          activeRpc.add(task);
          void task.finally(() => activeRpc.delete(task));
          continue;
        }
        if (external) throw new Error("external agents require RPC version 3");
        const result = await acceptAgentMessage(message.subject, request);
        await message.respond({ result });
      } catch (error) {
        await message
          .respond({
            error: error instanceof Error ? error.message : "message failed",
          })
          .catch(() => undefined);
      }
    }
    if (!closed) throw new Error("agent messaging subscription ended");
  })().catch(() => {
    logger.warn("agent messaging subscription ended");
    if (!closed) client.close();
  });
  return async () => {
    closed = true;
    stopMaintenance?.();
    subscription.close();
    await requests;
    await Promise.allSettled(activeRpc);
    await stopExternal?.();
  };
}
