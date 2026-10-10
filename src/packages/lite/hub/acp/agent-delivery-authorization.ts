import { createHash } from "node:crypto";
import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";

export async function authorizeAgentDeliveryExecution(
  request: AcpRequest,
  api: Pick<AgentApi, "authorizeRpcExecution" | "authorizeSensorExecution">,
): Promise<void> {
  const chat = request.chat;
  if (chat?.sensor_wake) {
    // The prompt CoCalc built for the wake, optionally after the queue's own
    // one-line note; the hub checks it against the wake's one-time permit.
    const content = chat.user_message_content;
    const prompt = request.prompt ?? "";
    if (
      typeof content !== "string" ||
      !(
        prompt === content ||
        (prompt.startsWith("System note: ") &&
          prompt.endsWith(content) &&
          prompt.slice(0, prompt.length - content.length).split("\n").length ===
            3)
      )
    )
      throw new Error("sensor wake prompt does not match its authorization");
    await api.authorizeSensorExecution({
      account_id: request.account_id,
      authorization: chat.sensor_wake,
      delivery: {
        prompt_sha256: createHash("sha256").update(content).digest("hex"),
        path: chat.path,
        thread_id: `${chat.thread_id ?? ""}`,
      },
    });
    // Consumed: nothing downstream (writers, leases, logs) needs the secret.
    chat.sensor_wake = { ...chat.sensor_wake, permit: REDACTED };
    return;
  }
  if (chat?.agent_rpc_execution) {
    await api.authorizeRpcExecution({
      account_id: chat.agent_rpc_execution.principal_account_id,
      authorization: chat.agent_rpc_execution,
    });
    return;
  }
  if (!chat?.agent_delivery_id) return;
  // Old queued work must not acquire the new RPC execution semantics, even
  // during a mixed-version rollout with a hub that still supports V1.
  throw new Error(
    "Legacy agent delivery is retired; this queued request was not executed",
  );
}

const REDACTED = "[redacted]";

/** A chat context safe to log: a sensor wake's permit is a secret. */
export function redactChatForLog<T extends AcpRequest["chat"]>(chat: T): T {
  if (!chat?.sensor_wake) return chat;
  return { ...chat, sensor_wake: { ...chat.sensor_wake, permit: REDACTED } };
}
