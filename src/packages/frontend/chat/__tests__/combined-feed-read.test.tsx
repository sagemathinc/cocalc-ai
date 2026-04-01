/** @jest-environment jsdom */

import { fireEvent, render } from "@testing-library/react";
import * as immutable from "immutable";
import { ChatPanel } from "../chatroom";

const markChatAsReadIfUnseen = jest.fn();

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
    threads: [
      {
        key: "t1",
        label: "Thread 1",
        displayLabel: "Thread 1",
        newestTime: 10,
        messageCount: 5,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 0,
        unreadCount: 2,
        isAI: false,
        isPinned: false,
        isArchived: false,
      },
      {
        key: "t2",
        label: "Thread 2",
        displayLabel: "Thread 2",
        newestTime: 9,
        messageCount: 3,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 0,
        unreadCount: 1,
        isAI: false,
        isPinned: false,
        isArchived: false,
      },
    ],
    archivedThreads: [],
    combinedThread: {
      key: "__COMBINED_FEED__",
      label: "Combined",
      displayLabel: "Combined",
      newestTime: 10,
      messageCount: 8,
      hasCustomName: false,
      hasCustomAppearance: false,
      readCount: 0,
      unreadCount: 3,
      isAI: false,
      isPinned: false,
      isArchived: false,
    },
    threadSections: [],
  }),
}));

jest.mock("../thread-selection", () => ({
  useChatThreadSelection: () => ({
    selectedThreadKey: "__COMBINED_FEED__",
    setSelectedThreadKey: jest.fn(),
    setAllowAutoSelectThread: jest.fn(),
    isCombinedFeedSelected: true,
    singleThreadView: false,
    selectedThread: null,
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
  markChatAsReadIfUnseen: (...args: any[]) => markChatAsReadIfUnseen(...args),
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

describe("ChatPanel combined feed read tracking", () => {
  beforeEach(() => {
    markChatAsReadIfUnseen.mockClear();
  });

  function renderPanel() {
    const actions = {
      markThreadRead: jest.fn(),
      getCodexConfig: jest.fn(),
      getThreadMetadata: jest.fn(),
      getMessagesInThread: jest.fn(() => []),
      getThreadLoopConfig: jest.fn(),
      frameTreeActions: undefined,
      frameId: undefined,
    } as any;

    const { container } = render(
      <ChatPanel
        actions={actions}
        project_id="project-1"
        path="chat/test.chat"
        messages={new Map()}
        threadIndex={undefined}
        docVersion={0}
      />,
    );
    return { actions, container };
  }

  it("marks unread threads read when the combined feed is interacted with", () => {
    const { actions, container } = renderPanel();

    fireEvent.mouseMove(container.firstChild as HTMLElement);

    expect(markChatAsReadIfUnseen).toHaveBeenCalledWith(
      "project-1",
      "chat/test.chat",
    );
    expect(actions.markThreadRead).toHaveBeenCalledTimes(2);
    expect(actions.markThreadRead).toHaveBeenNthCalledWith(1, "t1", 5, false);
    expect(actions.markThreadRead).toHaveBeenNthCalledWith(2, "t2", 3, true);
  });

  it("marks unread threads read when the combined feed is scrolled with the wheel", () => {
    const { actions, container } = renderPanel();

    fireEvent.wheel(container.firstChild as HTMLElement);

    expect(markChatAsReadIfUnseen).toHaveBeenCalledWith(
      "project-1",
      "chat/test.chat",
    );
    expect(actions.markThreadRead).toHaveBeenCalledTimes(2);
    expect(actions.markThreadRead).toHaveBeenNthCalledWith(1, "t1", 5, false);
    expect(actions.markThreadRead).toHaveBeenNthCalledWith(2, "t2", 3, true);
  });
});
