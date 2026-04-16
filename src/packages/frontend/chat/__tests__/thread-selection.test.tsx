/** @jest-environment jsdom */

import { act, render } from "@testing-library/react";
import {
  resetThreadSelectionForNewChat,
  useChatThreadSelection,
} from "../thread-selection";
import type { ThreadMeta } from "../threads";

describe("useChatThreadSelection", () => {
  it("clears the selected message fragment when starting a new chat", () => {
    const calls: string[] = [];
    resetThreadSelectionForNewChat({
      actions: {
        setFragment: () => {
          calls.push("clear-fragment");
        },
      } as any,
      setAllowAutoSelectThread: (value) => {
        calls.push(`allow:${value}`);
      },
      setSelectedThreadKey: (value) => {
        calls.push(`thread:${value}`);
      },
    });

    expect(calls).toEqual(["allow:false", "clear-fragment", "thread:null"]);
  });

  it("preserves an explicit requested thread key while thread metadata is temporarily empty", () => {
    const actions = {
      clearAllFilters: jest.fn(),
      setFragment: jest.fn(),
      setSelectedThread: jest.fn(),
    } as any;

    let latest: any = null;

    function Harness({
      threads,
      storedThreadFromDesc,
    }: {
      threads: ThreadMeta[];
      storedThreadFromDesc: string | null;
    }) {
      latest = useChatThreadSelection({
        actions,
        threads,
        messages: undefined,
        fragmentId: null,
        storedThreadFromDesc,
      });
      return null;
    }

    const threads: ThreadMeta[] = [
      {
        key: "100",
        label: "Thread 100",
        displayLabel: "Thread 100",
        newestTime: 100,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 0,
        unreadCount: 1,
        isAI: false,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
      },
    ];

    const { rerender } = render(
      <Harness threads={threads} storedThreadFromDesc={"100"} />,
    );
    expect(latest.selectedThreadKey).toBe("100");

    // Simulate transient empty thread metadata during hydration.
    act(() => {
      rerender(<Harness threads={[]} storedThreadFromDesc={"100"} />);
    });
    expect(latest.selectedThreadKey).toBe("100");
  });

  it("does not fall back to a different thread while a concrete selected thread is temporarily missing", () => {
    const actions = {
      clearAllFilters: jest.fn(),
      setFragment: jest.fn(),
      setSelectedThread: jest.fn(),
    } as any;

    let latest: any = null;

    function Harness({ threads }: { threads: ThreadMeta[] }) {
      latest = useChatThreadSelection({
        actions,
        threads,
        messages: undefined,
        fragmentId: null,
        storedThreadFromDesc: null,
      });
      return null;
    }

    const threads: ThreadMeta[] = [
      {
        key: "100",
        label: "Thread 100",
        displayLabel: "Thread 100",
        newestTime: 100,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 0,
        unreadCount: 1,
        isAI: false,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
      },
    ];

    const { rerender } = render(<Harness threads={threads} />);
    expect(latest.selectedThreadKey).toBe("100");

    act(() => {
      latest.setSelectedThreadKey("200");
    });
    expect(latest.selectedThreadKey).toBe("200");

    // Simulate async lag where thread metadata has not yet included key=200.
    act(() => {
      rerender(<Harness threads={threads} />);
    });
    expect(latest.selectedThreadKey).toBe("200");
  });

  it("auto-selects the latest thread only once", () => {
    const actions = {
      clearAllFilters: jest.fn(),
      setFragment: jest.fn(),
      setSelectedThread: jest.fn(),
    } as any;

    function Harness({ threads }: { threads: ThreadMeta[] }) {
      useChatThreadSelection({
        actions,
        threads,
        messages: undefined,
        fragmentId: null,
        storedThreadFromDesc: null,
      });
      return null;
    }

    const threads: ThreadMeta[] = [
      {
        key: "100",
        label: "Thread 100",
        displayLabel: "Thread 100",
        newestTime: 100,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 0,
        unreadCount: 1,
        isAI: false,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
      },
    ];

    const { rerender } = render(<Harness threads={threads} />);
    rerender(<Harness threads={threads} />);
    rerender(<Harness threads={threads} />);

    expect(actions.setSelectedThread).toHaveBeenCalledTimes(1);
    expect(actions.setSelectedThread).toHaveBeenCalledWith("100");
    expect(actions.clearAllFilters).toHaveBeenCalledTimes(1);
    expect(actions.setFragment).toHaveBeenCalledTimes(1);
  });

  it("syncs external selected-thread changes without re-emitting selection side effects", () => {
    const actions = {
      clearAllFilters: jest.fn(),
      setFragment: jest.fn(),
      setSelectedThread: jest.fn(),
    } as any;

    let latest: any = null;

    function Harness({
      threads,
      storedThreadFromDesc,
    }: {
      threads: ThreadMeta[];
      storedThreadFromDesc: string | null;
    }) {
      latest = useChatThreadSelection({
        actions,
        threads,
        messages: undefined,
        fragmentId: null,
        storedThreadFromDesc,
      });
      return null;
    }

    const threads: ThreadMeta[] = [
      {
        key: "fork-thread",
        label: "Fork thread",
        displayLabel: "Fork thread",
        newestTime: 200,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 0,
        unreadCount: 0,
        isAI: false,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
      },
      {
        key: "source-thread",
        label: "Source thread",
        displayLabel: "Source thread",
        newestTime: 100,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 0,
        unreadCount: 0,
        isAI: false,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
      },
    ];

    const { rerender } = render(
      <Harness threads={threads} storedThreadFromDesc={"fork-thread"} />,
    );
    expect(latest.selectedThreadKey).toBe("fork-thread");

    act(() => {
      rerender(
        <Harness threads={threads} storedThreadFromDesc={"source-thread"} />,
      );
    });

    expect(latest.selectedThreadKey).toBe("source-thread");
    expect(actions.setSelectedThread).not.toHaveBeenCalled();
    expect(actions.clearAllFilters).not.toHaveBeenCalled();
    expect(actions.setFragment).not.toHaveBeenCalled();
  });

  it("applies fragment-driven thread selection only once per fragment target", () => {
    const actions = {
      clearAllFilters: jest.fn(),
      setFragment: jest.fn(),
      setSelectedThread: jest.fn(),
    } as any;

    let latest: any = null;

    function Harness({
      messages,
      fragmentId,
    }: {
      messages: Map<string, any>;
      fragmentId: string | null;
    }) {
      latest = useChatThreadSelection({
        actions,
        threads: [
          {
            key: "thread-1",
            label: "Thread 1",
            displayLabel: "Thread 1",
            newestTime: 100,
            messageCount: 1,
            hasCustomName: false,
            hasCustomAppearance: false,
            readCount: 0,
            unreadCount: 1,
            isAI: false,
            isAutomation: false,
            isPinned: false,
            isArchived: false,
          },
        ],
        messages,
        fragmentId,
        storedThreadFromDesc: null,
      });
      return null;
    }

    const messageDate = "100";
    const makeMessages = () =>
      new Map([
        [
          messageDate,
          {
            sender_id: "acct",
            event: "chat",
            history: [
              { author_id: "acct", content: "hello", date: messageDate },
            ],
            date: new Date(Number(messageDate)),
            thread_id: "thread-1",
          },
        ],
      ]);

    const { rerender } = render(
      <Harness messages={makeMessages()} fragmentId={messageDate} />,
    );

    expect(latest.selectedThreadKey).toBe("thread-1");

    act(() => {
      latest.setSelectedThreadKey(null);
    });
    expect(latest.selectedThreadKey).toBe(null);

    act(() => {
      rerender(<Harness messages={makeMessages()} fragmentId={messageDate} />);
    });
    expect(latest.selectedThreadKey).toBe(null);
  });
});
