/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ChatLog } from "../chat-log";

const mockScrollToIndex = jest.fn();
let activeTopTab = "project-2";
let activeProjectTab = "editor-some-other.chat";
let latestVirtuosoProps: any;

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (arg1: any, arg2?: string) => {
    if (arg1 === "page" && arg2 === "active_top_tab") {
      return activeTopTab;
    }
    if (
      typeof arg1 === "object" &&
      arg1?.project_id === "project-1" &&
      arg2 === "active_project_tab"
    ) {
      return activeProjectTab;
    }
    if (arg1 === "account" && arg2 === "account_id") {
      return "acct-1";
    }
    if (arg1 === "users" && arg2 === "user_map") {
      return undefined;
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/components/stateful-virtuoso", () => {
  const React = require("react");
  return React.forwardRef((props: any, ref: any) => {
    latestVirtuosoProps = props;
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: mockScrollToIndex,
      scrollIntoView: jest.fn(),
      getState: jest.fn(),
    }));
    const items = Array.from({ length: props.totalCount ?? 0 }, (_, index) => (
      <div key={index} data-item-index={index}>
        {props.itemContent?.(index)}
      </div>
    ));
    return (
      <div data-testid="virtuoso">
        <div data-virtuoso-scroller>{items}</div>
      </div>
    );
  });
});

jest.mock("@cocalc/frontend/jupyter/div-temp-height", () => ({
  DivTempHeight: ({ children }: any) => <>{children}</>,
}));

jest.mock("../drawer-overlay-state", () => ({
  setChatOverlayOpen: jest.fn(),
  useAnyChatOverlayOpen: () => false,
}));

jest.mock("../message", () => ({
  __esModule: true,
  default: ({ index }: any) => (
    <div>
      message {index}
      <img alt={`message-image-${index}`} src={`image-${index}.png`} />
    </div>
  ),
}));

jest.mock("../composing", () => ({
  __esModule: true,
  default: () => null,
}));

describe("ChatLog sidechat search jumps", () => {
  beforeEach(() => {
    mockScrollToIndex.mockClear();
    latestVirtuosoProps = undefined;
    activeTopTab = "project-2";
    activeProjectTab = "editor-some-other.chat";
  });

  it("scrolls to a search match in sidechat even when it is not the active editor tab", async () => {
    render(
      <ChatLog
        project_id="project-1"
        path=".local/share/cocalc/navigator.chat"
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                sender_id: "acct-1",
                history: [{ content: "first 123 message" }],
              },
            ],
            [
              "2000",
              {
                date: 2000,
                sender_id: "acct-1",
                history: [{ content: "second message" }],
              },
            ],
          ]) as any
        }
        mode="sidechat"
        actions={{} as any}
        selectedThread="thread-1"
        searchJumpDate="1000"
        searchJumpToken={1}
      />,
    );

    await waitFor(() =>
      expect(mockScrollToIndex).toHaveBeenCalledWith({
        index: 0,
        align: "center",
      }),
    );
  });

  it("does not force-scroll to the bottom when a generating chat tab returns to the foreground", async () => {
    const scrollToBottomRef = { current: undefined as any };
    const props = {
      project_id: "project-1",
      path: "thread.chat",
      messages: new Map([
        [
          "1000",
          {
            date: 1000,
            sender_id: "acct-1",
            history: [{ content: "first message" }],
          },
        ],
        [
          "2000",
          {
            date: 2000,
            sender_id: "acct-2",
            generating: true,
            history: [{ content: "streaming output" }],
          },
        ],
      ]) as any,
      mode: "standalone" as const,
      actions: {
        clearScrollRequest: jest.fn(),
      } as any,
      selectedThread: "thread-1",
      scrollToBottomRef,
    };

    const { rerender } = render(<ChatLog {...props} />);

    await waitFor(() => expect(scrollToBottomRef.current).toBeDefined());
    expect(mockScrollToIndex).not.toHaveBeenCalled();
    expect(latestVirtuosoProps?.persistState).toBe(false);

    act(() => {
      activeTopTab = "project-1";
      activeProjectTab = "editor-thread.chat";
      rerender(<ChatLog {...props} />);
    });

    await waitFor(() =>
      expect(latestVirtuosoProps?.followOutput).toBe("smooth"),
    );
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it("stops following output after the user scrolls away", async () => {
    activeTopTab = "project-1";
    activeProjectTab = "editor-thread.chat";
    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                sender_id: "acct-1",
                history: [{ content: "first message" }],
              },
            ],
            [
              "2000",
              {
                date: 2000,
                sender_id: "acct-2",
                generating: true,
                history: [{ content: "streaming output" }],
              },
            ],
          ]) as any
        }
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
      />,
    );

    await waitFor(() =>
      expect(latestVirtuosoProps?.followOutput).toBe("smooth"),
    );
    act(() => {
      fireEvent.wheel(screen.getByTestId("virtuoso").parentElement!, {
        deltaY: -100,
      });
      latestVirtuosoProps?.atBottomStateChange?.(false);
    });

    await waitFor(() => expect(latestVirtuosoProps?.followOutput).toBe(false));
  });

  it("shows a newest messages button when the thread is not at the bottom", async () => {
    activeTopTab = "project-1";
    activeProjectTab = "editor-thread.chat";
    const scrollToBottomRef = { current: undefined as any };

    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                sender_id: "acct-1",
                history: [{ content: "first message" }],
              },
            ],
            [
              "2000",
              {
                date: 2000,
                sender_id: "acct-2",
                history: [{ content: "newest message" }],
              },
            ],
          ]) as any
        }
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        scrollToBottomRef={scrollToBottomRef}
      />,
    );

    await waitFor(() => expect(scrollToBottomRef.current).toBeDefined());
    expect(screen.queryByRole("button", { name: /newest messages/i })).toBe(
      null,
    );

    act(() => {
      latestVirtuosoProps?.atBottomStateChange?.(false);
    });

    const button = await screen.findByRole("button", {
      name: /newest messages/i,
    });
    fireEvent.click(button);

    await waitFor(() =>
      expect(mockScrollToIndex).toHaveBeenCalledWith({
        index: Number.MAX_SAFE_INTEGER,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /newest messages/i })).toBe(
        null,
      ),
    );
  });

  it("re-applies bottom scroll after an image loads in a bottom-anchored thread", async () => {
    activeTopTab = "project-1";
    activeProjectTab = "editor-thread.chat";
    const scrollToBottomRef = { current: undefined as any };

    render(
      <ChatLog
        project_id="project-1"
        path="thread.chat"
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                sender_id: "acct-1",
                history: [{ content: "first message" }],
              },
            ],
            [
              "2000",
              {
                date: 2000,
                sender_id: "acct-2",
                history: [{ content: "second message" }],
              },
            ],
          ]) as any
        }
        mode="standalone"
        actions={{ clearScrollRequest: jest.fn() } as any}
        selectedThread="thread-1"
        scrollToBottomRef={scrollToBottomRef}
      />,
    );

    await waitFor(() => expect(scrollToBottomRef.current).toBeDefined());
    act(() => {
      scrollToBottomRef.current(true);
    });
    await waitFor(() =>
      expect(mockScrollToIndex).toHaveBeenCalledWith({
        index: Number.MAX_SAFE_INTEGER,
      }),
    );
    const initialCalls = mockScrollToIndex.mock.calls.length;
    fireEvent.load(screen.getByAltText("message-image-1"));
    await waitFor(() =>
      expect(mockScrollToIndex.mock.calls.length).toBeGreaterThan(initialCalls),
    );
  });
});
