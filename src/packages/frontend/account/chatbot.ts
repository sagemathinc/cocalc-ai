/*
Some chat/UI surfaces still use `account_id`-shaped strings for assistant
messages. The product is now Codex-only, so bot identity here is intentionally
limited to Codex agent ids and Codex model ids.
*/

import { isCodexModelName } from "@cocalc/util/ai/codex";

export function isChatBot(account_id?: string): boolean {
  return typeof account_id === "string" && isCodexModelName(account_id);
}

export function chatBotName(account_id?: string): string {
  if (typeof account_id !== "string") return "Codex Agent";
  if (isCodexModelName(account_id)) {
    if (account_id === "codex-agent" || account_id === "openai-codex-agent") {
      return "Codex Agent";
    }
    return `Codex Agent (${account_id})`;
  }
  return "Codex Agent";
}
