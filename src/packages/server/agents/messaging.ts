import { acceptAgentRpc } from "./rpc";
import type { Client } from "@cocalc/conat/core/client";
import {
  agentInboxPrefix,
  parseAgentMessagingSubject,
  validateAgentMessage,
  validateAgentInspection,
  type AgentInspectionRequest,
  type AgentInspectionResult,
  type AgentMessageRequest,
  type AgentMessageReceipt,
} from "@cocalc/conat/agents/protocol";
import getLogger from "@cocalc/backend/logger";
import { agentStore, agentMessagingEnabled } from "./store";
import { assertAgent, assertRun } from "./access";
import { ownMessageReceipts } from "./inspection";
import { personalMessagingEnabled } from "./personal";

const logger = getLogger("agents:messaging");
function receipt(
  row: AgentMessageReceipt & {
    execution_receipt?: AgentMessageReceipt["execution"];
  },
): AgentMessageReceipt {
  return {
    message_id: row.message_id,
    request_id: row.request_id,
    target_agent_id: row.target_agent_id,
    state: row.state,
    ...(row.execution_receipt ? { execution: row.execution_receipt } : {}),
  };
}

export function acceptAgentMessage(
  subject: string,
  request: AgentMessageRequest,
): Promise<AgentMessageReceipt>;
export function acceptAgentMessage(
  subject: string,
  request: AgentInspectionRequest,
): Promise<AgentInspectionResult>;
export async function acceptAgentMessage(
  subject: string,
  request: AgentMessageRequest | AgentInspectionRequest,
): Promise<AgentMessageReceipt | AgentInspectionResult> {
  if (request?.action === "send")
    throw new Error(
      "Legacy delivery is retired; use --rpc with an approved RPC link",
    );
  if (request?.action === "receipt") validateAgentMessage(request);
  else validateAgentInspection(request);
  const { agent_id, run_id } = parseAgentMessagingSubject(subject);
  const db = agentStore();
  const run = await db.activeRun(agent_id, run_id);
  await assertRun(run);
  const source = await db.get(agent_id);
  await assertAgent(source);
  if (request.action === "whoami")
    return {
      identity: source,
      run_id,
      protocol_version: 1,
      capabilities: ["whoami", "receipt", "messages"],
    };
  if (request.action === "destinations")
    throw new Error(
      "Legacy destinations are retired; use agent rpc destinations",
    );
  if (
    personalMessagingEnabled() &&
    (request.action === "messages" || request.action === "receipt")
  )
    throw new Error(
      "Legacy shared receipts are not available to personal runs; use RPC inspect",
    );
  if (request.action === "messages")
    return ownMessageReceipts(agent_id, request);
  if (request.action === "receipt") {
    const row = (
      await db.query(
        "SELECT * FROM agent_message_inbox WHERE source_agent_id=$1 AND request_id=$2",
        [agent_id, request.request_id],
      )
    ).rows[0];
    if (!row) throw new Error("receipt not found");
    return receipt(row);
  }
  throw new Error(
    "Legacy delivery is retired; use an explicitly approved RPC link and --rpc",
  );
}

export async function startAgentMessaging(
  client: Client,
): Promise<() => Promise<void>> {
  if (!agentMessagingEnabled()) return async () => {};
  const subscription = await client.subscribe("agent-messaging.*.*", {
    queue: "agent-messaging-v1",
    // This subject currently accepts metadata/text only, never file bytes.
    receiveLimits: {
      maxMessageBytes: 64 * 1024,
      maxInflightBytes: 2 * 1024 * 1024,
      maxInflightMessages: 32,
    },
    maxQueue: 32,
  });
  let closed = false;
  const activeRpc = new Set<Promise<void>>();
  const requests = (async () => {
    for await (const message of subscription) {
      if (closed) break;
      try {
        const { agent_id, run_id } = parseAgentMessagingSubject(
          message.subject,
        );
        const reply = message.headers?.["CN-Reply"];
        if (
          typeof reply !== "string" ||
          !reply.startsWith(`${agentInboxPrefix(agent_id, run_id)}.`)
        )
          continue;
        const request = message.data;
        if (request?.version === 2) {
          if (activeRpc.size >= 32) {
            await message.respond({
              error: "agent RPC admission capacity reached",
            });
            continue;
          }
          const task = (async () => {
            try {
              await message.respond({
                result: await acceptAgentRpc(message.subject, request),
              });
            } catch (error) {
              await message
                .respond({
                  error:
                    error instanceof Error &&
                    /^(approval_required|grant_expired|grant_paused|grant_revoked|principal_mismatch|connection_request_[a-z_]+)$/.test(
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
    subscription.close();
    await requests;
    await Promise.allSettled(activeRpc);
  };
}
