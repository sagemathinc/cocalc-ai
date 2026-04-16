/** @jest-environment jsdom */

import { act, render } from "@testing-library/react";
import * as immutable from "immutable";
import { ChatPanel } from "../chatroom";

const renderChatRoomThreadPanel = jest.fn((_props: any) => null);

let mockOtherSettings = {
  codex_new_chat_defaults: {
    model: "gpt-5.4",
    reasoning: "low",
    sessionMode: "workspace-write",
  },
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
      if (args[0] === "account" && args[1] === "other_settings") {
        return mockOtherSettings;
      }
      return undefined;
    },
  };
});

jest.mock("../threads", () => ({
  useThreadSections: () => ({
    threads: [],
    archivedThreads: [],
    threadSections: [],
  }),
}));

jest.mock("../thread-selection", () => ({
  useChatThreadSelection: () => ({
    selectedThreadKey: null,
    setSelectedThreadKey: jest.fn(),
    setAllowAutoSelectThread: jest.fn(),
    singleThreadView: false,
    selectedThread: null,
  }),
  resetThreadSelectionForNewChat: jest.fn(),
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
  ChatRoomThreadPanel: (props: any) => renderChatRoomThreadPanel(props),
  getDefaultNewThreadSetup: () => {
    const defaults = mockOtherSettings.codex_new_chat_defaults;
    return {
      title: "",
      icon: undefined,
      color: undefined,
      image: "",
      agentMode: "codex",
      model: defaults.model,
      codexConfig: {
        model: defaults.model,
        reasoning: defaults.reasoning,
        sessionMode: defaults.sessionMode,
        workingDirectory: "/",
      },
      automationConfig: {
        enabled: false,
      },
    };
  },
}));

jest.mock("../agent-session-index", () => ({
  upsertAgentSessionRecord: jest.fn(),
}));

jest.mock("../external-side-chat-selection", () => ({
  persistExternalSideChatSelectedThreadKey: jest.fn(),
}));

describe("ChatPanel new thread defaults", () => {
  beforeEach(() => {
    renderChatRoomThreadPanel.mockClear();
    mockOtherSettings = {
      codex_new_chat_defaults: {
        model: "gpt-5.4",
        reasoning: "low",
        sessionMode: "workspace-write",
      },
    };
  });

  it("uses refreshed defaults the next time new-chat setup is reset", () => {
    const actions = {
      deleteDraft: jest.fn(),
      getCodexConfig: jest.fn(),
      getThreadMetadata: jest.fn(),
      getMessagesInThread: jest.fn(() => []),
      getThreadLoopConfig: jest.fn(),
      frameTreeActions: undefined,
      frameId: undefined,
    } as any;

    const { rerender } = render(
      <ChatPanel
        actions={actions}
        project_id="project-1"
        path="chat/test.chat"
        messages={new Map()}
        threadIndex={undefined}
        docVersion={0}
      />,
    );

    expect(
      renderChatRoomThreadPanel.mock.lastCall?.[0]?.newThreadSetup,
    ).toMatchObject({
      model: "gpt-5.4",
      codexConfig: {
        model: "gpt-5.4",
        reasoning: "low",
        sessionMode: "workspace-write",
      },
    });

    mockOtherSettings = {
      codex_new_chat_defaults: {
        model: "gpt-5.4-mini",
        reasoning: "medium",
        sessionMode: "read-only",
      },
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

    act(() => {
      renderChatRoomThreadPanel.mock.lastCall?.[0]?.onNewChat();
    });

    expect(
      renderChatRoomThreadPanel.mock.lastCall?.[0]?.newThreadSetup,
    ).toMatchObject({
      model: "gpt-5.4-mini",
      codexConfig: {
        model: "gpt-5.4-mini",
        reasoning: "medium",
        sessionMode: "read-only",
      },
    });
  });
});
