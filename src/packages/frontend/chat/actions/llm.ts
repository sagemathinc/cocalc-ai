// Codex handling for chat actions.
// This frontend path is now Codex-only:
// - resolves whether a message should go to Codex,
// - normalizes regenerate input,
// - dispatches to the ACP/Codex backend path.

import track from "@cocalc/frontend/user-tracking";
import type { CodexThreadConfig } from "@cocalc/chat";
import { isCodexModelName } from "@cocalc/util/ai/codex";
import type { LanguageModel } from "@cocalc/util/db-schema/ai-models";
import type { History as LanguageModelHistory } from "@cocalc/frontend/client/types";
import { processAcpLLM } from "../acp-api";
import type { ChatActions } from "../actions";
import type { ChatMessage } from "../types";

export async function processLLM({
  actions,
  message,
  tag,
  llm,
  threadModel,
  dateLimit,
  acpSendMode,
  acpConfigOverride,
}: {
  actions: ChatActions;
  message: ChatMessage;
  tag?: string;
  llm?: LanguageModel;
  threadModel?: LanguageModel | false | null;
  dateLimit?: Date;
  acpSendMode?: "immediate";
  acpConfigOverride?: Partial<CodexThreadConfig>;
}): Promise<void> {
  const { syncdb, store } = actions;
  if (!syncdb || !store) return;

  const inputRaw = message.history?.[0]?.content as string | undefined;
  if (inputRaw == null) return;
  if (!inputRaw && tag !== "regenerate") return;

  const messageAcpSendMode =
    (message as any)?.acp_send_mode === "immediate" ? "immediate" : undefined;
  const effectiveAcpSendMode = acpSendMode ?? messageAcpSendMode;

  const model = resolveLLMModel({ message, tag, llm, threadModel });
  if (model === false || model == null) return;

  const threadIdForThread = (message as any)?.thread_id as string | undefined;
  if (threadIdForThread) {
    actions.recordThreadAgentModel(threadIdForThread, model);
  }

  let input = stripMentions(inputRaw);
  const regen = prepareRegenerateInput({
    tag,
    history: threadIdForThread
      ? actions.getLLMHistory(threadIdForThread)
      : undefined,
    dateLimit,
    threadId: threadIdForThread,
  });
  if (regen?.error) return;
  input = regen?.input ?? input;

  const acpPromptOverride = `${(message as any)?.acp_prompt ?? ""}`.trim();

  track("codex", {
    project_id: store.get("project_id"),
    path: store.get("path"),
    type: "chat",
    is_reply: `${(message as any)?.parent_message_id ?? ""}`.trim().length > 0,
    tag:
      !tag && `${(message as any)?.parent_message_id ?? ""}`.trim()
        ? "reply"
        : tag,
    model,
  });

  await processAcpLLM({
    actions,
    message,
    model,
    input: acpPromptOverride || input,
    sendMode: effectiveAcpSendMode,
    acpConfigOverride,
  });
}

function resolveLLMModel({
  message,
  tag,
  llm,
  threadModel,
}: {
  message: ChatMessage;
  tag?: string;
  llm?: LanguageModel;
  threadModel?: LanguageModel | false | null;
}): LanguageModel | false | null {
  if (typeof llm === "string") {
    if (tag !== "regenerate") {
      console.warn(`chat/llm: llm=${llm} is only allowed for tag=regenerate`);
      return null;
    }
    if (isCodexModelName(llm)) {
      return llm;
    }
    console.warn(`chat/llm: ignoring non-Codex regenerate model ${llm}`);
    return null;
  }

  const input = message.history?.[0]?.content ?? "";
  const mentioned = getLanguageModel(input);
  const mentionedAny = mentionsLanguageModel(input);

  if (mentionedAny && mentioned) return mentioned;
  if (mentionedAny && !mentioned) return null;

  if (typeof threadModel === "string" && isCodexModelName(threadModel)) {
    return threadModel;
  }
  return null;
}

function prepareRegenerateInput({
  tag,
  history,
  dateLimit,
  threadId,
}: {
  tag?: string;
  history?: LanguageModelHistory;
  dateLimit?: Date;
  threadId?: string;
}): { history?: LanguageModelHistory; input?: string; error?: boolean } | null {
  if (tag !== "regenerate") return null;
  if (!history || history.length < 2) {
    console.warn(
      `chat/llm: regenerate called without enough history for thread ${threadId ?? "unknown"}`,
    );
    return { error: true };
  }
  const h = [...history];
  h.pop();
  while (dateLimit != null && h.length >= 2) {
    const last = h[h.length - 1];
    if (last.date != null && last.date > dateLimit) {
      h.pop();
      h.pop();
    } else {
      break;
    }
  }
  const input = stripMentions(h.pop()?.content ?? "");
  return { history: h, input };
}

function stripMentions(value: string): string {
  if (!value) return "";
  for (const name of ["@codex"]) {
    while (true) {
      const i = value.toLowerCase().indexOf(name);
      if (i === -1) break;
      value = value.slice(0, i) + value.slice(i + name.length);
    }
  }
  while (true) {
    const i = value.indexOf('<span class="user-mention"');
    if (i === -1) break;
    const j = value.indexOf("</span>", i);
    if (j === -1) break;
    value = value.slice(0, i) + value.slice(j + "</span>".length);
  }
  return value.trim();
}

function mentionsLanguageModel(input?: string): boolean {
  const x = input?.toLowerCase() ?? "";
  return x.includes("openai-codex-agent") || x.includes("@codex");
}

function getLanguageModel(input?: string): false | LanguageModel {
  if (!input) return false;
  const x = input.toLowerCase();
  if (x.includes("openai-codex-agent") || x.includes("@codex")) {
    return "codex-agent";
  }
  return false;
}
