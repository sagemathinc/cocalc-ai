import { React } from "@cocalc/frontend/app-framework";
import { render } from "@testing-library/react";
import {
  groupThreadsByRecency,
  type ThreadMeta,
  useThreadSections,
} from "../threads";

function makeThread(
  key: string,
  newestTime: number,
  patch: Partial<ThreadMeta> = {},
): ThreadMeta {
  return {
    key,
    label: key,
    displayLabel: key,
    newestTime,
    messageCount: 1,
    hasCustomName: false,
    hasCustomAppearance: false,
    readCount: 1,
    unreadCount: 0,
    isAI: true,
    isAutomation: false,
    isPinned: false,
    isArchived: false,
    ...patch,
  };
}

describe("groupThreadsByRecency", () => {
  it("places automation threads in their own section below Today", () => {
    const now = Date.UTC(2026, 2, 12, 12, 0, 0);
    const sections = groupThreadsByRecency(
      [
        makeThread("today-thread", now - 60_000),
        makeThread("automation-thread", now - 2 * 60_000, {
          isAutomation: true,
          isPinned: true,
        }),
        makeThread("yesterday-thread", now - 26 * 60 * 60_000),
      ],
      { now },
    );

    expect(sections.map((section) => section.key)).toEqual([
      "today",
      "automations",
      "yesterday",
    ]);
    expect(sections[1].threads.map((thread) => thread.key)).toEqual([
      "automation-thread",
    ]);
  });
});

describe("useThreadSections read-state gating", () => {
  function renderThreads(opts: {
    readReady: boolean;
    readCount?: number;
    accountId?: string;
  }) {
    let value: ReturnType<typeof useThreadSections> | undefined;
    const actions = {
      listThreadConfigRows: jest.fn(() => []),
      getThreadMetadata: jest.fn(() => undefined),
      isProjectReadStateReady: jest.fn(() => opts.readReady),
      getThreadReadCount: jest.fn(() => opts.readCount ?? 0),
      isLanguageModelThread: jest.fn(() => false),
    } as any;
    const threadIndex = new Map([
      [
        "thread-1",
        {
          key: "thread-1",
          newestTime: 1000,
          messageCount: 5,
          rootMessage: {
            thread_id: "thread-1",
            date: new Date(1000).toISOString(),
          },
        },
      ],
    ]);
    function Probe() {
      value = useThreadSections({
        messages: new Map(),
        threadIndex: threadIndex as any,
        accountId: opts.accountId ?? "acct",
        actions,
      });
      return null;
    }
    render(React.createElement(Probe));
    return { value: value!, actions };
  }

  it("suppresses unread counts while project read state is still loading", () => {
    const { value, actions } = renderThreads({
      readReady: false,
      readCount: 0,
    });
    expect(actions.getThreadReadCount).not.toHaveBeenCalled();
    expect(value.threads[0].readCount).toBe(0);
    expect(value.threads[0].unreadCount).toBe(0);
  });

  it("shows unread counts once project read state is ready", () => {
    const { value, actions } = renderThreads({
      readReady: true,
      readCount: 2,
    });
    expect(actions.getThreadReadCount).toHaveBeenCalledWith("thread-1", "acct");
    expect(value.threads[0].readCount).toBe(2);
    expect(value.threads[0].unreadCount).toBe(3);
  });
});
