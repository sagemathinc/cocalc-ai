import { sendArtifactReviewToThread } from "../artifact-review-agent";

test("worktree feedback stays in its originating thread without changing configuration or draft", () => {
  const actions: any = {
    getMessagesInThread: jest.fn(() => [{ message_id: "last" }]),
    sendChat: jest.fn(() => "2026-09-10T00:00:00Z"),
    getCodexConfig: jest.fn(() => ({ workingDirectory: "/main" })),
  };
  sendArtifactReviewToThread({
    actions,
    threadId: "origin-thread",
    prompt: "Fix this line",
    workingDirectory: "/different-worktree",
  });
  expect(actions.sendChat).toHaveBeenCalledWith({
    input: expect.stringContaining("/different-worktree"),
    reply_thread_id: "origin-thread",
    preserveSelectedThread: true,
    skipDraftDelete: true,
  });
  expect(actions.getCodexConfig).not.toHaveBeenCalled();
  expect(actions.sendChat.mock.calls[0][0].threadAgent).toBeUndefined();
  expect(actions.sendChat.mock.calls[0][0].acpConfigOverride).toBeUndefined();
});

test("missing source thread fails instead of creating a new conversation", () => {
  const actions: any = { getMessagesInThread: () => [], sendChat: jest.fn() };
  expect(() =>
    sendArtifactReviewToThread({
      actions,
      threadId: "missing",
      prompt: "Review",
    }),
  ).toThrow("originating thread is unavailable");
  expect(actions.sendChat).not.toHaveBeenCalled();
});

test("an unavailable chat connection does not report a successful handoff", () => {
  const actions: any = { getMessagesInThread: () => [{}], sendChat: () => "" };
  expect(() =>
    sendArtifactReviewToThread({
      actions,
      threadId: "thread",
      prompt: "Review",
    }),
  ).toThrow("could not be sent");
});
