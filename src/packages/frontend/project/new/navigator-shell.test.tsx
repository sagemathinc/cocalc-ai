/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";

const mockEraseActiveKeyHandler = jest.fn();
const mockMessageApi = {
  success: jest.fn(),
  error: jest.fn(),
};
let mockSharedChatReady = true;
const mockSharedChatActions = {
  syncdb: {
    on: jest.fn(),
    removeListener: jest.fn(),
  },
  isSyncdbReady: jest.fn(() => mockSharedChatReady),
  messageCache: {
    getThreadIndex: () => new Map(),
    on: jest.fn(),
    removeListener: jest.fn(),
  },
  getThreadMetadata: jest.fn(() => ({})),
  setSelectedThread: jest.fn(),
  scrollToIndex: jest.fn(),
} as any;

jest.mock("antd", () => {
  const Div = ({ children }: any) => <div>{children}</div>;
  const Button = ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
  const Input = () => <input />;
  const Select = ({ children }: any) => <div>{children}</div>;
  const Space = ({ children }: any) => <div>{children}</div>;
  Space.Compact = ({ children }: any) => <div>{children}</div>;
  const Typography = {
    Text: ({ children }: any) => <span>{children}</span>,
  };
  const Modal = ({ children, open }: any) =>
    open ? <div>{children}</div> : null;
  Modal.confirm = jest.fn();

  return {
    Alert: Div,
    Button,
    Dropdown: Div,
    Input,
    Modal,
    Select,
    Space,
    Tag: Div,
    Tooltip: Div,
    Typography,
    message: mockMessageApi,
  };
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? { erase_active_key_handler: mockEraseActiveKeyHandler }
        : undefined,
  },
  useActions: () => ({
    open_file: jest.fn(),
  }),
  useTypedRedux: (store: any, key: string) => {
    if (store === "account" && key === "account_id") return "acct-1";
    if (store === "account" && key === "font_size") return 13;
    if (key === "available_features") return {};
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/chat/register", () => ({
  getChatActions: () => mockSharedChatActions,
  initChat: () => mockSharedChatActions,
  removeWithInstance: jest.fn(),
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

jest.mock("@cocalc/frontend/chat/side-chat", () => ({
  __esModule: true,
  default: () => <input data-testid="navigator-composer" />,
}));

jest.mock("@cocalc/frontend/chat/chat-icon-picker", () => ({
  ChatIconPicker: () => null,
}));

jest.mock("@cocalc/frontend/chat/thread-badge", () => ({
  ThreadBadge: () => null,
}));

jest.mock("@cocalc/frontend/chat/thread-image-upload", () => ({
  ThreadImageUpload: () => null,
}));

jest.mock("@cocalc/frontend/chat/agent-session-index", () => ({
  upsertAgentSessionRecord: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading...</div>,
  ThemeEditorModal: () => null,
}));

jest.mock("@cocalc/frontend/components/color-picker", () => ({
  ColorButton: () => null,
}));

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/lib/file-context", () => ({
  FileContext: {
    Provider: ({ children }: any) => children,
  },
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("@cocalc/frontend/project/page/anchor-tag-component", () => ({
  __esModule: true,
  default: () => "a",
}));

jest.mock("@cocalc/frontend/project/page/url-transform", () => ({
  __esModule: true,
  default: () => (value: string) => value,
}));

const {
  NavigatorShell,
  classifyNavigatorCodexError,
  isNavigatorChatInitRetryable,
  resolveSelectedAcpConfig,
  resolveSelectedSessionStatus,
} = require("./navigator-shell");

describe("NavigatorShell keyboard suppression", () => {
  beforeEach(() => {
    mockEraseActiveKeyHandler.mockClear();
    mockMessageApi.success.mockClear();
    mockMessageApi.error.mockClear();
    mockSharedChatReady = true;
    mockSharedChatActions.syncdb.on.mockClear();
    mockSharedChatActions.syncdb.removeListener.mockClear();
    mockSharedChatActions.isSyncdbReady.mockClear();
    mockSharedChatActions.messageCache.on.mockClear();
    mockSharedChatActions.messageCache.removeListener.mockClear();
    mockSharedChatActions.getThreadMetadata.mockClear();
    mockSharedChatActions.setSelectedThread.mockClear();
    mockSharedChatActions.scrollToIndex.mockClear();
  });

  it("clears the active page key handler when focus enters side chat", () => {
    render(<NavigatorShell project_id="project-1" />);

    fireEvent.focus(screen.getByTestId("navigator-composer"));

    expect(mockEraseActiveKeyHandler).toHaveBeenCalledTimes(1);
  });

  it("keeps the navigator chat loading until syncdb is ready", () => {
    mockSharedChatReady = false;

    render(<NavigatorShell project_id="project-1" />);

    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(screen.queryByTestId("navigator-composer")).toBeNull();
  });

  it("uses the live shared chat readiness on rerender if the ready event was missed", () => {
    mockSharedChatReady = false;

    const { rerender } = render(<NavigatorShell project_id="project-1" />);

    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(screen.queryByTestId("navigator-composer")).toBeNull();

    mockSharedChatReady = true;
    rerender(<NavigatorShell project_id="project-1" />);

    expect(screen.queryByText("Loading...")).toBeNull();
    expect(screen.getByTestId("navigator-composer")).toBeTruthy();
  });

  it("prefers latest thread metadata acp_config over stale root-message config", () => {
    const latestConfig = {
      model: "gpt-5.3-codex-spark",
      reasoning: "extra_high",
      sessionMode: "full-access",
      allowWrite: true,
    };
    const actions = {
      getThreadMetadata: jest.fn(() => ({
        acp_config: latestConfig,
      })),
    };

    const resolved = resolveSelectedAcpConfig({
      actions,
      selectedThreadKey: "thread-1",
      selectedRootMessage: {
        thread_id: "thread-1",
        acp_config: {
          model: "gpt-5.3-codex-spark",
          reasoning: "high",
          sessionMode: "auto",
          allowWrite: true,
        },
      },
    });

    expect(actions.getThreadMetadata).toHaveBeenCalledWith("thread-1", {
      threadId: "thread-1",
    });
    expect(resolved).toEqual(latestConfig);
  });

  it("keeps queued or running thread state indexed as running", () => {
    expect(
      resolveSelectedSessionStatus({
        actions: {
          store: {
            get: () => new Map<string, string>([["thread:thread-1", "queue"]]),
          },
        },
        selectedRootMessage: {
          thread_id: "thread-1",
          generating: false,
        },
      }),
    ).toBe("running");
  });

  it("classifies missing Codex auth errors as first-time sign-in", () => {
    expect(
      classifyNavigatorCodexError(
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      ),
    ).toMatchObject({
      kind: "missing-auth",
      title: "Codex is not signed in yet.",
      actionLabel: "Sign in to Codex",
    });
  });

  it("classifies expired Codex auth errors as re-authentication", () => {
    expect(
      classifyNavigatorCodexError(
        "unexpected status 401 Unauthorized: Provided authentication token is expired. Please try signing in again.",
      ),
    ).toMatchObject({
      kind: "expired-auth",
      title: "Codex needs you to sign in again.",
      actionLabel: "Sign in again",
    });
  });

  it("retries Navigator chat initialization while the project is starting", () => {
    expect(
      isNavigatorChatInitRetryable({
        error: "Error: permission denied",
        projectState: "starting",
      }),
    ).toBe(true);
  });

  it("retries transient filesystem initialization errors after startup", () => {
    expect(
      isNavigatorChatInitRetryable({
        error:
          "Cannot safely open /home/user/.local/share/cocalc/navigator.chat: canonical sync identity resolution failed: file server not initialized.",
        projectState: "running",
      }),
    ).toBe(true);
    expect(
      isNavigatorChatInitRetryable({
        error: "Error: invalid path",
        projectState: "running",
      }),
    ).toBe(false);
  });
});
