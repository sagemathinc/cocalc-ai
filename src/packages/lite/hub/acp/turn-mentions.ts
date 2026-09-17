import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import type { AgentApi } from "@cocalc/conat/hub/api/agent";
import {
  agentMentionReferenceMap,
  extractAgentMentions,
} from "@cocalc/util/agent-mentions";

export async function resolveHumanTurnMentions(
  request: AcpRequest,
  api: Pick<AgentApi, "getMentionIdentity">,
) {
  // Never bind history, scheduled/model-authored content, or an old turn's map.
  if (request.chat?.agent_message || request.chat?.automation_id) return [];
  const text = request.chat?.user_message_content ?? "";
  const references = Object.values(
    agentMentionReferenceMap(extractAgentMentions(text)),
  );
  if (references.length > 32)
    throw new Error("Too many bound agent references");
  for (const reference of references) {
    // Validate copied references under the submitting human, not the naming
    // account embedded in the markup. Exact owner routing starts no target.
    const identity = await api.getMentionIdentity({
      account_id: request.account_id,
      project_id: request.chat?.project_id ?? request.project_id!,
      target: reference.target,
    });
    if (
      identity.disabled_at ||
      identity.agent_id !== reference.target.agent_id ||
      identity.project_id !== reference.target.project_id
    ) {
      throw new Error(`Agent reference @${reference.name} is unavailable`);
    }
  }
  return references;
}
