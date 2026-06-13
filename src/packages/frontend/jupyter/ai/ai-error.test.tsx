/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";

import AIError from "./ai-error";

const mockUseRecentAgentSessions = jest.fn();
const submitNavigatorPromptInWorkspaceChat = jest.fn();

jest.mock("antd", () => {
  const Button = ({ children, loading: _loading, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  );
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
    Button,
    Select,
    Space: Div,
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({
    actions: {},
    project_id: "project-1",
    path: "/home/user/notebook.ipynb",
  }),
}));

jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  submitNavigatorPromptInWorkspaceChat: (...args: any[]) =>
    submitNavigatorPromptInWorkspaceChat(...args),
}));

jest.mock("@cocalc/frontend/chat/recent-agent-sessions", () => ({
  agentSessionTitle: (session: any) => session.title || "Navigator session",
  useRecentAgentSessions: (...args: any[]) =>
    mockUseRecentAgentSessions(...args),
}));

describe("AIError", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    submitNavigatorPromptInWorkspaceChat.mockResolvedValue(true);
    mockUseRecentAgentSessions.mockReturnValue({
      sessions: [],
      loading: false,
      error: "",
    });
  });

  it("passes the selected recent agent session to notebook repair requests", async () => {
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

    render(<AIError input="1 / 0" traceback="ZeroDivisionError" />);

    fireEvent.change(screen.getByLabelText("Recent agent sessions"), {
      target: { value: "session-2" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix with Agent" }));
    });

    expect(submitNavigatorPromptInWorkspaceChat).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
        path: "/home/user/notebook.ipynb",
        agentSession: expect.objectContaining({
          session_id: "session-2",
          chat_path: "/home/user/agent-b.chat",
          thread_key: "thread-2",
        }),
      }),
    );
  });
});
