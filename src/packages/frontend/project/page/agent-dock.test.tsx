/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AGENT_DOCK_OPEN_EVENT } from "./agent-dock-state";

const mockEraseActiveKeyHandler = jest.fn();
const mockChatActions = {
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
  const Select = ({ children }: any) => <div>{children}</div>;
  const Space = ({ children }: any) => <div>{children}</div>;

  return {
    Alert: Div,
    Button,
    Select,
    Space,
    Tooltip: Div,
  };
});

jest.mock("react-draggable", () => ({
  __esModule: true,
  default: ({ children }: any) => children,
}));

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
    if (store === "account" && key === "font_size") return 13;
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/chat/agent-session-index", () => ({
  watchAgentSessionsForProject: async (_args: any, cb: (records: any[]) => void) => {
    cb([]);
    return () => undefined;
  },
}));

jest.mock("@cocalc/frontend/chat/register", () => ({
  getChatActions: () => mockChatActions,
  initChat: () => mockChatActions,
  removeWithInstance: jest.fn(),
}));

jest.mock("@cocalc/frontend/chat/side-chat", () => ({
  __esModule: true,
  default: () => <input data-testid="agent-dock-composer" />,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading...</div>,
}));

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/lib/file-context", () => ({
  FileContext: {
    Provider: ({ children }: any) => children,
  },
}));

jest.mock("@cocalc/frontend/project/page/anchor-tag-component", () => ({
  __esModule: true,
  default: () => "a",
}));

jest.mock("@cocalc/frontend/project/page/url-transform", () => ({
  __esModule: true,
  default: () => (value: string) => value,
}));

jest.mock("./agent-chat-font-size", () => ({
  useAgentChatFontSize: () => ({
    fontSize: 13,
    increaseFontSize: jest.fn(),
    decreaseFontSize: jest.fn(),
    canIncreaseFontSize: true,
    canDecreaseFontSize: true,
  }),
}));

const { AgentDock } = require("./agent-dock");

describe("AgentDock keyboard suppression", () => {
  beforeEach(() => {
    mockEraseActiveKeyHandler.mockClear();
    mockChatActions.setSelectedThread.mockClear();
    mockChatActions.scrollToIndex.mockClear();
  });

  it("clears the active page key handler when focus enters the floating dock", async () => {
    render(<AgentDock project_id="project-1" is_active={true} />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_DOCK_OPEN_EVENT, {
          detail: {
            projectId: "project-1",
            session: {
              session_id: "session-1",
              chat_path: ".local/share/cocalc/navigator-acct.chat",
              thread_key: "thread-1",
              title: "Agent session",
            },
          },
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId("agent-dock-composer")).toBeTruthy(),
    );

    fireEvent.focus(screen.getByTestId("agent-dock-composer"));

    expect(mockEraseActiveKeyHandler).toHaveBeenCalledTimes(1);
  });
});
