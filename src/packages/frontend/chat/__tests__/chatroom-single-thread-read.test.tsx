/** @jest-environment jsdom */

import { render } from "@testing-library/react";
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
  COMBINED_FEED_KEY: "__COMBINED_FEED__",
  useThreadSections: () => ({
    threads: [currentThread],
    archivedThreads: [],
    combinedThread: undefined,
    threadSections: [],
  }),
}));

jest.mock("../thread-selection", () => ({
  useChatThreadSelection: () => ({
    selectedThreadKey: "thread-1",
    setSelectedThreadKey: jest.fn(),
    setAllowAutoSelectThread: jest.fn(),
    isCombinedFeedSelected: false,
    singleThreadView: true,
    selectedThread: currentThread,
  }),
}));

jest.mock("../use-chat-composer-draft", () => ({
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
  ChatRoomThreadPanel: () => null,
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

jest.mock("../combined-composer-target", () => {
  const actual = jest.requireActual("../combined-composer-target");
  return {
    ...actual,
    resolveCombinedComposerTargetKey: () => null,
    combinedComposerTargetStorageKey: () => "combined-target:test",
  };
});

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
  });

  function renderPanel() {
    const actions = {
      markThreadRead: jest.fn(),
      scrollToIndex: jest.fn(),
      getCodexConfig: jest.fn(),
      getThreadMetadata: jest.fn(),
      getMessagesInThread: jest.fn(() => []),
      getThreadLoopConfig: jest.fn(),
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
});
