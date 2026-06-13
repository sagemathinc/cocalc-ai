import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import HelpMeFix from "./help-me-fix";

let languageModelEnabled = true;
const mockUseRecentAgentSessions = jest.fn();
const dispatchNavigatorPromptIntent = jest.fn();
const submitNavigatorPromptInWorkspaceChat = jest.fn();
const createNavigatorIntentMessage = jest.fn();

jest.mock("antd", () => {
  const Div = ({ children }: any) => <div>{children}</div>;
  const Select = ({ value, options, onChange }: any) => (
    <select
      aria-label="Recent agent sessions"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option: any) => (
        <option key={option.value} value={option.value}>
          {option.title}
        </option>
      ))}
    </select>
  );
  return {
    Alert: Div,
    Select,
    Space: Div,
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  AIAvatar: () => null,
}));

jest.mock("@cocalc/frontend/chat/use-codex-payment-source", () => ({
  useCodexPaymentSource: () => ({
    paymentSource: undefined,
  }),
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({
    actions: { save: jest.fn() },
    path: "test.ipynb",
    project_id: "project-1",
    redux: {
      getStore: (name: string) => {
        if (name === "projects") {
          return {
            getIn: () => undefined,
            hasLanguageModelEnabled: () => languageModelEnabled,
          };
        }
        return {
          getIn: () => undefined,
        };
      },
    },
  }),
}));

jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  dispatchNavigatorPromptIntent: (...args: any[]) =>
    dispatchNavigatorPromptIntent(...args),
  submitNavigatorPromptInWorkspaceChat: (...args: any[]) =>
    submitNavigatorPromptInWorkspaceChat(...args),
}));

jest.mock("./help-me-fix-button", () => ({
  __esModule: true,
  default: ({ mode, inputText, agentSessionSelector, onConfirm }: any) => (
    <div data-testid={mode}>
      <button type="button" onClick={onConfirm}>
        confirm {mode}
      </button>
      {agentSessionSelector}
      <span data-testid={`${mode}-input`}>{String(inputText)}</span>
    </div>
  ),
}));

jest.mock("./help-me-fix-utils", () => ({
  createMessage: ({ error, isHint }: any) =>
    `${isHint ? "hint" : "solution"}:${error}`,
  createNavigatorIntentMessage: (...args: any[]) =>
    createNavigatorIntentMessage(...args),
  getHelp: jest.fn(),
}));

jest.mock("@cocalc/frontend/chat/recent-agent-sessions", () => ({
  agentSessionTitle: (session: any) => session.title || "Navigator session",
  useRecentAgentSessions: (...args: any[]) =>
    mockUseRecentAgentSessions(...args),
}));

describe("HelpMeFix", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    languageModelEnabled = true;
    mockUseRecentAgentSessions.mockReturnValue({
      sessions: [],
      loading: false,
      error: "",
    });
    createNavigatorIntentMessage.mockReturnValue("intent-prompt");
    submitNavigatorPromptInWorkspaceChat.mockResolvedValue(true);
  });

  it("recomputes visible prompts when rendering is temporarily disabled", async () => {
    const { rerender } = render(<HelpMeFix error="first error" />);

    languageModelEnabled = false;
    rerender(<HelpMeFix error="first error" />);

    languageModelEnabled = true;
    rerender(<HelpMeFix error="second error" />);

    await waitFor(() => {
      expect(screen.getByTestId("solution-input").textContent).toBe(
        "solution:second error",
      );
      expect(screen.getByTestId("hint-input").textContent).toBe(
        "hint:second error",
      );
    });
  });

  it("passes the selected recent agent session to the fix request", async () => {
    const first = {
      session_id: "session-1",
      project_id: "project-1",
      account_id: "account-1",
      chat_path: "/home/user/agent-a.chat",
      thread_key: "thread-1",
      title: "Notebook A",
      created_at: "2026-06-12T00:00:00.000Z",
      updated_at: "2026-06-12T01:00:00.000Z",
      status: "active",
      entrypoint: "file",
    };
    const second = {
      ...first,
      session_id: "session-2",
      chat_path: "/home/user/agent-b.chat",
      thread_key: "thread-2",
      title: "Notebook B",
    };
    mockUseRecentAgentSessions.mockReturnValue({
      sessions: [first, second],
      loading: false,
      error: "",
    });

    render(<HelpMeFix error="broken" />);

    fireEvent.change(screen.getAllByLabelText("Recent agent sessions")[0], {
      target: { value: "session-2" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "confirm solution" }));
    });

    expect(submitNavigatorPromptInWorkspaceChat).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        path: "test.ipynb",
        prompt: "intent-prompt",
        agentSession: expect.objectContaining({
          session_id: "session-2",
          chat_path: "/home/user/agent-b.chat",
          thread_key: "thread-2",
        }),
      }),
    );
  });
});
