import { createContext, useContext } from "react";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";

export const AgentMentionContext = createContext<{
  allowAgentMentions?: boolean;
  /** Offer agents (and people) only, not artifacts or computers: for text
   * whose other references would not be resolved, e.g. a question's answer. */
  agentsOnly?: boolean;
  postOnly?: boolean;
  source?: { projectId: string; path: string; threadId?: string };
  onSelect?: (reference: AgentMentionReference) => void;
  states?: Record<string, string>;
}>({});
export const useAgentMentionContext = () => useContext(AgentMentionContext);
