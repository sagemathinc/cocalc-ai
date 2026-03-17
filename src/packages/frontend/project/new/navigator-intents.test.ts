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
