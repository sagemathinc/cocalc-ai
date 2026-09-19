import { createContext, useContext } from "react";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";

export const AgentMentionContext = createContext<{
  allowAgentMentions?: boolean;
  onSelect?: (reference: AgentMentionReference) => void;
  states?: Record<string, string>;
}>({});
export const useAgentMentionContext = () => useContext(AgentMentionContext);
