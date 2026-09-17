/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as immutable from "immutable";
import { ChatPanel } from "../chatroom";

let currentThread = {
  key: "thread-1",
  label: "Thread 1",
  displayLabel: "Thread 1",
  newestTime: 10,
  messageCount: 2,
  hasCustomName: false,
  hasCustomAppearance: false,
  readCount: 1,
  unreadCount: 1,
  isAI: false,
  isPinned: false,
  isArchived: false,
};
let currentThreads = [currentThread];
let currentThreadMetadata: any;
let latestThreadPanelProps: any;
const mockPauseThreadAutomation = jest.fn();
const mockRunThreadAutomationNow = jest.fn();

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useEditorRedux: () => (key: string) => {
      if (key === "activity") return undefined;
      if (key === "acpState") return immutable.Map();
      return undefined;
    },
    useTypedRedux: (...args: any[]) => {
      if (args[0] === "account" && args[1] === "account_id") return "acct";
      return undefined;
    },
  };
});

jest.mock("../threads", () => ({
  useThreadSections: () => ({
    threads: currentThreads.length === 1 ? [currentThread] : currentThreads,
    archivedThreads: [],
    threadSections: [],
  }),
}));

jest.mock("../thread-selection", () => ({
  useChatThreadSelection: () => ({
    selectedThreadKey: currentThread.key,
    setSelectedThreadKey: jest.fn(),
    setAllowAutoSelectThread: jest.fn(),
    singleThreadView: true,
    selectedThread: currentThread,
  }),
}));

jest.mock("../use-chat-composer-draft", () => ({
  useChatComposerAcpPromptDraft: () => ({
    input: "",
    setInput: jest.fn(),
    clearInput: jest.fn(),
    clearComposerDraft: jest.fn(),
  }),
  useChatComposerDraft: () => ({
    input: "",
    setInput: jest.fn(),
    clearInput: jest.fn(),
    clearComposerDraft: jest.fn(),
  }),
}));

jest.mock("../use-codex-payment-source", () => ({
  useCodexPaymentSource: () => ({
    paymentSource: undefined,
    loading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock("../drawer-overlay-state", () => ({
  setChatOverlayOpen: jest.fn(),
  useAnyChatOverlayOpen: () => false,
}));

jest.mock("../acp-api", () => ({
  acknowledgeThreadAutomation: jest.fn(),
  deleteThreadAutomation: jest.fn(),
  pauseThreadAutomation: (...args: any[]) => mockPauseThreadAutomation(...args),
  resumeThreadAutomation: jest.fn(),
  runThreadAutomationNow: (...args: any[]) =>
    mockRunThreadAutomationNow(...args),
  skipNextThreadAutomationRun: jest.fn(),
  upsertThreadAutomation: jest.fn(),
}));

jest.mock("../utils", () => ({
  getMessageByLookup: () => undefined,
  markChatAsReadIfUnseen: jest.fn(),
  stableDraftKeyFromThreadKey: (key: string) => key,
}));

jest.mock("../chatroom-layout", () => ({
  ChatRoomLayout: ({ chatContent }: any) => <div>{chatContent}</div>,
}));

jest.mock("../composer", () => ({
  ChatRoomComposer: () => null,
}));

jest.mock("../chatroom-sidebar", () => ({
  ChatRoomSidebarContent: () => null,
}));

jest.mock("../git-commit-drawer", () => ({
  GitCommitDrawer: () => null,
}));

jest.mock("../chatroom-modals", () => ({
  ChatRoomModals: () => null,
}));

jest.mock("../chatroom-thread-actions", () => ({
  ChatRoomThreadActions: () => null,
}));

jest.mock("../chatroom-thread-panel", () => ({
  ChatRoomThreadPanel: (props: any) => {
    latestThreadPanelProps = props;
    return null;
  },
  getDefaultNewThreadSetup: () => ({
    codexConfig: {
      workingDirectory: "/",
    },
  }),
}));

jest.mock("../agent-session-index", () => ({
  upsertAgentSessionRecord: jest.fn(),
}));

jest.mock("../external-side-chat-selection", () => ({
  persistExternalSideChatSelectedThreadKey: jest.fn(),
}));

describe("ChatPanel selected thread read tracking", () => {
  beforeEach(() => {
    currentThread = {
      key: "thread-1",
      label: "Thread 1",
      displayLabel: "Thread 1",
      newestTime: 10,
      messageCount: 2,
      hasCustomName: false,
      hasCustomAppearance: false,
      readCount: 1,
      unreadCount: 1,
      isAI: false,
      isPinned: false,
      isArchived: false,
    };
    currentThreads = [currentThread];
    currentThreadMetadata = undefined;
    latestThreadPanelProps = undefined;
    mockPauseThreadAutomation.mockReset();
    mockPauseThreadAutomation.mockResolvedValue(undefined);
    mockRunThreadAutomationNow.mockReset();
    mockRunThreadAutomationNow.mockResolvedValue(undefined);
  });

  function renderPanel() {
    const actions = {
      markThreadRead: jest.fn(),
      scrollToIndex: jest.fn(),
      getCodexConfig: jest.fn(),
      getThreadMetadata: jest.fn(() => currentThreadMetadata),
      getMessagesInThread: jest.fn(() => []),
      frameTreeActions: undefined,
      frameId: undefined,
    } as any;

    const result = render(
      <ChatPanel
        actions={actions}
        project_id="project-1"
        path="chat/test.chat"
        messages={new Map()}
        threadIndex={undefined}
        docVersion={0}
      />,
    );
    return { actions, ...result };
  }

  it("marks the selected thread read when it has unread messages", () => {
    const { actions } = renderPanel();

    expect(actions.markThreadRead).toHaveBeenCalledTimes(1);
    expect(actions.markThreadRead).toHaveBeenCalledWith("thread-1", 2);
  });

  it("lets ChatLog restore its viewport when switching threads instead of forcing the bottom", () => {
    const { actions, rerender } = renderPanel();
    expect(actions.scrollToIndex).not.toHaveBeenCalled();
    for (const key of ["thread-2", "thread-1"]) {
      currentThread = { ...currentThread, key };
      currentThreads = [currentThread];
      rerender(
        <ChatPanel
          actions={actions}
          project_id="project-1"
          path="chat/test.chat"
          messages={new Map()}
          threadIndex={undefined}
          docVersion={0}
        />,
      );
      expect(actions.scrollToIndex).not.toHaveBeenCalled();
    }
  });

  it("makes resolved thread messages read-only", () => {
    currentThreadMetadata = {
      resolved: {
        account_id: "acct",
        at: "2026-07-29T00:00:00.000Z",
        anchorId: "cell-1",
      },
    };

    renderPanel();

    expect(latestThreadPanelProps.readOnly).toBe(true);
  });

  it("keeps automation controls interactive above adjacent chat surfaces", async () => {
    currentThreadMetadata = {
      automation_config: {
        enabled: true,
        title: "Review pull requests",
        prompt: "Review open pull requests",
        schedule_type: "interval",
        interval_minutes: 240,
        timezone: "UTC",
      },
      automation_state: {
        status: "active",
        next_run_at_ms: Date.now() + 60_000,
        unacknowledged_runs: 1,
      },
    };

    renderPanel();

    const controls = screen.getByRole("region", {
      name: "Thread automation controls",
    });
    expect(controls).toHaveStyle({
      flexShrink: "0",
      position: "relative",
      zIndex: "1",
    });

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(
      screen.getByText(/Run now does not skip the next scheduled run/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(mockPauseThreadAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread-1" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() =>
      expect(mockRunThreadAutomationNow).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread-1" }),
      ),
    );
  });

  it("does not mark another unread thread when opening the selected one", () => {
    currentThreads = [
      currentThread,
      {
        ...currentThread,
        key: "thread-2",
        label: "Thread 2",
        displayLabel: "Thread 2",
        messageCount: 4,
        unreadCount: 2,
      },
    ];

    const { actions } = renderPanel();

    expect(actions.markThreadRead).toHaveBeenCalledTimes(1);
    expect(actions.markThreadRead).toHaveBeenCalledWith("thread-1", 2);
    expect(actions.markThreadRead).not.toHaveBeenCalledWith(
      "thread-2",
      expect.anything(),
    );
  });

  it("marks the selected thread read again when unread state advances", () => {
    const { actions, rerender } = renderPanel();
    actions.markThreadRead.mockClear();

    currentThread = {
      ...currentThread,
      messageCount: 3,
      unreadCount: 1,
      newestTime: 11,
    };

    rerender(
      <ChatPanel
        actions={actions}
        project_id="project-1"
        path="chat/test.chat"
        messages={new Map()}
        threadIndex={undefined}
        docVersion={1}
      />,
    );

    expect(actions.markThreadRead).toHaveBeenCalledTimes(1);
    expect(actions.markThreadRead).toHaveBeenCalledWith("thread-1", 3);
  });

  it("retries marking the selected thread read when the watermark is not ready yet", () => {
    currentThread = {
      ...currentThread,
      messageCount: 0,
      unreadCount: 0,
    };
    const { actions, rerender } = renderPanel();
    actions.markThreadRead.mockReset();
    actions.markThreadRead
      .mockImplementationOnce(() => false)
      .mockImplementation(() => true);
    currentThread = {
      ...currentThread,
      messageCount: 2,
      unreadCount: 1,
    };

    rerender(
      <ChatPanel
        actions={actions}
        project_id="project-1"
        path="chat/test.chat"
        messages={new Map()}
        threadIndex={undefined}
        docVersion={1}
      />,
    );

    rerender(
      <ChatPanel
        actions={actions}
        project_id="project-1"
        path="chat/test.chat"
        messages={new Map()}
        threadIndex={undefined}
        docVersion={2}
      />,
    );

    expect(actions.markThreadRead).toHaveBeenCalledTimes(2);
    expect(actions.markThreadRead).toHaveBeenNthCalledWith(1, "thread-1", 2);
    expect(actions.markThreadRead).toHaveBeenNthCalledWith(2, "thread-1", 2);
  });
});
