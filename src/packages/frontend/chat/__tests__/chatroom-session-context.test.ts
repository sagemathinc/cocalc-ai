import { resolveAgentSessionIdForThread } from "../thread-session";

describe("resolveAgentSessionIdForThread", () => {
  it("prefers persisted acp_config.sessionId when present", () => {
    expect(
      resolveAgentSessionIdForThread({
        actions: {
          getMessagesInThread: () => [
            { acp_thread_id: "codex-session-live" } as any,
          ],
        } as any,
        threadId: "thread-1",
        threadKey: "thread-1",
        persistedSessionId: "session-config-1",
      }),
    ).toBe("session-config-1");
  });

  it("falls back to latest acp_thread_id when sessionId is not yet persisted", () => {
    expect(
      resolveAgentSessionIdForThread({
        actions: {
          getMessagesInThread: () => [
            { acp_thread_id: "codex-session-old" } as any,
            { acp_thread_id: "codex-session-live" } as any,
          ],
        } as any,
        threadId: "thread-2",
        threadKey: "thread-2",
      }),
    ).toBe("codex-session-live");
  });

  it("falls back to thread key when neither config nor assistant rows expose a session", () => {
    expect(
      resolveAgentSessionIdForThread({
        actions: {
          getMessagesInThread: () => [],
        } as any,
        threadId: "thread-3",
        threadKey: "thread-3",
      }),
    ).toBe("thread-3");
  });
});
