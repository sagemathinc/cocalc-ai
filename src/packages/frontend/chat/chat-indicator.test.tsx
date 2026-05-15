/** @jest-environment jsdom */

import { act, render, waitFor } from "@testing-library/react";
import { ChatIndicator } from "./chat-indicator";

const mockEnsureSideChatActions = jest.fn();
const mockHasUnreadSideChat = jest.fn(() => false);

jest.mock("antd", () => ({
  Button: ({ children, danger: _danger, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock("lodash", () => ({
  debounce: (fn: any) => fn,
}));

jest.mock("react-intl", () => ({
  FormattedMessage: ({ defaultMessage }: any) => defaultMessage,
  useIntl: () => ({
    formatMessage: (value: any) => value?.defaultMessage ?? "Chat",
  }),
}));

jest.mock("@cocalc/frontend/account/avatar/users-viewing", () => ({
  UsersViewing: () => null,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({
      close_chat: jest.fn(),
      open_chat: jest.fn(),
    }),
  },
  useTypedRedux: (_store: string, key: string) =>
    key === "account_id" ? "acct-1" : undefined,
}));

jest.mock("@cocalc/frontend/components", () => ({
  HiddenXS: ({ children }: any) => <>{children}</>,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/user-tracking", () => jest.fn());

jest.mock("../i18n", () => ({
  labels: {
    chat: { defaultMessage: "Chat" },
  },
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: true,
}));

jest.mock("./unread", () => ({
  ensureSideChatActions: (...args: any[]) => mockEnsureSideChatActions(...args),
  hasUnreadSideChat: (...args: any[]) => mockHasUnreadSideChat(...args),
}));

function createMockChatActions(id: string, initialState = "ready") {
  let state = initialState;
  const onceHandlers = new Map<string, Set<(...args: any[]) => void>>();
  return {
    __id: id,
    store: {
      on: jest.fn(),
      removeListener: jest.fn(),
    },
    syncdb: {
      get_state: jest.fn(() => state),
      once: jest.fn((event: string, cb: (...args: any[]) => void) => {
        const handlers = onceHandlers.get(event) ?? new Set();
        handlers.add(cb);
        onceHandlers.set(event, handlers);
      }),
      removeListener: jest.fn((event: string, cb: (...args: any[]) => void) => {
        onceHandlers.get(event)?.delete(cb);
      }),
      emitClose: () => {
        state = "closed";
        for (const cb of Array.from(onceHandlers.get("close") ?? [])) {
          cb();
        }
        onceHandlers.get("close")?.clear();
      },
    },
  } as any;
}

describe("ChatIndicator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reacquires side-chat actions after the syncdb closes", async () => {
    const firstActions = createMockChatActions("first");
    const secondActions = createMockChatActions("second");
    mockEnsureSideChatActions
      .mockReturnValueOnce(firstActions)
      .mockReturnValueOnce(secondActions);

    render(<ChatIndicator project_id="project-1" path="/home/user/notes.md" />);

    await waitFor(() =>
      expect(mockEnsureSideChatActions).toHaveBeenCalledWith(
        "project-1",
        "/home/user/notes.md",
      ),
    );

    act(() => {
      firstActions.syncdb.emitClose();
    });

    await waitFor(() =>
      expect(mockEnsureSideChatActions).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(mockHasUnreadSideChat).toHaveBeenLastCalledWith({
        actions: secondActions,
        account_id: "acct-1",
      }),
    );
  });

  it("does not crash when side-chat initialization is temporarily unavailable", async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const actions = createMockChatActions("retry");
      mockEnsureSideChatActions
        .mockImplementationOnce(() => {
          throw new Error("routing unavailable");
        })
        .mockReturnValueOnce(actions);

      render(
        <ChatIndicator project_id="project-1" path="/home/user/notes.md" />,
      );

      await act(async () => {});
      expect(mockEnsureSideChatActions).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "failed to initialize side chat actions",
        expect.objectContaining({
          project_id: "project-1",
          path: "/home/user/notes.md",
        }),
      );

      act(() => {
        jest.advanceTimersByTime(3000);
      });
      await act(async () => {});

      expect(mockEnsureSideChatActions).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(mockHasUnreadSideChat).toHaveBeenLastCalledWith({
          actions,
          account_id: "acct-1",
        }),
      );
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});
