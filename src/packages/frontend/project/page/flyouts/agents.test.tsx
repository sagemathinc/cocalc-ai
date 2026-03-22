/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AgentsPanel } from "./agents";

const mockOpenFile = jest.fn();
const mockCreateFile = jest.fn();
const mockUpsertAgentSessionRecord = jest.fn();
const mockOpenFloatingAgentSession = jest.fn();
const mockChatActions = {
  setSelectedThread: jest.fn(),
  scrollToIndex: jest.fn(),
} as any;
const mockEnsureWorkspaceChatPath = jest.fn();
const mockEnsureWorkspaceChatDirectory = jest.fn();

let mockSessions: any[] = [];
let mockCurrentPath = "/home/user";
let mockActiveProjectTab = "";
let mockWorkspaceCurrent: any = null;
let mockResolveWorkspaceForPath: jest.Mock<any, [string]> = jest.fn(
  (_path: string) => null,
);
let mockDirEntries = [] as string[];

jest.mock("antd", () => {
  const Div = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  const Button = ({ children, onClick, loading: _loading, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  );
  const Dropdown = ({ children }: any) => children;
  const Empty = ({ description }: any) => <div>{description}</div>;
  const Popconfirm = ({ children }: any) => children;
  const Space = ({ children }: any) => <div>{children}</div>;
  const Switch = ({ checked, onChange, ...props }: any) => (
    <button
      type="button"
      aria-pressed={checked === true}
      onClick={() => onChange?.(!(checked === true))}
      {...props}
    />
  );
  const Tag = ({ children }: any) => <span>{children}</span>;
  Tag.CheckableTag = ({ children, onChange }: any) => (
    <button type="button" onClick={() => onChange?.(true)}>
      {children}
    </button>
  );
  const Text = ({ children, strong: _strong, ...props }: any) => (
    <span {...props}>{children}</span>
  );
  return {
    Alert: Div,
    Button,
    Dropdown,
    Empty,
    Popconfirm,
    Space,
    Switch,
    Tag,
    Tooltip: Div,
    Typography: { Text },
  };
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  ...require("react"),
  React: require("react"),
  redux: {
    getEditorActions: () => undefined,
  },
  useActions: () =>
    ({
      open_file: mockOpenFile,
      createFile: mockCreateFile,
      fs: () => ({
        stat: async () => ({ mtimeMs: 1 }),
        readdir: async () => mockDirEntries,
      }),
    }) as any,
  useTypedRedux: (store: any, key: string) => {
    if (store === "account" && key === "account_id") {
      return "acct-1";
    }
    if (store === "account" && key === "font_size") {
      return 13;
    }
    if (
      (store as any)?.project_id === "project-1" &&
      key === "current_path_abs"
    ) {
      return mockCurrentPath;
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/chat/agent-session-index", () => ({
  watchAgentSessionsForProject: async (
    _args: any,
    cb: (records: any[]) => void,
  ) => {
    cb(mockSessions);
    return () => undefined;
  },
  upsertAgentSessionRecord: (...args: any[]) =>
    mockUpsertAgentSessionRecord(...args),
}));

jest.mock("@cocalc/frontend/chat/register", () => ({
  getChatActions: () => mockChatActions,
  initChat: () => mockChatActions,
  removeWithInstance: jest.fn(),
  isChatActions: () => true,
}));

jest.mock("@cocalc/frontend/chat/side-chat", () => ({
  __esModule: true,
  default: () => <div data-testid="agents-inline-chat" />,
}));

jest.mock("@cocalc/frontend/chat/thread-badge", () => ({
  ThreadBadge: () => <div />,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Loading: () => <div>Loading...</div>,
  TimeAgo: ({ date }: any) => <span>{date}</span>,
}));

jest.mock("@cocalc/frontend/lib/file-context", () => ({
  FileContext: {
    Provider: ({ children }: any) => children,
  },
}));

jest.mock("@cocalc/frontend/misc", () => ({
  delete_local_storage: (key: string) => window.localStorage.removeItem(key),
  get_local_storage: (key: string) => window.localStorage.getItem(key),
  html_to_text: (value: string) => value,
  set_local_storage: (key: string, value: string) =>
    window.localStorage.setItem(key, value),
}));

jest.mock("@cocalc/frontend/project/page/agent-panel-state", () => ({
  AGENT_PANEL_REVEAL_EVENT: "cocalc:agent-panel:reveal",
  loadOpenedAgentSessionSelection: () => null,
  revealAgentSession: (...args: any[]) => mockOpenFloatingAgentSession(...args),
  saveOpenedAgentSessionSelection: jest.fn(),
}));

jest.mock("@cocalc/frontend/project/page/anchor-tag-component", () => ({
  __esModule: true,
  default: () => "a",
}));

jest.mock("@cocalc/frontend/project/page/url-transform", () => ({
  __esModule: true,
  default: () => (value: string) => value,
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

jest.mock("@cocalc/frontend/project/workspaces/runtime", () => ({
  ensureWorkspaceChatPath: (...args: any[]) =>
    mockEnsureWorkspaceChatPath(...args),
  ensureWorkspaceChatDirectory: (...args: any[]) =>
    mockEnsureWorkspaceChatDirectory(...args),
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    active_project_tab: mockActiveProjectTab,
    workspaces: {
      current: mockWorkspaceCurrent,
      resolveWorkspaceForPath: (path: string) =>
        mockResolveWorkspaceForPath(path),
      setSelection: jest.fn(),
    },
  }),
}));

describe("AgentsPanel session cards", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockOpenFile.mockClear();
    mockCreateFile.mockClear();
    mockUpsertAgentSessionRecord.mockClear();
    mockOpenFloatingAgentSession.mockClear();
    mockChatActions.setSelectedThread.mockClear();
    mockChatActions.scrollToIndex.mockClear();
    mockEnsureWorkspaceChatPath.mockReset();
    mockEnsureWorkspaceChatDirectory.mockReset();
    mockSessions = [
      {
        session_id: "session-1",
        account_id: "acct-1",
        chat_path: "/home/user/agent.chat",
        thread_key: "thread-1",
        title: "Agent session",
        status: "idle",
        created_at: "2026-03-12T08:00:00.000Z",
        updated_at: "2026-03-12T08:10:00.000Z",
        entrypoint: "file",
        model: "gpt-5-codex",
      },
    ];
    mockCurrentPath = "/home/user";
    mockActiveProjectTab = "";
    mockWorkspaceCurrent = null;
    mockResolveWorkspaceForPath = jest.fn((_path: string) => null);
    mockDirEntries = [];
    (global as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  it("shows the exact session status on the card", async () => {
    render(<AgentsPanel project_id="project-1" layout="page" />);

    await waitFor(() => expect(screen.getByText("idle")).toBeTruthy());
  });

  it("opens the inline chat when the card is clicked", async () => {
    render(<AgentsPanel project_id="project-1" layout="page" />);

    await waitFor(() =>
      expect(screen.getByTestId("agent-session-card-session-1")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("agent-session-card-session-1"));

    await waitFor(() =>
      expect(screen.getByTestId("agents-inline-chat")).toBeTruthy(),
    );
    expect(mockChatActions.setSelectedThread).toHaveBeenCalledWith("thread-1");
  });

  it("opens the inline chat when the agent panel reveal event fires", async () => {
    render(<AgentsPanel project_id="project-1" layout="page" />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("cocalc:agent-panel:reveal", {
          detail: {
            projectId: "project-1",
            session: mockSessions[0],
            workspaceId: null,
            workspaceOnly: false,
          },
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("agents-inline-chat")).toBeTruthy(),
    );
    expect(mockChatActions.setSelectedThread).toHaveBeenCalledWith("thread-1");
  });

  it("does not open the inline chat when the menu button is clicked", async () => {
    render(<AgentsPanel project_id="project-1" layout="page" />);

    await waitFor(() =>
      expect(screen.getByTestId("agent-session-menu-session-1")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("agent-session-menu-session-1"));

    expect(screen.queryByTestId("agents-inline-chat")).toBeNull();
  });

  it("does not open the inline chat when the menu button handles Enter", async () => {
    render(<AgentsPanel project_id="project-1" layout="page" />);

    await waitFor(() =>
      expect(screen.getByTestId("agent-session-menu-session-1")).toBeTruthy(),
    );
    fireEvent.keyDown(screen.getByTestId("agent-session-menu-session-1"), {
      key: "Enter",
    });

    expect(screen.queryByTestId("agents-inline-chat")).toBeNull();
  });

  it("creates a new agent chat in the active folder when no chat exists there", async () => {
    mockCurrentPath = "/home/user/project";
    mockDirEntries = ["notes.tex"];

    render(<AgentsPanel project_id="project-1" layout="page" />);

    await waitFor(() =>
      expect(screen.getByTestId("agents-new-agent-button")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("agents-new-agent-button"));

    await waitFor(() =>
      expect(mockCreateFile).toHaveBeenCalledWith({
        name: "agent",
        ext: "chat",
        current_path: "/home/user/project",
        switch_over: true,
      }),
    );
  });

  it("opens the only chat file in the target folder instead of creating another", async () => {
    mockCurrentPath = "/home/user/project";
    mockDirEntries = ["agent.chat"];

    render(<AgentsPanel project_id="project-1" layout="page" />);

    await waitFor(() =>
      expect(screen.getByTestId("agents-new-agent-button")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("agents-new-agent-button"));

    await waitFor(() =>
      expect(mockOpenFile).toHaveBeenCalledWith({
        path: "/home/user/project/agent.chat",
        foreground: true,
      }),
    );
    expect(mockCreateFile).not.toHaveBeenCalled();
  });

  it("reuses the workspace chat when the target folder belongs to a workspace", async () => {
    mockCurrentPath = "/home/user/project";
    mockWorkspaceCurrent = { workspace_id: "ws-1" };
    mockResolveWorkspaceForPath = jest.fn((_path: string) => ({
      workspace_id: "ws-1",
    }));
    mockEnsureWorkspaceChatPath.mockResolvedValue({
      workspace: { workspace_id: "ws-1" },
      chat_path: "/home/user/.local/share/cocalc/workspaces/acct/ws-1.chat",
      assigned: false,
    });

    render(<AgentsPanel project_id="project-1" layout="page" />);

    await waitFor(() =>
      expect(screen.getByTestId("agents-new-agent-button")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("agents-new-agent-button"));

    await waitFor(() =>
      expect(mockEnsureWorkspaceChatPath).toHaveBeenCalledWith({
        project_id: "project-1",
        account_id: "acct-1",
        workspace_id: "ws-1",
      }),
    );
    expect(mockEnsureWorkspaceChatDirectory).toHaveBeenCalledWith({
      project_id: "project-1",
      chat_path: "/home/user/.local/share/cocalc/workspaces/acct/ws-1.chat",
    });
    expect(mockOpenFile).toHaveBeenCalledWith({
      path: "/home/user/.local/share/cocalc/workspaces/acct/ws-1.chat",
      foreground: true,
    });
    expect(mockCreateFile).not.toHaveBeenCalled();
  });
});
