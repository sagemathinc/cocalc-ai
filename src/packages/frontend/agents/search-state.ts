import { conversationSearchStore } from "../chat/conversation-search/state";

export function agentSearchStore(account: string) {
  return conversationSearchStore(account, "agent");
}
