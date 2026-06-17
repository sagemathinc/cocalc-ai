/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";

import AgentTitleBarButton from "./agent-title-bar-button";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";

const mockUseRecentAgentSessions = jest.fn();

jest.mock("antd", () => {
  const Button = ({ children, icon, ...props }: any) => (
    <button type="button" {...props}>
      {icon}
      {children}
    </button>
  );
  const Checkbox = ({ children, checked, onChange, ...props }: any) => (
    <label>
      <input type="checkbox" checked={checked} onChange={onChange} {...props} />
      {children}
    </label>
  );
  const Modal = ({ children, open }: any) =>
    open ? <div role="dialog">{children}</div> : null;
  const Space = ({ children }: any) => <div>{children}</div>;
  const Tag = ({ children }: any) => <span>{children}</span>;
  const Alert = ({ title, description }: any) => (
    <div role="alert">
      {title}
      {description}
    </div>
  );
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
    Alert,
    Button,
    Checkbox,
    Modal,
    Progress: () => <div />,
    Select,
    Space,
    Tag,
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span>{name}</span>,
  VisibleMDLG: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/components/ai-avatar", () => ({
  __esModule: true,
  default: () => <span />,
}));

jest.mock("./popup-agent-composer", () => ({
  PopupAgentComposer: ({ value, onChange }: any) => (
    <textarea
      aria-label="Agent prompt"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

jest.mock("./create-chat", () => ({
  DEFAULT_ASSISTANT_CODEX_MODEL: "gpt-5.4-mini",
}));

jest.mock("@cocalc/frontend/project/page/agent-chat-font-size", () => ({
  useAgentChatFontSize: () => ({
    fontSize: 13,
    increaseFontSize: jest.fn(),
    decreaseFontSize: jest.fn(),
    canIncreaseFontSize: true,
    canDecreaseFontSize: true,
  }),
}));

jest.mock("@cocalc/frontend/chat/recent-agent-sessions", () => ({
  agentSessionTitle: (session: any) => session.title || "Navigator session",
  useRecentAgentSessions: (...args: any[]) =>
    mockUseRecentAgentSessions(...args),
}));

jest.mock("react-intl", () => ({
  defineMessage: (message: any) => message,
  defineMessages: (messages: any) => messages,
  useIntl: () => ({
    formatMessage: (message: any) =>
      message?.defaultMessage ?? message?.id ?? "Cancel",
  }),
}));

function actions(languageModel = jest.fn()): any {
  return {
    blur: jest.fn(),
    focus: jest.fn(),
    languageModel,
    languageModelGetContext: () => "selected text",
    redux: {
      getStore: () => ({
        hasLanguageModelEnabled: () => true,
      }),
    },
  };
}

describe("AgentTitleBarButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockUseRecentAgentSessions.mockReturnValue({
      sessions: [],
      loading: false,
      error: "",
    });
  });

  it("falls back to the workspace thread flow when there are no sessions", async () => {
    const languageModel = jest.fn(async () => undefined);
    render(
      <AgentTitleBarButton
        id="frame-1"
        path="/home/user/a.ipynb"
        type="jupyter"
        actions={actions(languageModel)}
        buttonSize="small"
        buttonStyle={{}}
        visible
        buttonRef={jest.fn()}
        project_id="project-1"
        showDialog
        setShowDialog={jest.fn()}
      />,
    );

    expect(screen.getByLabelText("Recent agent sessions")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Agent prompt"), {
      target: { value: "Explain this cell" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send to Agent/ }));
    });

    expect(languageModel).toHaveBeenCalledWith(
      "frame-1",
      expect.objectContaining({
        createNewThread: false,
        submitToAgent: true,
      }),
      "selected text",
    );
  });

  it("selects and persists a recent agent session", async () => {
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
    const languageModel = jest.fn(async () => undefined);
    render(
      <AgentTitleBarButton
        id="frame-1"
        path="/home/user/a.ipynb"
        type="jupyter"
        actions={actions(languageModel)}
        buttonSize="small"
        buttonStyle={{}}
        visible
        buttonRef={jest.fn()}
        project_id="project-1"
        showDialog
        setShowDialog={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Recent agent sessions"), {
      target: { value: "session-2" },
    });
    fireEvent.change(screen.getByLabelText("Agent prompt"), {
      target: { value: "Explain this cell" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send to Agent/ }));
    });

    expect(languageModel).toHaveBeenCalledWith(
      "frame-1",
      expect.objectContaining({
        agentSession: expect.objectContaining({
          session_id: "session-2",
          chat_path: "/home/user/agent-b.chat",
          thread_key: "thread-2",
        }),
        createNewThread: false,
        submitToAgent: true,
      }),
      "selected text",
    );
    expect(
      LS.get<string>(
        "AI-CODEX-ASSISTANT-SESSION:v1:project-1:/home/user/a.ipynb:jupyter",
      ),
    ).toBe("session-2");
  });

  it("can stage a prompt in a new thread composer without submitting", async () => {
    const languageModel = jest.fn(async () => undefined);
    render(
      <AgentTitleBarButton
        id="frame-1"
        path="/home/user/a.ipynb"
        type="jupyter"
        actions={actions(languageModel)}
        buttonSize="small"
        buttonStyle={{}}
        visible
        buttonRef={jest.fn()}
        project_id="project-1"
        showDialog
        setShowDialog={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Recent agent sessions"), {
      target: { value: "__cocalc_new_agent_thread__" },
    });
    fireEvent.click(screen.getByLabelText("Automatically submit to Agent"));
    fireEvent.change(screen.getByLabelText("Agent prompt"), {
      target: { value: "Start fresh" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send to Agent/ }));
    });

    expect(languageModel).toHaveBeenCalledWith(
      "frame-1",
      expect.objectContaining({
        createNewThread: true,
        submitToAgent: false,
      }),
      "selected text",
    );
  });
});
