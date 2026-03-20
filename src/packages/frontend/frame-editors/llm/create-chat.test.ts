import createChat, { resolveAssistantCodexModel } from "./create-chat";

const submitNavigatorPromptToCurrentThread = jest.fn();
const dispatchNavigatorPromptIntent = jest.fn();

jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  submitNavigatorPromptToCurrentThread: (...args: any[]) =>
    submitNavigatorPromptToCurrentThread(...args),
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
    submitNavigatorPromptToCurrentThread.mockResolvedValue(true);
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

    expect(submitNavigatorPromptToCurrentThread).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        path: "/tmp/test.py",
        visiblePrompt: "Explain this",
        title: "Explain this",
        tag: "intent:editor-assistant",
        forceCodex: true,
        openFloating: true,
        codexConfig: { model: "gpt-5.4-mini" },
      }),
    );
    expect(dispatchNavigatorPromptIntent).not.toHaveBeenCalled();
  });

  it("queues a navigator intent when immediate submission is unavailable", async () => {
    submitNavigatorPromptToCurrentThread.mockResolvedValue(false);
    const actions: any = {
      _get_frame_type: () => "terminal",
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
        visiblePrompt: "List large files",
        title: "List large files",
        tag: "intent:terminal-assistant",
        forceCodex: true,
        codexConfig: { model: "gpt-5.4-mini" },
      }),
    );
  });
});
