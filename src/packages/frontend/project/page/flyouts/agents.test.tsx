/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentsPanel } from "./agents";

const mockOpenFile = jest.fn();
const mockUpsertAgentSessionRecord = jest.fn();
const mockOpenFloatingAgentSession = jest.fn();
const mockChatActions = {
  setSelectedThread: jest.fn(),
  scrollToIndex: jest.fn(),
} as any;

let mockSessions: any[] = [];

jest.mock("antd", () => {
  const Div = ({ children, ...props }: any) => <div {...props}>{children}</div>;
  const Button = ({ children, onClick, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  );
  const Dropdown = ({ children }: any) => children;
  const Empty = ({ description }: any) => <div>{description}</div>;
  const Space = ({ children }: any) => <div>{children}</div>;
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
    Space,
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
      fs: () => ({
        stat: async () => ({ mtimeMs: 1 }),
      }),
    }) as any,
  useTypedRedux: (store: any, key: string) => {
    if (store === "account" && key === "account_id") {
      return "acct-1";
    }
    if (store === "account" && key === "font_size") {
      return 13;
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

jest.mock("@cocalc/frontend/project/page/agent-dock-state", () => ({
  openFloatingAgentSession: (...args: any[]) =>
    mockOpenFloatingAgentSession(...args),
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

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    workspaces: {
      current: null,
      resolveWorkspaceForPath: () => null,
    },
  }),
}));

describe("AgentsPanel session cards", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockOpenFile.mockClear();
    mockUpsertAgentSessionRecord.mockClear();
    mockOpenFloatingAgentSession.mockClear();
    mockChatActions.setSelectedThread.mockClear();
    mockChatActions.scrollToIndex.mockClear();
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

  it("does not open the inline chat when the menu button is clicked", async () => {
    render(<AgentsPanel project_id="project-1" layout="page" />);

    await waitFor(() =>
      expect(screen.getByTestId("agent-session-menu-session-1")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("agent-session-menu-session-1"));

    expect(screen.queryByTestId("agents-inline-chat")).toBeNull();
  });
});
