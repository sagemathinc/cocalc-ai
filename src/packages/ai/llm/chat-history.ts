import type { InMemoryChatMessageHistory } from "@langchain/core/chat_history";

import { History } from "@cocalc/util/types/llm";
import { numTokens } from "./chatgpt-numtokens";
import { importLangchain } from "./langchain-import";

// reconstruct the chat history from CoCalc's data
// TODO: must be robust for repeated messages from the same user and ending in an assistant message
export async function transformHistoryToMessages(
  history?: History,
): Promise<{ messageHistory: InMemoryChatMessageHistory; tokens: number }> {
  let tokens = 0;

  const { InMemoryChatMessageHistory } = await importLangchain(
    "@langchain/core/chat_history"
  );
  const { AIMessage, HumanMessage } = await importLangchain(
    "@langchain/core/messages"
  );

  const messageHistory = new InMemoryChatMessageHistory();
  if (history) {
    let nextRole: "model" | "user" = "user";
    for (const { content } of history) {
      tokens += numTokens(content);
      if (nextRole === "user") {
        await messageHistory.addMessage(new HumanMessage(content));
      } else {
        await messageHistory.addMessage(new AIMessage(content));
      }
      nextRole = nextRole === "user" ? "model" : "user";
    }
  }

  return { messageHistory, tokens };
}
