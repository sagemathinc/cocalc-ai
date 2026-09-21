import type { Client } from "@cocalc/conat/core/client";
import {
  buildThreadConfigRecord,
  type ChatThreadConfigRecord,
} from "@cocalc/chat";
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import {
  reserveThreadSuccessor,
  claimThreadPreparation,
  finishThreadPreparation,
  type ThreadKey,
} from "../sqlite/acp-thread-successors";

export function freshThreadConfig(
  source: ChatThreadConfigRecord,
  thread_id: string,
  account_id: string,
) {
  const { sessionId: _session, ...config } = source.acp_config ?? {};
  return buildThreadConfigRecord({
    thread_id,
    updated_by: account_id,
    name: source.name,
    agent_kind: "acp",
    agent_mode: source.agent_mode,
    agent_model: source.agent_model,
    acp_config: config,
    thread_color: source.thread_color,
    thread_accent_color: source.thread_accent_color,
    thread_icon: source.thread_icon,
    thread_image: source.thread_image,
    codex_completion_notification: source.codex_completion_notification,
    notification_followers: source.notification_followers,
    notification_muted: source.notification_muted,
  });
}

export async function prepareFreshConversation(
  key: ThreadKey & { account_id: string },
  client: Client,
): Promise<string> {
  const db = await acquireChatSyncDB({
    client,
    project_id: key.project_id,
    path: key.path,
  });
  try {
    const rows = db.get();
    const source = rows.find(
      (row) =>
        row.event === "chat-thread-config" && row.thread_id === key.thread_id,
    ) as ChatThreadConfigRecord | undefined;
    if (!source || source.agent_kind !== "acp" || source.archived)
      throw new Error("An active agent conversation is required");
    if (source.automation_config?.enabled)
      throw new Error("Disable scheduled work before starting fresh.");
    const thread_id = reserveThreadSuccessor(key);
    const token = claimThreadPreparation(key);
    if (token) {
      try {
        if (
          !db
            .get()
            .some(
              (row) =>
                row.event === "chat-thread-config" &&
                row.thread_id === thread_id,
            )
        ) {
          db.set(freshThreadConfig(source, thread_id, key.account_id));
          db.commit({ emitChangeImmediately: true });
        }
        await db.save();
        finishThreadPreparation(key, token, true);
      } catch (error) {
        finishThreadPreparation(key, token, false);
        throw error;
      }
    }
    return thread_id;
  } finally {
    await releaseChatSyncDB(key.project_id, key.path);
  }
}
