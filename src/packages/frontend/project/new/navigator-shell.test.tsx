/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";

const mockEraseActiveKeyHandler = jest.fn();
const mockMessageApi = {
  success: jest.fn(),
  error: jest.fn(),
};
const mockSharedChatActions = {
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
  resolveSelectedAcpConfig,
} = require("./navigator-shell");

describe("NavigatorShell keyboard suppression", () => {
  beforeEach(() => {
    mockEraseActiveKeyHandler.mockClear();
    mockMessageApi.success.mockClear();
    mockMessageApi.error.mockClear();
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
});
