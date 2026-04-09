// LLM handling for chat actions.
// - Resolves which model to run (including Codex and @mentions).
// - Inserts “thinking” placeholder messages and streams tokens into the syncdoc.
// - Handles regenerate, Codex ACP turns, throttling, and error reporting.
// This file keeps the main actions.ts smaller; processLLM is the primary entry point.

import track from "@cocalc/frontend/user-tracking";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  CUSTOM_OPENAI_PREFIX,
  LANGUAGE_MODEL_PREFIXES,
  OLLAMA_PREFIX,
  USER_LLM_PREFIX,
  model2service,
  model2vendor,
  type LanguageModel,
} from "@cocalc/util/db-schema/llm-utils";
import {
  toOllamaModel,
  toCustomOpenAIModel,
} from "@cocalc/util/db-schema/llm-utils";
import { uuid } from "@cocalc/util/misc";
import { addToHistory } from "@cocalc/chat";
import { isCodexModelName } from "@cocalc/util/ai/codex";
import type { CodexThreadConfig } from "@cocalc/chat";
import type { ChatMessage, MessageHistory } from "../types";
import type { History as LanguageModelHistory } from "@cocalc/frontend/client/types";
import { processAcpLLM } from "../acp-api";
import { type ChatActions } from "../actions";

const MAX_CHAT_STREAM = 10;

function findChatRecord({
  actions,
  syncdb,
  messageId,
  dateIso,
  senderId,
}: {
  actions: ChatActions;
  syncdb: any;
  messageId?: string;
  dateIso?: string;
  senderId?: string;
}): any {
  if (messageId) {
    const cached = actions.getMessageById(messageId);
    if (cached) return cached;
    const byId = syncdb?.get_one?.({
      event: "chat",
      message_id: messageId,
    });
    if (byId) return byId;
  }
  if (!dateIso || !senderId) return undefined;
  return syncdb.get_one({
    event: "chat",
    date: dateIso,
    sender_id: senderId,
  });
}

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
  const acpPromptOverride = `${(message as any)?.acp_prompt ?? ""}`.trim();

  // ACP agent branch
  if (typeof model === "string" && isCodexModelName(model)) {
    await processAcpLLM({
      actions,
      message,
      model,
      input: acpPromptOverride || input,
      sendMode: effectiveAcpSendMode,
      acpConfigOverride,
    });
    return;
  }

  const sender_id = modelToSender(model);
  const { date, prevHistory } = ensureThinkingMessage({
    actions,
    message,
    tag,
    sender_id,
  });

  if (actions.chatStreams.size > MAX_CHAT_STREAM) {
    throttleWarning({ actions, date, sender_id });
    return;
  }

  const project_id = store.get("project_id");
  const path = store.get("path");
  const effectiveTag =
    !tag && `${(message as any)?.parent_message_id ?? ""}`.trim()
      ? "reply"
      : tag;

  track("chatgpt", {
    project_id,
    path,
    type: "chat",
    is_reply: `${(message as any)?.parent_message_id ?? ""}`.trim().length > 0,
    tag: effectiveTag,
    model,
  });

  const id = uuid();
  actions.chatStreams.add(id);
  setTimeout(() => actions.chatStreams.delete(id), 3 * 60 * 1000);

  let history = threadIdForThread
    ? actions.getLLMHistory(threadIdForThread)
    : undefined;
  const regen = prepareRegenerateInput({
    tag,
    history,
    dateLimit,
    threadId: threadIdForThread,
  });
  if (regen?.error) return;
  history = regen?.history ?? history;
  input = regen?.input ?? input;

  let chatStream;
  let content = "";
  const dateIso =
    toISOString(date) ?? (typeof date === "string" ? date : undefined);
  const messageId = (message as any)?.message_id as string | undefined;
  const threadId = (message as any)?.thread_id as string | undefined;
  const parentMessageId = (message as any)?.parent_message_id as
    | string
    | undefined;
  try {
    chatStream = webapp_client.openai_client.queryStream({
      input,
      history,
      project_id,
      path,
      model,
      tag: effectiveTag,
    });
  } catch (err) {
    actions.chatStreams.delete(id);
    if (!actions.syncdb) return;
    content += `\n\n<span style='color:#b71c1c'>${err}</span>`;
    actions.syncdb.set({
      event: "chat",
      sender_id,
      date: dateIso ?? new Date(date),
      history: addToHistory(prevHistory, {
        author_id: sender_id,
        content,
      }),
      generating: false,
      message_id: messageId,
      thread_id: threadId,
      parent_message_id: parentMessageId,
    });
    actions.syncdb.commit();
    return;
  }

  // Adjust sender_id when regenerating with explicit model
  if (tag === "regenerate" && llm != null && message.sender_id !== sender_id) {
    const cur = findChatRecord({
      actions,
      syncdb,
      messageId,
      dateIso,
      senderId: message.sender_id,
    });
    if (cur) {
      syncdb.delete({
        event: "chat",
        date: dateIso ?? date,
        sender_id: (cur as any)?.sender_id ?? message.sender_id,
        message_id: (cur as any)?.message_id ?? messageId,
        thread_id: (cur as any)?.thread_id ?? threadId,
      });
      syncdb.set({
        date: dateIso ?? date,
        history: (cur as any)?.history ?? [],
        event: "chat",
        sender_id,
        message_id: (cur as any)?.message_id ?? messageId,
        thread_id: (cur as any)?.thread_id ?? threadId,
        parent_message_id: (cur as any)?.parent_message_id ?? parentMessageId,
      });
    }
  }

  let halted = false;

  chatStream.on("token", (token) => {
    if (halted || !actions.syncdb) {
      return;
    }

    const cur = findChatRecord({
      actions,
      syncdb: actions.syncdb,
      messageId,
      dateIso,
      senderId: sender_id,
    });
    if ((cur as any)?.generating === false) {
      halted = true;
      actions.chatStreams.delete(id);
      return;
    }

    if (token != null) content += token;

    actions.syncdb.set({
      event: "chat",
      sender_id,
      date: dateIso ?? new Date(date),
      history: addToHistory(prevHistory, {
        author_id: sender_id,
        content,
      }),
      generating: token != null,
      message_id: messageId,
      thread_id: threadId,
      parent_message_id: parentMessageId,
    });

    if (token == null) {
      actions.chatStreams.delete(id);
      actions.syncdb.commit();
    }
  });

  chatStream.on("error", (err) => {
    actions.chatStreams.delete(id);
    if (!actions.syncdb || halted) return;

    if (!model) {
      throw new Error(
        `bug: No model set, but we're in language model error handler`,
      );
    }

    const vendor = model2vendor(model);
    const statusCheck = getLLMServiceStatusCheckMD(vendor.name);
    content += `\n\n<span style='color:#b71c1c'>${err}</span>\n\n---\n\n${statusCheck}`;
    actions.syncdb.set({
      event: "chat",
      sender_id,
      date: dateIso ?? new Date(date),
      history: addToHistory(prevHistory, {
        author_id: sender_id,
        content,
      }),
      generating: false,
      message_id: messageId,
      thread_id: threadId,
      parent_message_id: parentMessageId,
    });
    actions.syncdb.commit();
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
    return llm;
  }

  const input = message.history?.[0]?.content ?? "";
  const mentioned = getLanguageModel(input);
  const mentionedAny = mentionsLanguageModel(input);

  if (mentionedAny && mentioned) return mentioned;
  if (mentionedAny && !mentioned) return null;

  // No explicit mention: fall back to the thread's model (e.g. Codex threads)
  return threadModel || null;
}

function modelToSender(model: LanguageModel): string {
  try {
    return model2service(model);
  } catch {
    return model as string;
  }
}

function ensureThinkingMessage({
  actions,
  message,
  tag,
  sender_id,
}: {
  actions: ChatActions;
  message: ChatMessage;
  tag?: string;
  sender_id: string;
}): { date: string; prevHistory: MessageHistory[] } {
  const thinking = ":robot: Thinking...";
  if (tag === "regenerate") {
    return actions.saveHistory(message, thinking, sender_id, true);
  }
  return {
    date: actions.sendReply({
      message,
      reply: thinking,
      from: sender_id,
      noNotification: true,
    }),
    prevHistory: [],
  };
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
  h.pop(); // remove last LLM message
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

function throttleWarning({
  actions,
  date,
  sender_id,
}: {
  actions: ChatActions;
  date: string;
  sender_id: string;
}) {
  if (!actions.syncdb) return;
  actions.syncdb.set({
    date,
    history: [
      {
        author_id: sender_id,
        content: `\n\n<span style='color:#b71c1c'>There are already ${MAX_CHAT_STREAM} language model responses being written. Please try again once one finishes.</span>\n\n`,
        date,
      },
    ],
    event: "chat",
    sender_id,
  });
  actions.syncdb.commit();
}

function getLLMServiceStatusCheckMD(vendorName: string): string {
  // lazy import to avoid circular issues
  const {
    getLLMServiceStatusCheckMD,
  } = require("@cocalc/util/db-schema/llm-utils");
  return getLLMServiceStatusCheckMD(vendorName);
}

function stripMentions(value: string): string {
  if (!value) return "";
  const STRIP = ["@chatgpt", "@codex", "@local", "@local-gpu", "@ollama"];
  for (const name of STRIP) {
    while (true) {
      const i = value.toLowerCase().indexOf(name);
      if (i == -1) break;
      value = value.slice(0, i) + value.slice(i + name.length);
    }
  }
  while (true) {
    const i = value.indexOf('<span class="user-mention"');
    if (i == -1) break;
    const j = value.indexOf("</span>", i);
    if (j == -1) break;
    value = value.slice(0, i) + value.slice(j + "</span>".length);
  }
  return value.trim();
}

function mentionsLanguageModel(input?: string): boolean {
  const x = input?.toLowerCase() ?? "";
  const sys = LANGUAGE_MODEL_PREFIXES.some((prefix) =>
    x.includes(`account-id=${prefix}`),
  );
  if (sys || x.includes(`account-id=${USER_LLM_PREFIX}`)) return true;
  if (x.includes("openai-codex-agent") || x.includes("@codex")) return true;
  return false;
}

function getLanguageModel(input?: string): false | LanguageModel {
  if (!input) return false;
  const x = input.toLowerCase();
  if (x.includes("openai-codex-agent") || x.includes("@codex")) {
    return "codex-agent";
  }
  if (x.includes("account-id=chatgpt4")) {
    return "gpt-4";
  }
  if (x.includes("account-id=chatgpt")) {
    return "gpt-3.5-turbo";
  }
  for (const vendorPrefix of LANGUAGE_MODEL_PREFIXES) {
    const prefix = `account-id=${vendorPrefix}`;
    const i = x.indexOf(prefix);
    if (i != -1) {
      const j = x.indexOf(">", i);
      const model = x.slice(i + prefix.length, j).trim() as LanguageModel;
      if (vendorPrefix === OLLAMA_PREFIX) {
        return toOllamaModel(model);
      }
      if (vendorPrefix === CUSTOM_OPENAI_PREFIX) {
        return toCustomOpenAIModel(model);
      }
      if (vendorPrefix === USER_LLM_PREFIX) {
        return `${USER_LLM_PREFIX}${model}`;
      }
      return model;
    }
  }
  return false;
}

function toISOString(date?: Date | string): string | undefined {
  if (typeof date === "string") return date;
  try {
    return date?.toISOString();
  } catch {
    return;
  }
}
