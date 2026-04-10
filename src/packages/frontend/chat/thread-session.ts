import { field } from "./access";
import type { ChatActions } from "./actions";

export function getLatestAcpThreadIdForThread({
  actions,
  threadId,
}: {
  actions?: Pick<ChatActions, "getMessagesInThread">;
  threadId?: string;
}): string | undefined {
  if (!threadId) return undefined;
  const threadMessages = actions?.getMessagesInThread?.(threadId) ?? [];
  for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
    const sessionId = field<string>(threadMessages[i], "acp_thread_id");
    if (typeof sessionId === "string" && sessionId.trim().length > 0) {
      return sessionId.trim();
    }
  }
  return undefined;
}

export function resolveAgentSessionIdForThread({
  actions,
  threadId,
  threadKey,
  persistedSessionId,
}: {
  actions?: Pick<ChatActions, "getMessagesInThread">;
  threadId?: string;
  threadKey: string;
  persistedSessionId?: string | null;
}): string {
  if (
    typeof persistedSessionId === "string" &&
    persistedSessionId.trim().length > 0
  ) {
    return persistedSessionId.trim();
  }
  const liveSessionId = getLatestAcpThreadIdForThread({ actions, threadId });
  if (liveSessionId) return liveSessionId;
  return threadKey;
}

export function resolvePersistedOrLiveAcpSessionIdForThread({
  actions,
  threadId,
  persistedSessionId,
}: {
  actions?: Pick<ChatActions, "getMessagesInThread">;
  threadId?: string;
  persistedSessionId?: string | null;
}): string | undefined {
  if (
    typeof persistedSessionId === "string" &&
    persistedSessionId.trim().length > 0
  ) {
    return persistedSessionId.trim();
  }
  return getLatestAcpThreadIdForThread({ actions, threadId });
}
