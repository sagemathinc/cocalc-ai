/** @jest-environment jsdom */

const mockListSessions = jest.fn();
const mockGetChatActions = jest.fn();
const mockInitChat = jest.fn();
const mockProcessLLM = jest.fn();
const mockOpenFloating = jest.fn();
const mockEnsureWorkspaceChatForPath = jest.fn();
const mockEnsureWorkspaceChatPath = jest.fn();
const mockOpenFile = jest.fn();
let mockAccountId = "00000000-1000-4000-8000-000000000001";
let mockProjectStoreState: Record<string, any> = {};

jest.mock("@cocalc/frontend/chat/agent-session-index", () => ({
  listAgentSessionsForProject: (...args: any[]) => mockListSessions(...args),
}));

jest.mock("@cocalc/frontend/chat/register", () => ({
  getChatActions: (...args: any[]) => mockGetChatActions(...args),
  initChat: (...args: any[]) => mockInitChat(...args),
}));

jest.mock("@cocalc/frontend/chat/actions/llm", () => ({
  processLLM: (...args: any[]) => mockProcessLLM(...args),
}));

jest.mock("@cocalc/frontend/project/page/agent-dock-state", () => ({
  openFloatingAgentSession: (...args: any[]) => mockOpenFloating(...args),
}));

jest.mock("@cocalc/frontend/project/workspaces/runtime", () => ({
  ensureWorkspaceChatForPath: (...args: any[]) =>
    mockEnsureWorkspaceChatForPath(...args),
  ensureWorkspaceChatPath: (...args: any[]) =>
    mockEnsureWorkspaceChatPath(...args),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) => {
      if (name === "account") {
        return {
          get: (key: string) =>
            key === "account_id" ? mockAccountId : undefined,
        };
      }
      return undefined;
    },
    getProjectStore: () => ({
      get: (key: string) => mockProjectStoreState[key],
    }),
    getActions: () => undefined,
    getProjectActions: () => ({
      open_file: (...args: any[]) => mockOpenFile(...args),
    }),
  },
}));

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/wstein",
}));

import {
  createNavigatorPromptIntent,
  queueNavigatorPromptIntent,
  stageNavigatorPromptInWorkspaceChat,
  submitNavigatorPromptInWorkspaceChat,
  submitNavigatorPromptToCurrentThread,
  takeQueuedNavigatorPromptIntents,
} from "./navigator-intents";
import {
  persistSessionSelection,
  persistSessionWorkspaceRecord,
} from "@cocalc/frontend/project/workspaces/selection-runtime";

describe("submitNavigatorPromptToCurrentThread", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccountId = "00000000-1000-4000-8000-000000000001";
    mockProjectStoreState = {};
    mockOpenFile.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
    takeQueuedNavigatorPromptIntents();
    mockEnsureWorkspaceChatForPath.mockResolvedValue(null);
    mockEnsureWorkspaceChatPath.mockResolvedValue(null);
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
    expect(mockOpenFloating).toHaveBeenCalled();
    expect(mockOpenFloating.mock.calls.at(-1)?.[1].title).toBe(
      "Install JupyterLab",
    );
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
    const createEmptyThread = jest.fn(() => "thread-new");
    const actions = {
      syncdb: { get_state: () => "ready" },
      messageCache: { getThreadIndex: () => threadIndex },
      createEmptyThread,
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
      prompt: "Handle this request with hidden metadata",
      visiblePrompt: "Write a proof",
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
    expect(createEmptyThread).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Write a proof",
        threadAgent: expect.objectContaining({
          mode: "codex",
          model: "gpt-5.4-mini",
        }),
      }),
    );
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "Write a proof",
        acp_prompt: "Handle this request with hidden metadata",
        name: undefined,
        reply_thread_id: "thread-new",
        threadAgent: undefined,
      }),
    );
    expect(mockOpenFloating).toHaveBeenCalledWith(
      "00000000-1000-4000-8000-000000000000",
      expect.objectContaining({
        thread_key: "thread-new",
        title: "Write a proof",
      }),
      expect.objectContaining({
        workspaceId: null,
        workspaceOnly: false,
      }),
    );
  });

  it("reuses the stored preferred thread for a workspace chat path", async () => {
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-1.chat";
    const preferredThreadKey = "1700000000000";
    mockEnsureWorkspaceChatForPath.mockResolvedValue({
      chat_path: workspaceChatPath,
      assigned: false,
      workspace: {
        workspace_id: "ws-1",
        root_path: "/home/wstein/project/repo",
        theme: {
          title: "repo",
          color: null,
          accent_color: null,
          icon: null,
          image_blob: null,
        },
      },
    });
    window.localStorage.setItem(
      `cocalc:navigator:selected-thread:chat:${encodeURIComponent(
        workspaceChatPath,
      )}`,
      preferredThreadKey,
    );
    mockListSessions.mockResolvedValue([
      {
        session_id: "workspace-ws-1",
        project_id: "00000000-1000-4000-8000-000000000000",
        account_id: "00000000-1000-4000-8000-000000000001",
        chat_path: workspaceChatPath,
        thread_key: "thread-other",
        title: "Old workspace thread",
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z",
        status: "active",
        entrypoint: "file",
      },
      {
        session_id: "workspace-ws-1-preferred",
        project_id: "00000000-1000-4000-8000-000000000000",
        account_id: "00000000-1000-4000-8000-000000000001",
        chat_path: workspaceChatPath,
        thread_key: preferredThreadKey,
        title: "Workspace agent",
        created_at: "2026-03-18T00:01:00.000Z",
        updated_at: "2026-03-18T00:01:00.000Z",
        status: "active",
        entrypoint: "file",
      },
    ]);
    const sendChat = jest.fn(() => new Date().toISOString());
    const actions = {
      syncdb: { get_state: () => "ready" },
      messageCache: {
        getThreadIndex: () =>
          new Map([
            [
              preferredThreadKey,
              {
                key: preferredThreadKey,
                newestTime: Date.now(),
                rootMessage: { thread_id: "thread-workspace" },
              },
            ],
          ]),
      },
      sendChat,
      getMessageByDate: jest.fn(() => ({
        message_id: "root-1",
        thread_id: "thread-workspace",
      })),
      store: {
        get: (key: string) =>
          key === "selectedThreadKey" ? preferredThreadKey : undefined,
      },
      getThreadMetadata: jest.fn(() => ({ name: "Workspace agent" })),
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptToCurrentThread({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/home/wstein/project/repo/a.md",
      prompt: "Rewrite this proof",
      visiblePrompt: "Rewrite this proof",
      title: "Rewrite this proof",
      forceCodex: true,
      openFloating: true,
      codexConfig: { model: "gpt-5.4-mini" },
    });

    expect(ok).toBe(true);
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_thread_id: "thread-workspace",
      }),
    );
    expect(mockOpenFloating).toHaveBeenCalledWith(
      "00000000-1000-4000-8000-000000000000",
      expect.objectContaining({
        thread_key: preferredThreadKey,
        chat_path: workspaceChatPath,
      }),
      expect.objectContaining({
        workspaceId: "ws-1",
        workspaceOnly: true,
      }),
    );
  });

  it("reuses a UUID workspace thread key instead of falling back to a new thread", async () => {
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-uuid.chat";
    const preferredThreadKey = "6759283d-106b-4d23-8632-a4a3a5a3615d";
    const preferredThreadId = "thread-workspace-uuid";
    mockEnsureWorkspaceChatForPath.mockResolvedValue({
      chat_path: workspaceChatPath,
      assigned: false,
      workspace: {
        workspace_id: "ws-uuid",
        root_path: "/home/wstein/project/assistant",
        theme: {
          title: "assistant",
          color: null,
          accent_color: null,
          icon: null,
          image_blob: null,
        },
      },
    });
    window.localStorage.setItem(
      `cocalc:navigator:selected-thread:chat:${encodeURIComponent(
        workspaceChatPath,
      )}`,
      preferredThreadKey,
    );
    mockListSessions.mockResolvedValue([
      {
        session_id: "workspace-ws-uuid",
        project_id: "00000000-1000-4000-8000-000000000000",
        account_id: "00000000-1000-4000-8000-000000000001",
        chat_path: workspaceChatPath,
        thread_key: preferredThreadKey,
        title: "Workspace agent",
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z",
        status: "active",
        entrypoint: "file",
      },
    ]);
    const sendChat = jest.fn(() => new Date().toISOString());
    const createEmptyThread = jest.fn(() => "thread-should-not-be-created");
    const actions = {
      syncdb: { get_state: () => "ready" },
      messageCache: {
        getThreadIndex: () =>
          new Map([
            [
              preferredThreadKey,
              {
                key: preferredThreadKey,
                newestTime: Date.now(),
                rootMessage: { thread_id: preferredThreadId },
              },
            ],
          ]),
      },
      sendChat,
      createEmptyThread,
      store: {
        get: (key: string) =>
          key === "selectedThreadKey" ? preferredThreadKey : undefined,
      },
      getThreadMetadata: jest.fn(() => ({ name: "Workspace agent" })),
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptToCurrentThread({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/home/wstein/project/assistant/b.md",
      prompt: "Add a final sentence",
      visiblePrompt: "Add a final sentence",
      title: "Add a final sentence",
      forceCodex: true,
      openFloating: true,
      codexConfig: { model: "gpt-5.4-mini" },
    });

    expect(ok).toBe(true);
    expect(createEmptyThread).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_thread_id: preferredThreadId,
      }),
    );
  });

  it("creates and remembers a workspace thread before the first assistant send", async () => {
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-2.chat";
    mockEnsureWorkspaceChatForPath.mockResolvedValue({
      chat_path: workspaceChatPath,
      assigned: false,
      workspace: {
        workspace_id: "ws-2",
        root_path: "/home/wstein/project/notes",
        theme: {
          title: "notes",
          color: null,
          accent_color: null,
          icon: null,
          image_blob: null,
        },
      },
    });
    mockListSessions.mockResolvedValue([]);
    const sendChat = jest.fn(() => new Date().toISOString());
    const createEmptyThread = jest.fn(() => "thread-first");
    const actions = {
      syncdb: { get_state: () => "ready" },
      messageCache: { getThreadIndex: () => new Map() },
      sendChat,
      createEmptyThread,
      store: {
        get: () => undefined,
      },
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptToCurrentThread({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/home/wstein/project/notes/a.md",
      prompt: "Start tracking this workspace work",
      visiblePrompt: "Start tracking this workspace work",
      title: "Start tracking this workspace work",
      forceCodex: true,
      openFloating: true,
      codexConfig: { model: "gpt-5.4-mini" },
    });

    expect(ok).toBe(true);
    expect(createEmptyThread).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Start tracking this workspace work",
      }),
    );
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_thread_id: "thread-first",
      }),
    );
    expect(
      window.localStorage.getItem(
        `cocalc:navigator:selected-thread:chat:${encodeURIComponent(
          workspaceChatPath,
        )}`,
      ),
    ).toBe("thread-first");
    expect(mockOpenFloating).toHaveBeenCalledWith(
      "00000000-1000-4000-8000-000000000000",
      expect.objectContaining({
        thread_key: "thread-first",
      }),
      expect.objectContaining({
        workspaceId: "ws-2",
        workspaceOnly: true,
      }),
    );
  });

  it("retries workspace chat resolution before falling back to the global navigator chat", async () => {
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-retry.chat";
    mockEnsureWorkspaceChatForPath
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        chat_path: workspaceChatPath,
        assigned: false,
        workspace: {
          workspace_id: "ws-retry",
          root_path: "/home/wstein/project/retry",
          theme: {
            title: "retry",
            color: null,
            accent_color: null,
            icon: null,
            image_blob: null,
          },
        },
      });
    mockListSessions.mockResolvedValue([]);
    const sendChat = jest.fn(() => new Date().toISOString());
    const createEmptyThread = jest.fn(() => "thread-retry");
    const actions = {
      syncdb: { get_state: () => "ready" },
      messageCache: { getThreadIndex: () => new Map() },
      sendChat,
      createEmptyThread,
      store: {
        get: () => undefined,
      },
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptToCurrentThread({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/home/wstein/project/retry/a.ipynb",
      prompt: "Use the workspace thread after retry",
      visiblePrompt: "Retry workspace routing",
      title: "Retry workspace routing",
      forceCodex: true,
      openFloating: true,
      codexConfig: { model: "gpt-5.4-mini" },
    });

    expect(ok).toBe(true);
    expect(mockEnsureWorkspaceChatForPath).toHaveBeenCalledTimes(2);
    expect(createEmptyThread).toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "Retry workspace routing",
        reply_thread_id: "thread-retry",
      }),
    );
    expect(mockOpenFloating).toHaveBeenCalledWith(
      "00000000-1000-4000-8000-000000000000",
      expect.objectContaining({
        chat_path: workspaceChatPath,
        thread_key: "thread-retry",
      }),
      expect.objectContaining({
        workspaceId: "ws-retry",
        workspaceOnly: true,
      }),
    );
  });

  it("falls back to the selected workspace record when the path resolver is stale", async () => {
    const projectId = "00000000-1000-4000-8000-000000000000";
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-selected.chat";
    persistSessionSelection(projectId, {
      kind: "workspace",
      workspace_id: "ws-selected",
    });
    persistSessionWorkspaceRecord(projectId, {
      workspace_id: "ws-selected",
      project_id: projectId,
      root_path: "/home/wstein/project/selected",
      theme: {
        title: "selected",
        description: "",
        color: null,
        accent_color: null,
        icon: null,
        image_blob: null,
      },
      pinned: false,
      created_at: 1,
      last_used_at: null,
      last_active_path: null,
      chat_path: null,
      notice_thread_id: null,
      notice: null,
      source: "manual",
      updated_at: 1,
    } as any);
    mockEnsureWorkspaceChatForPath.mockResolvedValue(null);
    mockEnsureWorkspaceChatPath.mockResolvedValue({
      chat_path: workspaceChatPath,
      assigned: false,
      workspace: {
        workspace_id: "ws-selected",
        root_path: "/home/wstein/project/selected",
        theme: {
          title: "selected",
          color: null,
          accent_color: null,
          icon: null,
          image_blob: null,
        },
      },
    });
    mockListSessions.mockResolvedValue([]);
    const sendChat = jest.fn(() => new Date().toISOString());
    const createEmptyThread = jest.fn(() => "thread-selected");
    const actions = {
      syncdb: { get_state: () => "ready" },
      messageCache: { getThreadIndex: () => new Map() },
      sendChat,
      createEmptyThread,
      store: {
        get: () => undefined,
      },
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptToCurrentThread({
      project_id: projectId,
      path: "/home/wstein/project/selected/a.ipynb",
      prompt: "Use the selected workspace fallback",
      visiblePrompt: "Use the selected workspace fallback",
      title: "Use the selected workspace fallback",
      forceCodex: true,
      openFloating: true,
      codexConfig: { model: "gpt-5.4-mini" },
    });

    expect(ok).toBe(true);
    expect(mockEnsureWorkspaceChatPath).toHaveBeenCalledWith({
      project_id: projectId,
      account_id: "00000000-1000-4000-8000-000000000001",
      workspace_id: "ws-selected",
    });
    expect(mockOpenFloating).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        chat_path: workspaceChatPath,
        thread_key: "thread-selected",
      }),
      expect.objectContaining({
        workspaceId: "ws-selected",
        workspaceOnly: true,
      }),
    );
  });

  it("uses the selected workspace chat path while account state is still loading", async () => {
    const projectId = "00000000-1000-4000-8000-000000000000";
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-late-account.chat";
    mockAccountId = "";
    persistSessionSelection(projectId, {
      kind: "workspace",
      workspace_id: "ws-late-account",
    });
    persistSessionWorkspaceRecord(projectId, {
      workspace_id: "ws-late-account",
      project_id: projectId,
      root_path: "/home/wstein/project/late-account",
      theme: {
        title: "late-account",
        description: "",
        color: null,
        accent_color: null,
        icon: null,
        image_blob: null,
      },
      pinned: false,
      created_at: 1,
      last_used_at: null,
      last_active_path: null,
      chat_path: workspaceChatPath,
      notice_thread_id: null,
      notice: null,
      source: "manual",
      updated_at: 1,
    } as any);
    mockEnsureWorkspaceChatForPath.mockResolvedValue(null);
    mockListSessions.mockResolvedValue([]);
    const sendChat = jest.fn(() => new Date().toISOString());
    const createEmptyThread = jest.fn(() => "thread-late-account");
    const actions = {
      syncdb: { get_state: () => "ready" },
      messageCache: { getThreadIndex: () => new Map() },
      sendChat,
      createEmptyThread,
      store: {
        get: () => undefined,
      },
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptToCurrentThread({
      project_id: projectId,
      path: "/home/wstein/project/late-account/a.md",
      prompt: "Stay in the selected workspace while account state loads",
      visiblePrompt: "Stay in the selected workspace while account state loads",
      title: "Stay in the selected workspace while account state loads",
      forceCodex: true,
      openFloating: true,
      codexConfig: { model: "gpt-5.4-mini" },
    });

    expect(ok).toBe(true);
    expect(mockEnsureWorkspaceChatPath).not.toHaveBeenCalled();
    expect(mockOpenFloating).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        chat_path: workspaceChatPath,
        thread_key: "thread-late-account",
      }),
      expect.objectContaining({
        workspaceId: "ws-late-account",
        workspaceOnly: true,
      }),
    );
  });

  it("falls back to the active project tab path when the caller path is missing", async () => {
    const projectId = "00000000-1000-4000-8000-000000000000";
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-active-tab.chat";
    mockProjectStoreState = {
      active_project_tab: "editor-/home/wstein/project/active-tab/a.md",
      current_path_abs: "/home/wstein/project/active-tab",
    };
    mockEnsureWorkspaceChatForPath.mockImplementation(async ({ path }) => {
      if (path === "/home/wstein/project/active-tab/a.md") {
        return {
          chat_path: workspaceChatPath,
          assigned: false,
          workspace: {
            workspace_id: "ws-active-tab",
            root_path: "/home/wstein/project/active-tab",
            theme: {
              title: "active-tab",
              color: null,
              accent_color: null,
              icon: null,
              image_blob: null,
            },
          },
        };
      }
      return null;
    });
    mockListSessions.mockResolvedValue([]);
    const sendChat = jest.fn(() => new Date().toISOString());
    const createEmptyThread = jest.fn(() => "thread-active-tab");
    const actions = {
      syncdb: { get_state: () => "ready" },
      messageCache: { getThreadIndex: () => new Map() },
      sendChat,
      createEmptyThread,
      store: {
        get: () => undefined,
      },
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptToCurrentThread({
      project_id: projectId,
      path: "",
      prompt: "Use the active tab path",
      visiblePrompt: "Use the active tab path",
      title: "Use the active tab path",
      forceCodex: true,
      openFloating: true,
      codexConfig: { model: "gpt-5.4-mini" },
    });

    expect(ok).toBe(true);
    expect(mockEnsureWorkspaceChatForPath).toHaveBeenCalledWith({
      project_id: projectId,
      account_id: "00000000-1000-4000-8000-000000000001",
      path: "/home/wstein/project/active-tab/a.md",
    });
    expect(mockOpenFloating).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        chat_path: workspaceChatPath,
        thread_key: "thread-active-tab",
      }),
      expect.objectContaining({
        workspaceId: "ws-active-tab",
        workspaceOnly: true,
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

  it("opens the workspace chat and stages a visible prompt without ACP dispatch", async () => {
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-stage.chat";
    mockEnsureWorkspaceChatForPath.mockResolvedValue({
      chat_path: workspaceChatPath,
      assigned: false,
      workspace: {
        workspace_id: "ws-stage",
        root_path: "/home/wstein/project/stage",
        theme: {
          title: "stage",
          color: null,
          accent_color: null,
          icon: null,
          image_blob: null,
        },
      },
    });
    mockListSessions.mockResolvedValue([]);
    const save = jest.fn().mockResolvedValue(undefined);
    const sendChat = jest.fn(() => new Date().toISOString());
    const createEmptyThread = jest.fn(() => "thread-stage");
    const actions = {
      syncdb: { get_state: () => "ready", save },
      messageCache: { getThreadIndex: () => new Map() },
      sendChat,
      createEmptyThread,
      store: {
        get: () => undefined,
      },
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await stageNavigatorPromptInWorkspaceChat({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/home/wstein/project/stage/a.ipynb",
      prompt: "Detailed hidden notebook repair prompt",
      visiblePrompt: "Investigate and fix this Jupyter notebook error.",
      title: "Fix notebook error",
      forceCodex: true,
      codexConfig: { model: "gpt-5.4-mini" },
    });

    expect(ok).toBe(true);
    expect(mockOpenFile).not.toHaveBeenCalled();
    expect(createEmptyThread).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Fix notebook error",
        threadAgent: expect.objectContaining({
          mode: "codex",
          model: "gpt-5.4-mini",
        }),
      }),
    );
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "Investigate and fix this Jupyter notebook error.",
        acp_prompt: "Detailed hidden notebook repair prompt",
        reply_thread_id: "thread-stage",
        skipModelDispatch: true,
      }),
    );
    expect(save).toHaveBeenCalled();
    expect(mockOpenFloating).not.toHaveBeenCalled();
  });

  it("ignores phantom thread keys when staging a workspace prompt", async () => {
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-stage-phantom.chat";
    mockEnsureWorkspaceChatForPath.mockResolvedValue({
      chat_path: workspaceChatPath,
      assigned: false,
      workspace: {
        workspace_id: "ws-stage-phantom",
        root_path: "/home/wstein/project/stage-phantom",
        theme: {
          title: "stage-phantom",
          color: null,
          accent_color: null,
          icon: null,
          image_blob: null,
        },
      },
    });
    mockListSessions.mockResolvedValue([]);
    const save = jest.fn().mockResolvedValue(undefined);
    const sendChat = jest.fn(() => new Date().toISOString());
    const createEmptyThread = jest.fn(() => "thread-stage-real");
    const setThreadAgentMode = jest.fn();
    const actions = {
      syncdb: { get_state: () => "ready", save },
      messageCache: {
        getThreadIndex: () =>
          new Map([
            [
              "thread-stage-phantom",
              {
                key: "thread-stage-phantom",
                newestTime: Date.now(),
                rootMessage: {},
              },
            ],
          ]),
      },
      sendChat,
      createEmptyThread,
      setThreadAgentMode,
      store: {
        get: (key: string) =>
          key === "selectedThreadKey" ? "thread-stage-phantom" : undefined,
      },
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await stageNavigatorPromptInWorkspaceChat({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/home/wstein/project/stage-phantom/a.ipynb",
      prompt: "Detailed hidden notebook repair prompt",
      visiblePrompt: "Investigate and fix this Jupyter notebook error.",
      title: "Fix notebook error",
      forceCodex: true,
      codexConfig: { model: "gpt-5.4-mini" },
    });

    expect(ok).toBe(true);
    expect(setThreadAgentMode).not.toHaveBeenCalled();
    expect(createEmptyThread).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Fix notebook error",
      }),
    );
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_thread_id: "thread-stage-real",
        skipModelDispatch: true,
      }),
    );
  });

  it("submits a staged workspace prompt only after saving the chat row", async () => {
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-submit.chat";
    mockEnsureWorkspaceChatForPath.mockResolvedValue({
      chat_path: workspaceChatPath,
      assigned: false,
      workspace: {
        workspace_id: "ws-submit",
        root_path: "/home/wstein/project/submit",
        theme: {
          title: "submit",
          color: null,
          accent_color: null,
          icon: null,
          image_blob: null,
        },
      },
    });
    mockListSessions.mockResolvedValue([]);
    const save = jest.fn().mockResolvedValue(undefined);
    mockProcessLLM.mockResolvedValue(undefined);
    const timeStamp = "2026-03-20T06:10:00.000Z";
    const message = {
      history: [
        {
          author_id: "00000000-1000-4000-8000-000000000001",
          content: "Investigate and fix this Jupyter notebook error.",
        },
      ],
      message_id: "msg-submit",
      thread_id: "thread-submit",
    };
    const sendChat = jest.fn(() => timeStamp);
    const createEmptyThread = jest.fn(() => "thread-submit");
    const get_one = jest.fn((where: any) =>
      where?.event === "chat" && where?.date === timeStamp
        ? message
        : undefined,
    );
    const actions = {
      syncdb: { get_state: () => "ready", save, get_one },
      messageCache: { getThreadIndex: () => new Map() },
      sendChat,
      createEmptyThread,
      getMessageByDate: jest.fn(() => undefined),
      store: {
        get: () => undefined,
      },
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptInWorkspaceChat({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/home/wstein/project/submit/a.ipynb",
      prompt: "Detailed hidden notebook repair prompt",
      visiblePrompt: "Investigate and fix this Jupyter notebook error.",
      title: "Fix notebook error",
      tag: "intent:notebook-error",
      forceCodex: true,
      codexConfig: { model: "gpt-5.4-mini" },
      openFloating: true,
    });

    expect(ok).toBe(true);
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "Investigate and fix this Jupyter notebook error.",
        skipModelDispatch: true,
      }),
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(get_one).toHaveBeenCalledWith({
      event: "chat",
      date: timeStamp,
      sender_id: "00000000-1000-4000-8000-000000000001",
    });
    expect(mockProcessLLM).toHaveBeenCalledWith({
      actions,
      message,
      tag: "intent:notebook-error",
      threadModel: "gpt-5.4-mini",
      acpConfigOverride: expect.objectContaining({
        model: "gpt-5.4-mini",
        workingDirectory: "/home/wstein/project/submit",
      }),
    });
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      mockProcessLLM.mock.invocationCallOrder[0],
    );
    expect(mockOpenFloating).toHaveBeenCalledWith(
      "00000000-1000-4000-8000-000000000000",
      expect.objectContaining({
        session_id: "thread-submit",
        thread_key: "thread-submit",
        title: "Fix notebook error",
        model: "gpt-5.4-mini",
        working_directory: "/home/wstein/project/submit",
      }),
      {
        workspaceId: "ws-submit",
        workspaceOnly: true,
      },
    );
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      mockOpenFloating.mock.invocationCallOrder[0],
    );
    expect(mockOpenFloating.mock.invocationCallOrder[0]).toBeLessThan(
      mockProcessLLM.mock.invocationCallOrder[0],
    );
  });

  it("reuses an existing UUID workspace thread when submitting in place", async () => {
    const workspaceChatPath =
      "/home/wstein/.local/share/cocalc/workspaces/acct/ws-submit-reuse.chat";
    mockEnsureWorkspaceChatForPath.mockResolvedValue({
      chat_path: workspaceChatPath,
      assigned: false,
      workspace: {
        workspace_id: "ws-submit-reuse",
        root_path: "/home/wstein/project/submit-reuse",
        theme: {
          title: "submit-reuse",
          color: null,
          accent_color: null,
          icon: null,
          image_blob: null,
        },
      },
    });
    mockListSessions.mockResolvedValue([
      {
        session_id: "sess-reuse",
        project_id: "00000000-1000-4000-8000-000000000000",
        account_id: "00000000-1000-4000-8000-000000000001",
        chat_path: workspaceChatPath,
        thread_key: "thread-existing-uuid",
        title: "Fix notebook error",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:01.000Z",
        status: "active",
        entrypoint: "file",
        model: "gpt-5.4-mini",
      },
    ]);
    const save = jest.fn().mockResolvedValue(undefined);
    mockProcessLLM.mockResolvedValue(undefined);
    const timeStamp = "2026-03-20T06:11:00.000Z";
    const message = {
      history: [
        {
          author_id: "00000000-1000-4000-8000-000000000001",
          content: "Investigate and fix this Jupyter notebook error.",
        },
      ],
      message_id: "msg-submit-reuse",
      thread_id: "thread-existing-uuid",
    };
    const sendChat = jest.fn(() => timeStamp);
    const createEmptyThread = jest.fn();
    const get_one = jest.fn((where: any) =>
      where?.event === "chat" && where?.date === timeStamp
        ? message
        : undefined,
    );
    const actions = {
      syncdb: { get_state: () => "ready", save, get_one },
      messageCache: {
        getThreadIndex: () =>
          new Map([
            [
              "thread-existing-uuid",
              {
                key: "thread-existing-uuid",
                newestTime: Date.now(),
                rootMessage: { thread_id: "thread-existing-uuid" },
              },
            ],
          ]),
      },
      sendChat,
      createEmptyThread,
      getMessageByDate: jest.fn(() => undefined),
      store: {
        get: () => undefined,
      },
      getThreadMetadata: jest.fn(() => ({ name: "Fix notebook error" })),
    };
    mockGetChatActions.mockReturnValue(actions);
    mockInitChat.mockReturnValue(actions);

    const ok = await submitNavigatorPromptInWorkspaceChat({
      project_id: "00000000-1000-4000-8000-000000000000",
      path: "/home/wstein/project/submit-reuse/a.ipynb",
      prompt: "Detailed hidden notebook repair prompt",
      visiblePrompt: "Investigate and fix this Jupyter notebook error.",
      title: "Fix notebook error",
      tag: "intent:notebook-error",
      forceCodex: true,
      codexConfig: { model: "gpt-5.4-mini" },
      openFloating: true,
    });

    expect(ok).toBe(true);
    expect(createEmptyThread).not.toHaveBeenCalled();
    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_thread_id: "thread-existing-uuid",
        skipModelDispatch: true,
      }),
    );
  });
});
