/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as immutable from "immutable";
import { ChatPanel } from "../chatroom";

const messageSuccess = jest.fn();
const setInput = jest.fn();
const clearInput = jest.fn(() => Promise.resolve());
const clearComposerDraft = jest.fn(() => Promise.resolve());
const setSelectedThreadKey = jest.fn();
const setAllowAutoSelectThread = jest.fn();
let lastThreadPanelProps: any;

let currentAcpState = immutable.Map();
let currentThreads: any[] = [];
let currentArchivedThreads: any[] = [];
let currentSelection: any;

jest.mock("antd", () => {
  const Div = ({ children }: any) => <div>{children}</div>;
  const Button = ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
  return {
    Alert: Div,
    Button,
    Modal: Div,
    Popconfirm: Div,
    Space: Div,
    Tag: Div,
    message: {
      success: (...args: any[]) => messageSuccess(...args),
    },
  };
});

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => null,
  TimeAgo: () => null,
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useEditorRedux: () => (key: string) => {
      if (key === "activity") return undefined;
      if (key === "acpState") return currentAcpState;
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
    threads: currentThreads,
    archivedThreads: currentArchivedThreads,
    combinedThread: undefined,
    threadSections: [],
  }),
}));

jest.mock("../thread-selection", () => ({
  useChatThreadSelection: () => currentSelection,
}));

jest.mock("../use-chat-composer-draft", () => ({
  useChatComposerDraft: () => ({
    input: "/fast",
    setInput,
    clearInput,
    clearComposerDraft,
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

jest.mock("../automation-form", () => ({
  AutomationConfigFields: () => null,
  buildAutomationDraft: jest.fn(() => ({
    enabled: false,
  })),
  formatAutomationPausedReason: jest.fn(() => ""),
  normalizeAutomationConfigForSave: jest.fn(() => undefined),
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
  ChatRoomComposer: ({ on_send }: any) => (
    <button type="button" onClick={() => on_send("/fast")}>
      fast
    </button>
  ),
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
    lastThreadPanelProps = props;
    return null;
  },
  getDefaultNewThreadSetup: () => ({
    agentMode: "codex",
    title: "",
    icon: "",
    color: "",
    image: "",
    model: "gpt-5.4",
    codexConfig: {
      model: "gpt-5.4",
      reasoning: "medium",
      sessionMode: "workspace-write",
      workingDirectory: "/",
    },
  }),
}));

jest.mock("../agent-session-index", () => ({
  upsertAgentSessionRecord: jest.fn(() => Promise.resolve()),
}));

jest.mock("../external-side-chat-selection", () => ({
  persistExternalSideChatSelectedThreadKey: jest.fn(),
}));

jest.mock("../combined-composer-target", () => {
  const actual = jest.requireActual("../combined-composer-target");
  return {
    ...actual,
    resolveCombinedComposerTargetKey: () => null,
  };
});

describe("ChatPanel /fast command", () => {
  beforeEach(() => {
    currentAcpState = immutable.Map();
    currentArchivedThreads = [];
    currentThreads = [
      {
        key: "t1",
        label: "Thread 1",
        displayLabel: "Thread 1",
        newestTime: 10,
        messageCount: 5,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 5,
        unreadCount: 0,
        isAI: true,
        isPinned: false,
        isArchived: false,
      },
    ];
    currentSelection = {
      selectedThreadKey: "t1",
      setSelectedThreadKey,
      setAllowAutoSelectThread,
      isCombinedFeedSelected: false,
      singleThreadView: true,
      selectedThread: currentThreads[0],
    };
    messageSuccess.mockClear();
    setInput.mockClear();
    clearInput.mockClear();
    clearComposerDraft.mockClear();
    setSelectedThreadKey.mockClear();
    setAllowAutoSelectThread.mockClear();
    lastThreadPanelProps = undefined;
  });

  it("updates the selected Codex thread instead of sending a /fast chat message", async () => {
    const actions = {
      sendChat: jest.fn(),
      setCodexConfig: jest.fn(),
      getThreadMetadata: jest.fn(() => ({
        agent_kind: "acp",
        acp_config: {
          model: "gpt-5.4",
          reasoning: "high",
          sessionMode: "workspace-write",
          workingDirectory: "/repo",
        },
      })),
      getCodexConfig: jest.fn(() => ({
        model: "gpt-5.4",
        reasoning: "high",
        sessionMode: "workspace-write",
        workingDirectory: "/repo",
      })),
      getMessagesInThread: jest.fn(() => []),
      deleteDraft: jest.fn(),
      getThreadLoopConfig: jest.fn(),
      getThreadLoopState: jest.fn(),
      frameTreeActions: undefined,
      frameId: undefined,
      languageModelStopGenerating: jest.fn(),
    } as any;

    render(
      <ChatPanel
        actions={actions}
        project_id="project-1"
        path="chat/test.chat"
        messages={new Map()}
        threadIndex={undefined}
        docVersion={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "fast" }));

    await waitFor(() =>
      expect(actions.setCodexConfig).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          model: "gpt-5.4-mini",
          reasoning: "low",
          sessionMode: "workspace-write",
          allowWrite: true,
          workingDirectory: "/repo",
        }),
      ),
    );
    expect(actions.sendChat).not.toHaveBeenCalled();
    expect(messageSuccess).toHaveBeenCalledWith("Fast mode enabled.");
  });

  it("updates new-thread Codex defaults when /fast is used before the first send", async () => {
    currentSelection = {
      selectedThreadKey: undefined,
      setSelectedThreadKey,
      setAllowAutoSelectThread,
      isCombinedFeedSelected: false,
      singleThreadView: true,
      selectedThread: undefined,
    };
    currentThreads = [];
    const actions = {
      sendChat: jest.fn(),
      setCodexConfig: jest.fn(),
      getThreadMetadata: jest.fn(() => undefined),
      getCodexConfig: jest.fn(() => undefined),
      getMessagesInThread: jest.fn(() => []),
      deleteDraft: jest.fn(),
      getThreadLoopConfig: jest.fn(),
      getThreadLoopState: jest.fn(),
      frameTreeActions: undefined,
      frameId: undefined,
      languageModelStopGenerating: jest.fn(),
    } as any;

    render(
      <ChatPanel
        actions={actions}
        project_id="project-1"
        path="chat/test.chat"
        messages={new Map()}
        threadIndex={undefined}
        docVersion={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "fast" }));

    fireEvent.click(screen.getByRole("button", { name: "fast" }));

    await waitFor(() =>
      expect(lastThreadPanelProps.newThreadSetup.codexConfig).toEqual(
        expect.objectContaining({
          model: "gpt-5.4-mini",
          reasoning: "low",
          sessionMode: "workspace-write",
          allowWrite: true,
        }),
      ),
    );
    expect(actions.sendChat).not.toHaveBeenCalled();
    expect(setAllowAutoSelectThread).toHaveBeenCalledWith(false);
    expect(messageSuccess).toHaveBeenCalledWith("Fast mode enabled.");
  });
});
