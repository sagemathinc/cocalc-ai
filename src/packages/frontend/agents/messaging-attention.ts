import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type { PersonalConnectionRequest } from "@cocalc/conat/agents/personal";
import { personalAgentApi } from "./api";

// This is a read-only view of account-home requests, not a second approval store.
export function messagingAttentionRecords(
  requests: PersonalConnectionRequest[],
  identities: AgentIdentity[],
  context: { account_id: string; project_id: string; path: string },
  now = Date.now(),
): AcpAttentionRecord[] {
  return requests.flatMap((request) => {
    if (
      request.account_id !== context.account_id ||
      request.source.project_id !== context.project_id ||
      request.state !== "pending"
    )
      return [];
    const expires_at = Date.parse(request.expires_at);
    if (!Number.isFinite(expires_at) || expires_at <= now) return [];
    const identity = identities.find(
      (identity) =>
        identity.agent_id === request.source.agent_id &&
        identity.project_id === context.project_id &&
        identity.path === context.path &&
        !identity.disabled_at,
    );
    if (!identity) return [];
    return [
      {
        attention_id: `agent-messaging:${request.request_id}`,
        project_id: context.project_id,
        account_id: context.account_id,
        path: identity.path,
        thread_id: identity.thread_id,
        source_kind: "cocalc_action" as const,
        source_id: `agent-messaging:${request.request_id}`,
        attention_kind: "approval" as const,
        is_blocking: false,
        title: "Agent requests messaging approval",
        summary:
          "Review this connection in CoCalc. Approval grants permission; it does not send a message.",
        questions: [],
        action: {
          kind: "agent_messaging" as const,
          reference: request.request_id,
          expires_at,
        },
        state: "pending" as const,
        created_at: Date.parse(request.created_at),
        updated_at: Date.parse(request.created_at),
        expires_at,
      },
    ];
  });
}

export async function loadMessagingAttention(context: {
  account_id: string;
  project_id: string;
  path: string;
}): Promise<AcpAttentionRecord[]> {
  const api = personalAgentApi();
  const result = await api.listPersonalConnectionRequests({});
  if (
    !result.enabled ||
    !result.requests.some(
      (request) =>
        request.source.project_id === context.project_id &&
        request.account_id === context.account_id &&
        request.state === "pending" &&
        Date.parse(request.expires_at) > Date.now(),
    )
  )
    return [];
  // Only metadata for this open project, never all named projects or chat syncdocs.
  const identities = await api.listIdentities({
    project_id: context.project_id,
  });
  return messagingAttentionRecords(result.requests, identities, context);
}
