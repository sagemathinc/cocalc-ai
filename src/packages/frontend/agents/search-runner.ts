import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { ChatStoreSearchHit } from "@cocalc/conat/hub/api/projects";
import {
  runConversationSearch,
  type ConversationSearchProgress,
} from "../chat/conversation-search/runner";
import { agentSearchTarget } from "./search-target";
export { boundedProjectSearch } from "../chat/conversation-search/runner";

export interface AgentSearchHit {
  catalogEntryId?: string;
  agent: NamedAgent;
  threadId: string;
  historical: boolean;
  hit: ChatStoreSearchHit;
}
export interface AgentSearchProgress extends Omit<
  ConversationSearchProgress,
  "hits"
> {
  hits: AgentSearchHit[];
}

// Compatibility adapter for agent-specific consumers. Scheduling and limits
// live in the same runner used by human conversations.
export async function runAgentSearch(options: {
  agents: NamedAgent[];
  query: string;
  includePast: boolean;
  available: (agent: NamedAgent) => boolean;
  search: (
    agent: NamedAgent,
    threadId: string,
    query: string,
  ) => Promise<ChatStoreSearchHit[]>;
  history: (agent: NamedAgent) => Promise<string[]>;
  report: (progress: AgentSearchProgress) => void;
  canceled: () => boolean;
  now?: () => number;
  budgetMs?: number;
}): Promise<AgentSearchProgress> {
  const agents = new Map(options.agents.map((a) => [a.endpoint.agent_id, a]));
  const convert = (
    progress: ConversationSearchProgress,
  ): AgentSearchProgress => ({
    ...progress,
    hits: progress.hits.map(({ target, ...hit }) => ({
      ...hit,
      agent: agents.get(target.id)!,
    })),
  });
  return convert(
    await runConversationSearch({
      ...options,
      targets: options.agents.map((a) => agentSearchTarget(a)),
      available: (target) => options.available(agents.get(target.id)!),
      history: (target) => options.history(agents.get(target.id)!),
      search: (target, threadId, query) =>
        options.search(agents.get(target.id)!, threadId, query),
      report: (progress) => options.report(convert(progress)),
    }),
  );
}
