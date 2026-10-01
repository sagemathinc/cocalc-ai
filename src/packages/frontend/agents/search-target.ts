import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { ConversationSearchTarget } from "../chat/conversation-search/runner";

export function agentSearchTarget(
  agent: NamedAgent,
  activity?: number,
): ConversationSearchTarget {
  return {
    id: agent.endpoint.agent_id,
    project_id: agent.endpoint.project_id,
    path: agent.path,
    thread_id: agent.thread_id,
    title: `@${agent.name}`,
    project_title: agent.project_title,
    activity: activity || Date.parse(agent.updated_at) || 0,
  };
}
