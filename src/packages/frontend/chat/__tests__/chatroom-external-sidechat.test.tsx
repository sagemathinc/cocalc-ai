/** @jest-environment jsdom */

import { render, waitFor } from "@testing-library/react";
import * as immutable from "immutable";
import { ChatPanel } from "../chatroom";

const persistExternalSideChatSelectedThreadKey = jest.fn();

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

const selectedThread = {
  key: "thread-1",
  label: "Thread 1",
  displayLabel: "Thread 1",
  newestTime: 10,
  messageCount: 1,
  hasCustomName: false,
  hasCustomAppearance: false,
  readCount: 1,
  unreadCount: 0,
  isAI: false,
  isPinned: false,
  isArchived: false,
};

jest.mock("../threads", () => ({
  COMBINED_FEED_KEY: "__COMBINED_FEED__",
  useThreadSections: () => ({
    threads: [selectedThread],
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
    selectedThread,
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
  persistExternalSideChatSelectedThreadKey: (...args: any[]) =>
    persistExternalSideChatSelectedThreadKey(...args),
}));

jest.mock("../combined-composer-target", () => {
  const actual = jest.requireActual("../combined-composer-target");
  return {
    ...actual,
    resolveCombinedComposerTargetKey: () => null,
    combinedComposerTargetStorageKey: () => "combined-target:test",
  };
});

describe("ChatPanel external side chat persistence", () => {
  beforeEach(() => {
    persistExternalSideChatSelectedThreadKey.mockClear();
  });

  function renderPanel(desc?: Record<string, unknown>) {
    const actions = {
      getCodexConfig: jest.fn(),
      getThreadMetadata: jest.fn(),
      getMessagesInThread: jest.fn(() => []),
      getThreadLoopConfig: jest.fn(),
      frameTreeActions: {
        set_frame_data: jest.fn(),
      },
      frameId: "frame-1",
    } as any;

    render(
      <ChatPanel
        actions={actions}
        project_id="project-1"
        path=".notes.ipynb.sage-chat"
        messages={new Map()}
        threadIndex={undefined}
        docVersion={0}
        desc={desc as any}
      />,
    );
  }

  it("persists selected threads for external side chat even when frame data is available", async () => {
    renderPanel({ "data-externalSideChat": true });

    await waitFor(() =>
      expect(persistExternalSideChatSelectedThreadKey).toHaveBeenCalledWith({
        project_id: "project-1",
        path: ".notes.ipynb.sage-chat",
        selectedThreadKey: "thread-1",
      }),
    );
  });

  it("does not persist ordinary frame-backed chat selections externally", () => {
    renderPanel();

    expect(persistExternalSideChatSelectedThreadKey).not.toHaveBeenCalled();
  });
});
