/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";

const mockEraseActiveKeyHandler = jest.fn();
const mockMessageApi = {
  success: jest.fn(),
  error: jest.fn(),
};
const mockGetChatActions = jest.fn();
const mockInitChat = jest.fn();
const mockRemoveWithInstance = jest.fn();
let mockSharedChatReady = true;

function createMockSharedChatActions(id = "shared") {
  let closed = false;
  const onceHandlers = new Map<string, Set<(...args: any[]) => void>>();
  const onHandlers = new Map<string, Set<(...args: any[]) => void>>();
  return {
    __id: id,
    syncdb: {
      on: jest.fn((event: string, cb: (...args: any[]) => void) => {
        const handlers = onHandlers.get(event) ?? new Set();
        handlers.add(cb);
        onHandlers.set(event, handlers);
      }),
      once: jest.fn((event: string, cb: (...args: any[]) => void) => {
        const handlers = onceHandlers.get(event) ?? new Set();
        handlers.add(cb);
        onceHandlers.set(event, handlers);
      }),
      removeListener: jest.fn((event: string, cb: (...args: any[]) => void) => {
        onHandlers.get(event)?.delete(cb);
        onceHandlers.get(event)?.delete(cb);
      }),
      emitClose: () => {
        closed = true;
        for (const cb of Array.from(onHandlers.get("close") ?? [])) {
          cb();
        }
        for (const cb of Array.from(onceHandlers.get("close") ?? [])) {
          cb();
        }
        onceHandlers.get("close")?.clear();
      },
    },
    isSyncdbReady: jest.fn(() => !closed && mockSharedChatReady),
    messageCache: {
      getThreadIndex: () => new Map(),
      on: jest.fn(),
      removeListener: jest.fn(),
    },
    getThreadMetadata: jest.fn(() => ({})),
    setSelectedThread: jest.fn(),
    scrollToIndex: jest.fn(),
  } as any;
}

let mockSharedChatActions = createMockSharedChatActions();

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
  getChatActions: (...args: any[]) => mockGetChatActions(...args),
  initChat: (...args: any[]) => mockInitChat(...args),
  removeWithInstance: (...args: any[]) => mockRemoveWithInstance(...args),
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

jest.mock("@cocalc/frontend/project/start-button", () => ({
  StartButton: ({ project_id }: { project_id: string }) => (
    <button type="button">Start {project_id}</button>
  ),
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
    mockGetChatActions.mockReset();
    mockInitChat.mockReset();
    mockRemoveWithInstance.mockReset();
    mockSharedChatReady = true;
    mockSharedChatActions = createMockSharedChatActions();
    mockGetChatActions.mockReturnValue(mockSharedChatActions);
    mockInitChat.mockReturnValue(mockSharedChatActions);
    mockSharedChatActions.syncdb.on.mockClear();
    mockSharedChatActions.syncdb.once.mockClear();
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

  it("recreates navigator chat immediately after syncdb close even without running project state", async () => {
    const firstActions = createMockSharedChatActions("first");
    const secondActions = createMockSharedChatActions("second");
    mockGetChatActions.mockReturnValue(firstActions);
    mockInitChat.mockReturnValue(secondActions);

    render(<NavigatorShell project_id="project-1" />);

    expect(screen.getByTestId("navigator-composer")).toBeTruthy();

    act(() => {
      fireEvent.focus(screen.getByTestId("navigator-composer"));
      firstActions.syncdb.emitClose();
    });

    expect(mockRemoveWithInstance).toHaveBeenCalledWith(
      "/home/user/.local/share/cocalc/navigator-acct-1.chat",
      expect.anything(),
      "project-1",
      { instanceKey: "navigator-shell" },
    );
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

  it("classifies internal openat2 initialization failures as filesystem unavailable", () => {
    expect(
      classifyNavigatorCodexError(
        "Error: openat2 is required in safe mode (native addon initialization failed). To explicitly disable openat2 and accept fallback behavior, set COCALC_SANDBOX_OPENAT2=off.",
      ),
    ).toMatchObject({
      kind: "other",
      title: "Project filesystem is not available right now.",
      description:
        "If this project is archived, start it to restore it from backup. If it is stopped, files are still available; start it only for terminals, Jupyter, or running Codex turns.",
    });
  });

  it("classifies missing project volume errors as start-required", () => {
    expect(
      classifyNavigatorCodexError(
        "Error: project volume does not exist: /mnt/cocalc/project-1",
      ),
    ).toMatchObject({
      kind: "missing-volume",
      title: "Project files are not available on this host yet.",
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

  it("does not retry missing project volume errors indefinitely", () => {
    expect(
      isNavigatorChatInitRetryable({
        error: "Error: project volume does not exist: /mnt/cocalc/project-1",
        projectState: "starting",
      }),
    ).toBe(false);
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

  it("retries transient closed filesystem errors after startup", () => {
    expect(
      isNavigatorChatInitRetryable({
        error: "Error: closed",
        projectState: "running",
      }),
    ).toBe(true);
    expect(
      isNavigatorChatInitRetryable({
        error: 'Error: once: "info" not emitted before "closed"',
        projectState: "running",
      }),
    ).toBe(true);
  });
});
