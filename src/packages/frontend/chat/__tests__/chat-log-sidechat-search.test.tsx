/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  clearChatViewportAnchorCacheForTests,
  loadChatViewportAnchor,
  saveChatViewportAnchor,
} from "../chat-scroll-anchor";
import {
  ChatLog,
  measureChatVirtuosoItemHeight,
  MessageList,
} from "../chat-log";

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
        {props.itemContent?.(index, props.data?.[index], props.context)}
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
      <img alt={`message attachment ${index}`} src={`image-${index}.png`} />
    </div>
  ),
}));

jest.mock("../composing", () => ({
  __esModule: true,
  default: () => null,
}));

describe("ChatLog sidechat search jumps", () => {
  it("preserves bottom intent across streaming growth, but records deliberate reading positions", () => {
    jest.useFakeTimers();
    const keepBottomAnchoredRef = { current: false };
    const manualScrollRef = { current: false };
    const props = {
      messages: new Map([
        ["1000", { date: 1000, history: [{ content: "long running turn" }] }],
      ]) as any,
      sortedDates: ["1000"],
      account_id: "acct-1",
      user_map: undefined,
      mode: "sidechat",
      scrollCacheId: "growing-turn",
      keepBottomAnchoredRef,
      manualScrollRef,
    };
    const view = render(<MessageList {...props} />);
    try {
      const scroller = document.createElement("div");
      Object.defineProperties(scroller, {
        clientHeight: { value: 400 },
        scrollHeight: { value: 2000, configurable: true },
        scrollTop: { value: 1600, writable: true },
      });
      scroller.getBoundingClientRect = () =>
        ({ top: 0, bottom: 400 }) as DOMRect;
      const row = document.createElement("div");
      row.dataset.itemIndex = "0";
      row.getBoundingClientRect = () =>
        ({ top: -1600, bottom: 1400 }) as DOMRect;
      scroller.appendChild(row);
      act(() => {
        latestVirtuosoProps.scrollerRef(scroller);
        latestVirtuosoProps.atBottomStateChange(true);
        jest.advanceTimersByTime(2000);
      });
      expect(loadChatViewportAnchor("growing-turn")?.atBottom).toBe(true);

      // The turn grows before the browser/virtualizer catches up to its new bottom.
      Object.defineProperty(scroller, "scrollHeight", { value: 3000 });
      act(() => {
        latestVirtuosoProps.atBottomStateChange(false);
        latestVirtuosoProps.onScroll();
        jest.advanceTimersByTime(20);
      });
      expect(loadChatViewportAnchor("growing-turn")?.atBottom).toBe(true);
      view.rerender(<MessageList {...props} isVisible={false} />);
      mockScrollToIndex.mockClear();
      view.rerender(<MessageList {...props} isVisible />);
      expect(mockScrollToIndex).toHaveBeenCalledWith({
        index: Number.MAX_SAFE_INTEGER,
        behavior: "auto",
      });
      act(() => jest.advanceTimersByTime(1600));
      act(() => {
        fireEvent.wheel(screen.getByTestId("virtuoso").parentElement!, {
          deltaY: -100,
        });
        latestVirtuosoProps.onScroll();
        jest.advanceTimersByTime(20);
      });
      expect(loadChatViewportAnchor("growing-turn")).toEqual(
        expect.objectContaining({
          atBottom: false,
          date: "1000",
          offsetPx: -1600,
        }),
      );
    } finally {
      view.unmount();
      jest.useRealTimers();
    }
  });

  it("does not carry bottom retries across a thread switch after explicit navigation", () => {
    jest.useFakeTimers();
    const scrollToBottomRef = { current: undefined as any };
    const props = {
      project_id: "project-1",
      path: "thread.chat",
      scrollCacheId: "editor",
      messages: new Map([
        ["1000", { date: 1000, history: [{ content: "first" }] }],
        ["2000", { date: 2000, history: [{ content: "second" }] }],
      ]) as any,
      actions: { clearScrollRequest: jest.fn() } as any,
      mode: "sidechat" as const,
      scrollToBottomRef,
    };
    saveChatViewportAnchor(JSON.stringify(["editor", "thread-b"]), {
      atBottom: false,
      date: "1000",
      offsetPx: -5,
      savedAt: Date.now(),
    });
    const view = render(<ChatLog {...props} selectedThread="thread-a" />);
    try {
      view.rerender(
        <ChatLog {...props} selectedThread="thread-a" scrollToIndex={-1} />,
      );
      expect(mockScrollToIndex).toHaveBeenCalled();
      view.rerender(<ChatLog {...props} selectedThread="thread-b" />);
      expect(latestVirtuosoProps.initialTopMostItemIndex).toBe(0);
      expect(mockScrollToIndex).toHaveBeenLastCalledWith({
        index: 0,
        align: "start",
        behavior: "auto",
      });
      mockScrollToIndex.mockClear();
      act(() => jest.advanceTimersByTime(600));
      expect(mockScrollToIndex).not.toHaveBeenCalledWith({
        index: Number.MAX_SAFE_INTEGER,
        behavior: "auto",
      });
    } finally {
      view.unmount();
      jest.useRealTimers();
    }
  });

  it("keeps each thread's reading position when switching away and back", async () => {
    const actions = { clearScrollRequest: jest.fn() } as any;
    const messages = new Map([
      [
        "1000",
        { date: 1000, sender_id: "acct-1", history: [{ content: "first" }] },
      ],
      [
        "2000",
        { date: 2000, sender_id: "acct-1", history: [{ content: "second" }] },
      ],
    ]) as any;
    const props = {
      project_id: "project-1",
      path: "thread.chat",
      scrollCacheId: "editor",
      messages,
      actions,
      mode: "sidechat" as const,
    };
    const view = render(<ChatLog {...props} selectedThread="thread-a" />);
    const firstKey = latestVirtuosoProps.cacheId;
    saveChatViewportAnchor(firstKey, {
      atBottom: true,
      date: "2000",
      offsetPx: 0,
      savedAt: Date.now(),
    });
    view.rerender(<ChatLog {...props} selectedThread="thread-b" />);
    const secondKey = latestVirtuosoProps.cacheId;
    expect(secondKey).not.toBe(firstKey);
    saveChatViewportAnchor(secondKey, {
      atBottom: false,
      date: "1000",
      offsetPx: -5,
      savedAt: Date.now(),
    });
    view.rerender(<ChatLog {...props} selectedThread="thread-a" />);
    expect(latestVirtuosoProps.cacheId).toBe(firstKey);
    expect(latestVirtuosoProps.initialTopMostItemIndex).toBe(1);
    view.rerender(<ChatLog {...props} selectedThread="thread-b" />);
    expect(latestVirtuosoProps.initialTopMostItemIndex).toBe(0);
    view.unmount();
  });
  beforeEach(() => {
    mockScrollToIndex.mockClear();
    clearChatViewportAnchorCacheForTests();
    latestVirtuosoProps = undefined;
    activeTopTab = "project-2";
    activeProjectTab = "editor-some-other.chat";
  });

  it("quantizes Virtuoso item measurements to stable CSS pixels", () => {
    const element = document.createElement("div");
    jest.spyOn(element, "getBoundingClientRect").mockReturnValue({
      bottom: 101.25,
      height: 100.25,
      left: 0,
      right: 100,
      top: 1,
      width: 100,
      x: 0,
      y: 1,
      toJSON: () => ({}),
    });

    expect(measureChatVirtuosoItemHeight(element)).toBe(101);
  });

  it("keeps Virtuoso callbacks stable while chat messages rerender", async () => {
    const manualScrollRef = { current: false };
    const setManualScroll = jest.fn();
    const firstMessages = new Map([
      [
        "1000",
        {
          date: 1000,
          sender_id: "acct-1",
          history: [{ content: "first message" }],
        },
      ],
    ]) as any;
    const commonProps = {
      account_id: "acct-1",
      manualScrollRef,
      mode: "standalone" as const,
      scrollCacheId: "stable-virtuoso-chat",
      setManualScroll,
      user_map: undefined,
    };
    const { rerender } = render(
      <MessageList
        {...commonProps}
        messages={firstMessages}
        sortedDates={["1000"]}
      />,
    );
    await waitFor(() => expect(latestVirtuosoProps).toBeDefined());
    const firstCallbacks = {
      atBottomStateChange: latestVirtuosoProps.atBottomStateChange,
      itemContent: latestVirtuosoProps.itemContent,
      itemSize: latestVirtuosoProps.itemSize,
      onScroll: latestVirtuosoProps.onScroll,
      rangeChanged: latestVirtuosoProps.rangeChanged,
      scrollerRef: latestVirtuosoProps.scrollerRef,
    };
    const firstData = latestVirtuosoProps.data;

    rerender(
      <MessageList
        {...commonProps}
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                sender_id: "acct-1",
                history: [{ content: "first message with streamed suffix" }],
              },
            ],
          ]) as any
        }
        sortedDates={["1000"]}
      />,
    );

    expect(latestVirtuosoProps).toEqual(
      expect.objectContaining(firstCallbacks),
    );
    expect(latestVirtuosoProps.data).not.toBe(firstData);
    expect(latestVirtuosoProps.data[0]).not.toBe(firstData[0]);
  });

  it("restores saved scroll state without a parent Virtuoso ref", async () => {
    saveChatViewportAnchor("timetravel-chat", {
      atBottom: true,
      offsetPx: 0,
      savedAt: Date.now(),
    });

    render(
      <MessageList
        messages={
          new Map([
            [
              "1000",
              {
                date: 1000,
                sender_id: "acct-1",
                history: [{ content: "historical message" }],
              },
            ],
          ]) as any
        }
        account_id="acct-1"
        user_map={undefined}
        mode="standalone"
        sortedDates={["1000"]}
        scrollCacheId="timetravel-chat"
      />,
    );

    expect(screen.getByTestId("virtuoso")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockScrollToIndex).toHaveBeenCalledWith({
        index: Number.MAX_SAFE_INTEGER,
        behavior: "auto",
      }),
    );
  });

  it("restores a saved anchor only after a hidden mounted chat becomes visible", async () => {
    saveChatViewportAnchor("hidden-chat", {
      atBottom: false,
      date: "2000",
      offsetPx: 0,
      savedAt: Date.now(),
    });

    const props = {
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
            sender_id: "acct-1",
            history: [{ content: "second message" }],
          },
        ],
      ]) as any,
      account_id: "acct-1",
      user_map: undefined,
      mode: "standalone" as const,
      sortedDates: ["1000", "2000"],
      scrollCacheId: "hidden-chat",
    };

    const { rerender } = render(<MessageList {...props} isVisible={false} />);

    await waitFor(() => expect(latestVirtuosoProps).toBeDefined());
    expect(mockScrollToIndex).not.toHaveBeenCalled();

    act(() => {
      rerender(<MessageList {...props} isVisible={true} />);
    });

    await waitFor(() =>
      expect(mockScrollToIndex).toHaveBeenCalledWith({
        index: 1,
        align: "start",
        behavior: "auto",
      }),
    );
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
        behavior: "auto",
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

    await waitFor(() => expect(latestVirtuosoProps?.followOutput).toBe(true));
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

    await waitFor(() => expect(latestVirtuosoProps?.followOutput).toBe(true));
    act(() => {
      fireEvent.wheel(screen.getByTestId("virtuoso").parentElement!, {
        deltaY: -100,
      });
      latestVirtuosoProps?.atBottomStateChange?.(false);
    });

    await waitFor(() => expect(latestVirtuosoProps?.followOutput).toBe(false));
  });

  it("treats wheel scrolling over selectable read-only message text as user scroll intent", async () => {
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

    await waitFor(() => expect(latestVirtuosoProps?.followOutput).toBe(true));

    const container = screen.getByTestId("virtuoso").parentElement!;
    const selectableMessage = document.createElement("div");
    selectableMessage.setAttribute("data-chat-selectable-message", "true");
    const readOnlySlate = document.createElement("div");
    readOnlySlate.setAttribute("contenteditable", "true");
    selectableMessage.appendChild(readOnlySlate);
    container.appendChild(selectableMessage);

    act(() => {
      fireEvent.wheel(readOnlySlate, { deltaY: -100 });
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
        behavior: "auto",
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
        behavior: "auto",
      }),
    );
    const initialCalls = mockScrollToIndex.mock.calls.length;
    fireEvent.load(screen.getByAltText("message attachment 1"));
    await waitFor(() =>
      expect(mockScrollToIndex.mock.calls.length).toBeGreaterThan(initialCalls),
    );
  });
});
