import createChat, {
  createChatMessage,
  resolveAssistantCodexModel,
} from "./create-chat";

const submitNavigatorPromptInWorkspaceChat = jest.fn();
const dispatchNavigatorPromptIntent = jest.fn();

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  // distinct per project, so a lost project id shows up as a wrong path
  getProjectHomeDirectory: (project_id?: string) =>
    project_id === "project-1" ? "/home/user" : "/home/other-project",
}));

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

  it("defaults legacy assistant models to the current Codex default", () => {
    expect(resolveAssistantCodexModel("gpt-4o")).toBe("gpt-6-astra");
    expect(resolveAssistantCodexModel("gpt-6-sol")).toBe("gpt-6-sol");
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
        agentSession: {
          session_id: "session-1",
          project_id: "project-1",
          account_id: "account-1",
          chat_path: "/home/user/agent.chat",
          thread_key: "thread-1",
          title: "Notebook work",
          created_at: "2026-06-12T00:00:00.000Z",
          updated_at: "2026-06-12T01:00:00.000Z",
          status: "active",
          entrypoint: "file",
        },
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
        agentSession: expect.objectContaining({
          session_id: "session-1",
          chat_path: "/home/user/agent.chat",
          thread_key: "thread-1",
        }),
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
        model: "gpt-6-luna",
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

  it("sends the selected text with its file and line range to the agent", async () => {
    const actions: any = {
      _get_frame_type: () => "cm",
      project_id: "project-1",
      path: "src/app.py",
      languageModelExtraFileInfo: () => "Python code",
      languageModelGetLanguage: () => "py",
      languageModelGetContextInfo: () => ({
        text: "x = 1\ny = 2",
        scope: "selection",
        lineStart: 10,
        lineEnd: 11,
      }),
      languageModelGetContext: () => "x = 1\ny = 2",
    };

    const { message } = await createChatMessage(
      actions,
      "frame-1",
      { command: "Explain this", model: "gpt-6-sol", tag: "custom" },
      undefined,
    );

    expect(message).toContain(
      "The document is file `src/app.py` (absolute path `/home/user/src/app.py`).",
    );
    expect(message).toContain(
      "The user's current selection (lines 10–11 of the document) is:",
    );
    expect(message).toContain("```py\nx = 1\ny = 2\n```");
    expect(message).toContain('"context_scope": "selection"');
    // resolved against this project's home, not the default project's
    expect(message).toContain('"absolute_path": "/home/user/src/app.py"');
    expect(message).toContain('"context_line_start": 10');
    expect(message).toContain('"context_line_end": 11');
    expect(message).not.toContain("truncated in the middle");
    expect(message).not.toContain("Nothing is selected");
  });

  it("reports the cursor line when there is no selection", async () => {
    const actions: any = {
      _get_frame_type: () => "cm",
      project_id: "project-1",
      path: "src/app.py",
      languageModelExtraFileInfo: () => "Python code",
      languageModelGetLanguage: () => "py",
      languageModelGetContextInfo: () => ({
        text: "x = 1\ny = 2",
        scope: "all",
        lineStart: 1,
        lineEnd: 2,
        cursorLine: 2,
        cursorColumn: 5,
      }),
      languageModelGetContext: () => "x = 1\ny = 2",
    };

    const { message } = await createChatMessage(
      actions,
      "frame-1",
      { command: "Explain this", model: "gpt-6-sol", tag: "custom" },
      undefined,
    );

    expect(message).toContain(
      "Nothing is selected; the user's cursor is at line 2, column 5,",
    );
    expect(message).toContain('"cursor_line": 2');
    expect(message).toContain('"cursor_column": 5');
  });

  it("uses the frame type reported by the frame-tree actions", async () => {
    // A subfile's document actions do not own the parent frame tree, so
    // _get_frame_type(frameId) is undefined there.
    const actions: any = {
      _get_frame_type: () => undefined,
      get_terminal: () => ({ getSessionId: () => "/home/user/.a.term-0.term" }),
      project_id: "project-1",
      path: "/tmp/session.term",
      languageModelExtraFileInfo: () => "shell session",
      languageModelGetLanguage: () => "bash",
    };

    const { message } = await createChatMessage(
      actions,
      "frame-1",
      {
        command: "List large files",
        model: "gpt-6-sol",
        tag: "custom",
        frameType: "terminal",
      },
      "",
    );

    expect(message).toContain("/home/user/.a.term-0.term");
    expect(message).toContain('"frame_type": "terminal"');
    expect(message).not.toContain("The document is file");
    expect(message).not.toContain("Nothing is selected");
  });

  it("reports truncation for input just above the cutoff", async () => {
    // trunc_middle appends its marker, so the truncated string can be longer
    // than the original -- length comparison would miss this.
    const justOver = "x".repeat(12_010);
    const actions: any = {
      _get_frame_type: () => "cm",
      project_id: "project-1",
      path: "notes.md",
      languageModelExtraFileInfo: () => "Markdown document",
      languageModelGetLanguage: () => "md",
      languageModelGetContextInfo: () => ({ text: justOver, scope: "all" }),
      languageModelGetContext: () => justOver,
    };

    const { message, inputOriginalLen, inputTruncatedLen } =
      await createChatMessage(
        actions,
        "frame-1",
        { command: "Summarize", model: "gpt-6-sol", tag: "custom" },
        undefined,
      );

    // the marker pushes the result past the original length
    expect(inputTruncatedLen).toBeGreaterThan(inputOriginalLen);
    expect(message).toContain("It is truncated in the middle");
    expect(message).toContain("[... truncated ...]");
  });

  it("truncates long document context in the middle and says so", async () => {
    const longText = Array.from(
      { length: 2000 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const actions: any = {
      _get_frame_type: () => "cm",
      project_id: "project-1",
      path: "notes.md",
      languageModelExtraFileInfo: () => "Markdown document",
      languageModelGetLanguage: () => "md",
      languageModelGetContextInfo: () => ({
        text: longText,
        scope: "all",
        lineStart: 1,
        lineEnd: 2000,
      }),
      languageModelGetContext: () => longText,
    };

    const { message, inputOriginalLen, inputTruncatedLen } =
      await createChatMessage(
        actions,
        "frame-1",
        { command: "Summarize", model: "gpt-6-sol", tag: "custom" },
        undefined,
      );

    expect(inputTruncatedLen).toBeLessThan(inputOriginalLen);
    expect(message).toContain(
      "The document content (lines 1–2000 of the document) is: It is truncated in the middle; read the file for the full content.",
    );
    expect(message).toContain("line 1\n");
    expect(message).toContain("[... truncated ...]");
    expect(message).toContain("line 2000");
    expect(message).not.toContain("line 1000\n");
  });
});
