import type { FragmentId } from "@cocalc/frontend/misc/fragment-id";

// Old conversation links must not silently replace a named agent's context.
export function agentMessageFragment(
  fragment: FragmentId | undefined,
  threadId: string,
): string | undefined {
  if (fragment?.thread && fragment.thread !== threadId) return;
  const chat = fragment?.chat;
  if (
    !chat ||
    !/^\d+$/.test(chat) ||
    !Number.isFinite(new Date(Number(chat)).valueOf())
  )
    return;
  return chat;
}
