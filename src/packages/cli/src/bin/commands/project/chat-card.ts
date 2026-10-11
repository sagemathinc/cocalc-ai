/**
 * Publishing a live card (shared browser, terminal) into the current chat
 * turn, once per thread: later calls find and reuse the card.
 */
import type { ProjectCommandDeps } from "../project";

export type ChatTarget = {
  path?: string;
  threadId?: string;
  messageDate?: string;
};

// The current turn's chat, from options or, for Codex, its environment.
export function chatTarget(opts: ChatTarget): Required<ChatTarget> | null {
  const path = opts.path ?? process.env.COCALC_CODEX_CHAT_PATH;
  const threadId = opts.threadId ?? process.env.COCALC_CODEX_THREAD_ID;
  const messageDate = opts.messageDate ?? process.env.COCALC_CODEX_MESSAGE_DATE;
  return path && threadId && messageDate
    ? { path, threadId, messageDate }
    : null;
}

export const NO_CARD_NOTE =
  "No card published: pass --path, --thread-id and --message-date for the current chat turn.";

export async function publishCardOnce({
  deps,
  ctx,
  projectId,
  chat,
  matches,
  payload,
}: {
  deps: Pick<ProjectCommandDeps, "projectChatArtifactData">;
  ctx: any;
  projectId: string;
  chat: Required<ChatTarget>;
  matches: (artifact: any) => boolean;
  payload: Record<string, unknown>;
}): Promise<{ artifact_id: string; reused: boolean }> {
  const common = {
    ctx,
    experimental: true,
    projectIdentifier: projectId,
    path: chat.path,
    threadId: chat.threadId,
  };
  const existing = ((await deps.projectChatArtifactData({
    ...common,
    action: "list",
  })) ?? []) as any[];
  const found = existing.find(matches);
  if (found) return { artifact_id: found.artifact_id, reused: true };
  const published = await deps.projectChatArtifactData({
    ...common,
    action: "publish",
    messageDate: chat.messageDate,
    payload: payload as any,
  });
  return { artifact_id: published.artifact_id, reused: false };
}
