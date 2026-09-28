import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { ConversationSearch } from "../chat/conversation-search/search";
import { personalAgentApi } from "./api";
import type { AgentSearchHit } from "./search-runner";
import { agentSearchTarget } from "./search-target";

export function AgentSearch({
  accountId,
  agents,
  activity,
  available,
  onSelect,
  active,
}: {
  accountId: string;
  agents: NamedAgent[];
  activity: Record<string, number>;
  available: (agent: NamedAgent) => boolean;
  onSelect: (result: AgentSearchHit) => Promise<void>;
  active: boolean;
}) {
  const byId = new Map(agents.map((agent) => [agent.endpoint.agent_id, agent]));
  return (
    <ConversationSearch
      accountId={accountId}
      scope="agent"
      active={active}
      projects={[
        ...new Map(
          agents.map((a) => [
            a.endpoint.project_id,
            {
              value: a.endpoint.project_id,
              label: a.project_title || "Untitled project",
            },
          ]),
        ).values(),
      ]}
      loadTargets={async ({ projectId }) => ({
        targets: agents
          .filter((a) => !projectId || a.endpoint.project_id === projectId)
          .map((a) => agentSearchTarget(a, activity[a.endpoint.agent_id])),
      })}
      available={(target) => {
        const agent = byId.get(target.id);
        return !!agent && available(agent);
      }}
      history={async (target) =>
        (
          await personalAgentApi().getIdentity({
            project_id: target.project_id,
            agent_id: target.id,
          })
        ).conversation_history?.map((h) => h.thread_id) ?? []
      }
      onSelect={async ({ target, ...result }) => {
        const agent = byId.get(target.id);
        if (!agent)
          throw Error("This agent is no longer available. Search again.");
        await onSelect({ ...result, agent });
      }}
    />
  );
}
