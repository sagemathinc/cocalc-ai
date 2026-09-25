import type { ChatActions } from "./actions";

export type ArtifactReviewRequest = (
  prompt: string,
  options?: { title?: string; workingDirectory?: string },
) => void | Promise<void>;

/** A review's source directory is context, never a request to move the agent. */
export function sendArtifactReviewToThread({
  actions,
  threadId,
  prompt,
  workingDirectory,
}: {
  actions: ChatActions;
  threadId: string;
  prompt: string;
  workingDirectory?: string;
}) {
  if (!threadId || !actions.getMessagesInThread(threadId)?.length)
    throw Error(
      "The originating thread is unavailable. Reopen it before sending review feedback.",
    );
  if (!prompt.trim()) throw Error("Review feedback is empty.");
  const text = workingDirectory
    ? `${prompt}\n\nReview source directory: ${JSON.stringify(workingDirectory)}\nThis is review context; continue in this conversation without changing its configured working directory.`
    : prompt;
  const sent = actions.sendChat({
    input: text,
    reply_thread_id: threadId,
    preserveSelectedThread: true,
    skipDraftDelete: true,
  });
  if (!sent)
    throw Error(
      "Review feedback could not be sent. Check the chat connection and retry.",
    );
}
