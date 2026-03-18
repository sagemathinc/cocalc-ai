/** @jest-environment jsdom */

const mockListSessions = jest.fn();
const mockGetChatActions = jest.fn();
const mockInitChat = jest.fn();
const mockOpenFloating = jest.fn();

jest.mock("@cocalc/frontend/chat/agent-session-index", () => ({
  listAgentSessionsForProject: (...args: any[]) => mockListSessions(...args),
}));

jest.mock("@cocalc/frontend/chat/register", () => ({
  getChatActions: (...args: any[]) => mockGetChatActions(...args),
  initChat: (...args: any[]) => mockInitChat(...args),
}));

jest.mock("@cocalc/frontend/project/page/agent-dock-state", () => ({
  openFloatingAgentSession: (...args: any[]) => mockOpenFloating(...args),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) => {
      if (name === "account") {
        return {
          get: (key: string) =>
            key === "account_id"
              ? "00000000-1000-4000-8000-000000000001"
              : undefined,
        };
      }
      return undefined;
    },
    getProjectActions: () => undefined,
  },
}));

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/wstein",
}));

import {
  createNavigatorPromptIntent,
  queueNavigatorPromptIntent,
  submitNavigatorPromptToCurrentThread,
  takeQueuedNavigatorPromptIntents,
} from "./navigator-intents";

describe("submitNavigatorPromptToCurrentThread", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    takeQueuedNavigatorPromptIntents();
  });

  it("queues fallback intent and opens floating session when chat actions are unavailable", async () => {
    mockListSessions.mockResolvedValue([]);
    mockGetChatActions.mockReturnValue(undefined);
    mockInitChat.mockReturnValue(undefined);

    const ok = await submitNavigatorPromptToCurrentThread({
      project_id: "00000000-1000-4000-8000-000000000000",
      prompt: "Help me fix this error",
      title: "Install JupyterLab",
      tag: "intent:test",
      forceCodex: true,
      openFloating: true,
      codexConfig: {
        sessionMode: "full-access",
        allowWrite: true,
        workingDirectory: "/home/wstein",
      },
    });

    expect(ok).toBe(true);
    const queued = takeQueuedNavigatorPromptIntents();
    expect(queued).toHaveLength(1);
    expect(queued[0].prompt).toBe("Help me fix this error");
    expect(queued[0].title).toBe("Install JupyterLab");
    expect(queued[0].tag).toBe("intent:test");
    expect(queued[0].codexConfig).toEqual({
      sessionMode: "full-access",
      allowWrite: true,
      workingDirectory: "/home/wstein",
    });
    expect(mockOpenFloating).toHaveBeenCalledTimes(1);
    expect(mockOpenFloating.mock.calls[0][1].title).toBe("Install JupyterLab");
  });

  it("creates a fresh Codex thread with the requested model when asked", async () => {
    mockListSessions.mockResolvedValue([
      {
        session_id: "session-1",
        project_id: "00000000-1000-4000-8000-000000000000",
        account_id: "00000000-1000-4000-8000-000000000001",
        chat_path: "/home/wstein/.local/share/cocalc/navigator.chat",
        thread_key: "thread-existing",
        title: "Existing Human Thread",
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z",
        status: "active",
        entrypoint: "global",
        model: "gpt-5.4",
      },
    ]);
    const threadIndex = new Map([
      [
        "thread-new",
        {
          key: "thread-new",
          newestTime: Date.now(),
          rootMessage: { thread_id: "thread-new" },
        },
      ],
    ]);
    const sendChat = jest.fn(() => new Date().toISOString());
    const actions = {
      syncdb: { get_state: () => "ready" },
      messageCache: { getThreadIndex: () => threadIndex },
      sendChat,
      store: {
        get: (key: string) =>
          key === "selectedThreadKey" ? "thread-new" : undefined,
      },
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptToCurrentThread({
      project_id: "00000000-1000-4000-8000-000000000000",
      prompt: "Write a proof",
      title: "Write a proof",
      tag: "intent:editor-assistant",
      forceCodex: true,
      openFloating: true,
      createNewThread: true,
      codexConfig: {
        model: "gpt-5.4-mini",
      },
    });

    expect(ok).toBe(true);
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "Write a proof",
        name: "Write a proof",
        reply_thread_id: undefined,
        threadAgent: expect.objectContaining({
          mode: "codex",
          model: "gpt-5.4-mini",
          codexConfig: expect.objectContaining({
            model: "gpt-5.4-mini",
          }),
        }),
      }),
    );
    expect(mockOpenFloating).toHaveBeenCalledWith(
      "00000000-1000-4000-8000-000000000000",
      expect.objectContaining({
        thread_key: "thread-new",
        title: "Write a proof",
      }),
    );
  });

  it("keeps queued intents even when localStorage is unavailable", () => {
    const getSpy = jest
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const setSpy = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const removeSpy = jest
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      const intent = createNavigatorPromptIntent({
        prompt: "Help me fix this error",
        title: "Install JupyterLab",
        tag: "intent:test",
      });
      queueNavigatorPromptIntent(intent);
      const queued = takeQueuedNavigatorPromptIntents();
      expect(queued).toHaveLength(1);
      expect(queued[0].prompt).toBe("Help me fix this error");
      expect(queued[0].title).toBe("Install JupyterLab");
      expect(queued[0].tag).toBe("intent:test");
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});
