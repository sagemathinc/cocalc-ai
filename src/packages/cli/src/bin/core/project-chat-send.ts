import { randomUUID } from "node:crypto";

import {
  buildAcpChatContext,
  buildChatMessage,
  buildCodexAcpConfig,
  normalizeCodexMention,
  type ChatThreadConfigRecord,
} from "@cocalc/chat";
import type { ImmerDB } from "@cocalc/chat/server";
import { steerAcp, streamAcp } from "@cocalc/conat/ai/acp/client";
import type { Client } from "@cocalc/conat/core/client";
import type { AcpRequest, AcpChatContext } from "@cocalc/conat/ai/acp/types";
import {
  isCodexModelName,
  normalizeCodexSessionId,
} from "@cocalc/util/ai/codex";
import {
  OTHER_SETTINGS_CODEX_MAX_CONCURRENT_SUBAGENTS,
  normalizeCodexMaxConcurrentSubagents,
} from "@cocalc/util/ai/codex-subagent-concurrency";
import {
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY,
  OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY,
  normalizeNotificationPreferencesV2,
  resolveCodexCompletionNotificationEnabled,
} from "@cocalc/util/notification-preferences";
import type { DB } from "@cocalc/conat/hub/api/db";

export async function readChatSendAccountSettings(
  db: Pick<DB, "userQuery">,
  accountId: string,
) {
  const result = await db.userQuery({
    query: { accounts: [{ account_id: accountId, other_settings: null }] },
  });
  const account = result?.accounts?.find((row) => row.account_id === accountId);
  if (!account)
    throw new Error("could not read the sending account's preferences");
  return account.other_settings ?? {};
}

export function prepareChatSend({
  projectId,
  accountId,
  path,
  thread,
  rows,
  prompt,
  guidance = false,
  apiUrl,
  otherSettings = {},
}: {
  projectId: string;
  accountId: string;
  path: string;
  thread: ChatThreadConfigRecord;
  rows: any[];
  prompt: string;
  guidance?: boolean;
  apiUrl?: string;
  otherSettings?: Record<string, unknown>;
}) {
  if (!prompt.trim()) throw new Error("message must not be empty");
  if (!accountId) throw new Error("an authenticated account is required");
  if (thread.archived) throw new Error("cannot send to an archived thread");
  if (
    thread.agent_kind !== "acp" &&
    thread.acp_config == null &&
    !isCodexModelName(thread.agent_model)
  ) {
    throw new Error("project chat send requires a Codex/ACP thread");
  }
  const messages = rows
    .filter(
      (row) => row?.event === "chat" && row.thread_id === thread.thread_id,
    )
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const latest = messages.at(-1);
  const config = thread.acp_config ?? {};
  // Match the browser's recovery of a session whose config has not synced yet.
  const inferredSession = [...messages]
    .reverse()
    .find(
      (row) =>
        !row.acp_automation_id && normalizeCodexSessionId(row.acp_thread_id),
    )?.acp_thread_id;
  const sessionId =
    normalizeCodexSessionId(config.sessionId) ?? inferredSession;
  const acpConfig = buildCodexAcpConfig({
    path,
    config: sessionId ? { ...config, sessionId } : config,
    model: normalizeCodexMention(thread.agent_model),
    maxConcurrentSubagents: normalizeCodexMaxConcurrentSubagents(
      otherSettings[OTHER_SETTINGS_CODEX_MAX_CONCURRENT_SUBAGENTS],
    ),
  });
  // Chat's legacy keys also include dates. Avoid reusing a loaded row's date.
  const dates = new Set(rows.map((row) => Date.parse(row?.date)));
  let date = Date.now();
  while (dates.has(date) || dates.has(date + 1)) date += 2;
  const message = buildChatMessage({
    prevHistory: [],
    generating: false,
    sender_id: accountId,
    content: prompt,
    date: new Date(date),
    message_id: randomUUID(),
    thread_id: thread.thread_id,
    parent_message_id: latest?.message_id,
    schema_version: 2,
  });
  const chat: AcpChatContext = {
    ...buildAcpChatContext({
      project_id: projectId,
      path,
      sender_id: acpConfig.model ?? "openai-codex-agent",
      user_message_date: new Date(date).toISOString(),
      user_message_content: prompt,
      user_parent_message_id: message.parent_message_id,
      messageDate: new Date(date + 1),
      thread_id: thread.thread_id,
      message_id: randomUUID(),
      parent_message_id: message.message_id,
      api_url: apiUrl,
      sendMode: guidance ? "immediate" : undefined,
      completionNotificationEnabled: resolveCodexCompletionNotificationEnabled({
        override: thread.codex_completion_notification,
        legacy: config,
        accountDefault: normalizeNotificationPreferencesV2(
          otherSettings[OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY],
          otherSettings[OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY],
        ).ai.completion_default,
      }),
    }),
    thread_title: thread.name,
  };
  const request: AcpRequest & { chat: AcpChatContext } = {
    project_id: projectId,
    account_id: accountId,
    prompt,
    config: acpConfig,
    session_id: sessionId ?? thread.thread_id,
    chat,
  };
  return { message, request };
}

export async function submitChatSend({
  prepared,
  syncdb,
  client,
  timeoutMs = 60_000,
  transport = { stream: streamAcp, steer: steerAcp },
}: {
  prepared: ReturnType<typeof prepareChatSend>;
  syncdb: Pick<ImmerDB, "set" | "commit" | "save" | "save_to_disk">;
  client: Client;
  timeoutMs?: number;
  transport?: { stream: typeof streamAcp; steer: typeof steerAcp };
}) {
  const { message, request } = prepared;
  // Use the live syncdoc, not .chat JSON. Never create the assistant row here:
  // the backend chat writer owns it and the durable job after acknowledgement.
  syncdb.set(message);
  syncdb.commit();
  await syncdb.save();
  await syncdb.save_to_disk();
  try {
    if (request.chat.send_mode === "immediate") {
      const response = await transport.steer(request, client);
      if (
        !response.ok ||
        !["steered", "queued", "running"].includes(response.state)
      ) {
        throw new Error("guidance submission was not acknowledged");
      }
    } else {
      let accepted = false;
      for await (const response of transport.stream(
        request,
        { timeout: timeoutMs },
        client,
      )) {
        if (response.type === "error") throw new Error(response.error);
        if (
          response.type === "status" &&
          ["queued", "running"].includes(response.state)
        ) {
          accepted = true;
          break;
        }
      }
      if (!accepted)
        throw new Error("turn submission ended without acknowledgement");
    }
  } catch (err) {
    // A lost acknowledgement is ambiguous. In particular, retrying guidance
    // automatically could steer the active turn twice.
    throw new Error(
      `Message ${message.message_id} was saved in ${request.chat.path}, but agent submission was not confirmed. Check the thread before resending: ${err instanceof Error ? err.message : err}`,
    );
  }
  return {
    project_id: request.project_id,
    path: request.chat.path,
    thread_id: request.chat.thread_id,
    message_id: message.message_id,
    state: "accepted",
    guidance: request.chat.send_mode === "immediate",
  };
}
