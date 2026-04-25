import createChat, { resolveAssistantCodexModel } from "./create-chat";

const submitNavigatorPromptInWorkspaceChat = jest.fn();
const dispatchNavigatorPromptIntent = jest.fn();

jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  submitNavigatorPromptInWorkspaceChat: (...args: any[]) =>
    submitNavigatorPromptInWorkspaceChat(...args),
  dispatchNavigatorPromptIntent: (...args: any[]) =>
    dispatchNavigatorPromptIntent(...args),
}));

describe("createChat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("defaults legacy assistant models to gpt-5.4-mini for Codex routing", () => {
    expect(resolveAssistantCodexModel("gpt-4o")).toBe("gpt-5.4-mini");
    expect(resolveAssistantCodexModel("gpt-5.4")).toBe("gpt-5.4");
  });

  it("routes editor assistant requests through navigator Codex intents", async () => {
    submitNavigatorPromptInWorkspaceChat.mockResolvedValue(true);
    const actions: any = {
      _get_frame_type: () => "cm",
      project_id: "project-1",
      path: "/tmp/test.py",
      languageModelExtraFileInfo: () => "Python code",
      languageModelGetLanguage: () => "python",
    };

    await createChat({
      actions,
      frameId: "frame-1",
      options: {
        command: "Explain this",
        model: "gpt-4o",
        tag: "custom",
      },
      input: "print('hi')",
    });

    expect(submitNavigatorPromptInWorkspaceChat).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        path: "/tmp/test.py",
        visiblePrompt: "Explain this",
        title: "Explain this",
        tag: "intent:editor-assistant",
        forceCodex: true,
        openFloating: true,
        waitForAgent: false,
        codexConfig: { model: "gpt-5.4-mini" },
      }),
    );
    expect(dispatchNavigatorPromptIntent).not.toHaveBeenCalled();
  });

  it("queues a navigator intent when immediate submission is unavailable", async () => {
    submitNavigatorPromptInWorkspaceChat.mockResolvedValue(false);
    const actions: any = {
      _get_frame_type: () => "terminal",
      get_terminal: () => ({
        getSessionId: () => "/home/user/.2026-04-22-202112.term-0.term",
      }),
      project_id: "project-1",
      path: "/tmp/session.term",
      languageModelExtraFileInfo: () => "shell session",
      languageModelGetLanguage: () => "bash",
    };

    await createChat({
      actions,
      frameId: "frame-1",
      options: {
        command: "List large files",
        model: "gpt-5.4-mini",
        tag: "custom",
      },
      input: "",
    });

    expect(dispatchNavigatorPromptIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "/home/user/.2026-04-22-202112.term-0.term",
        ),
        visiblePrompt: "List large files",
        title: "List large files",
        tag: "intent:terminal-assistant",
        forceCodex: true,
        codexConfig: { model: "gpt-5.4-mini" },
      }),
    );
    expect(dispatchNavigatorPromptIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("cocalc project terminal history <id>"),
      }),
    );
    expect(dispatchNavigatorPromptIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          "cocalc project terminal write <id> --enter -- ...",
        ),
      }),
    );
  });
});
