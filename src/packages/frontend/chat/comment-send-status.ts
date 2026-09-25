import type { ChatActions } from "./actions";

/** Local message persistence is not evidence that ACP accepted a turn. */
export function commentSendStatus(
  actions: ChatActions,
  messageId: string,
): "accepted" | "not-sent" | "unconfirmed" {
  const state = actions.store?.get("acpState")?.get(`message:${messageId}`);
  const row = actions.getMessageById?.(messageId);
  const persisted = (row as any)?.toJS?.() ?? row;
  if (["queue", "queued", "running", "sent"].includes(state ?? ""))
    return "accepted";
  if (["queue", "queued", "running", "sent"].includes(persisted?.acp_state))
    return "accepted";
  // After reload, the backend-owned assistant row provides durable evidence.
  for (const message of actions.getAllMessages?.().values() ?? []) {
    const reply = (message as any)?.toJS?.() ?? message;
    if (reply.parent_message_id === messageId && reply.acp_started_at_ms)
      return "accepted";
  }
  return state === "not-sent" || persisted?.acp_state === "not-sent"
    ? "not-sent"
    : "unconfirmed";
}

export async function waitForCommentAcceptance(
  actions: ChatActions,
  messageId: string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!signal.aborted) {
    const status = commentSendStatus(actions, messageId);
    if (status === "accepted") return;
    if (status === "not-sent" || Date.now() >= deadline)
      throw Error(
        "Agent submission not confirmed. Your comment is retained. Check its status in chat before retrying there; checking here will not send a duplicate.",
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("Comment editor closed before submission was confirmed.");
}
