import { codexAttentionAcceptingRuntime } from "@cocalc/util/ai/codex-attention";
import { uuidsha1 } from "@cocalc/backend/misc_node";
import { buildChatMessage } from "@cocalc/chat/core";
import type { AcpAttentionStoredRecord } from "../sqlite/acp-attention";

export function attentionResponseMessageId(record: AcpAttentionStoredRecord) {
  return uuidsha1(
    `acp-attention-user:${record.attention_id}:${record.response_id ?? "response"}`,
  );
}

export function attentionResponseMetadata(record: AcpAttentionStoredRecord) {
  return {
    attention_id: record.attention_id,
    response_id: record.response_id,
    assistant_message_id: record.chat.message_id,
    submitted_at: record.response_submitted_at,
  };
}

export function formatAttentionResponseTranscript(
  record: AcpAttentionStoredRecord,
): string {
  const lines = ["Response to agent questions:"];
  for (const question of record.questions) {
    lines.push(
      `\n${question.header}: ${question.question}`,
      record.response_declined
        ? "Declined to answer."
        : (record.response?.[question.id] ?? []).join("\n"),
    );
  }
  return lines.join("\n");
}

// Saving an answer is not evidence that the running model accepted it.
export function acceptedSyncAttentionResponse(
  record: AcpAttentionStoredRecord,
): boolean {
  return (
    record.source_kind === "codex_sync_question" &&
    !record.dispatch_as_async &&
    ((record.state === "answered" &&
      codexAttentionAcceptingRuntime(record.resolution_reason) != null) ||
      (record.state === "declined" &&
        record.resolution_reason === "The user declined to answer"))
  );
}

export function buildAttentionResponseProjection(
  record: AcpAttentionStoredRecord,
  parentMessageId?: string,
) {
  if (!record.response_id || record.response_submitted_at == null) return;
  const date = new Date(record.response_submitted_at);
  return {
    ...buildChatMessage({
      sender_id: record.account_id,
      date,
      historyEntryDate: date.toISOString(),
      prevHistory: [],
      content: formatAttentionResponseTranscript(record),
      generating: false,
      message_id: attentionResponseMessageId(record),
      thread_id: record.thread_id,
      parent_message_id: parentMessageId ?? record.chat.message_id,
    }),
    // This is a transcript projection, never a request to launch another turn.
    post_only: true,
    acp_attention_response: attentionResponseMetadata(record),
    ...(acceptedSyncAttentionResponse(record)
      ? {
          acp_guidance_delivered_at_ms: record.resolved_at ?? record.updated_at,
        }
      : {}),
  };
}
