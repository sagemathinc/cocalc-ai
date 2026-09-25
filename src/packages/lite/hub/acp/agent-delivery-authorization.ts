import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";

export async function authorizeAgentDeliveryExecution(
  request: AcpRequest,
  api: Pick<AgentApi, "authorizeRpcExecution">,
): Promise<void> {
  const chat = request.chat;
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
