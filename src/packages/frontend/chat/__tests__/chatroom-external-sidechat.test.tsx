/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as immutable from "immutable";
import { ChatPanel, restoreChatToolsFocus } from "../chatroom";
import { ChatEmbeddingOptionsProvider } from "../embedding-options";
import { CollaboratorsModal } from "@cocalc/frontend/collaborators/modal";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { ThreadPanelToolbar } from "../thread-panel-toolbar";

// rc-util's fixed Jest ID hides ordering bugs between distinct real portals.
jest.mock(
  require.resolve("@rc-component/util/lib/hooks/useId", {
    paths: [require.resolve("antd")],
  }),
  () => ({
    __esModule: true,
    default: (id?: string) => {
      const reactId = require("react").useId();
      return id || reactId;
    },
  }),
);

const persistExternalSideChatSelectedThreadKey = jest.fn();
const renderChatRoomThreadPanel = jest.fn((props: any) => (
  <div>
    {props.attentionRecords?.map((record: any) => (
      <div
        key={record.attention_id}
        data-testid={`attention-${record.attention_id}`}
      />
    ))}
  </div>
));
let attentionRecords: any[] = [];

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
  useThreadSections: () => ({
    threads: [selectedThread],
    archivedThreads: [],
    threadSections: [],
  }),
}));

jest.mock("../thread-selection", () => ({
  useChatThreadSelection: () => ({
    selectedThreadKey: "thread-1",
    setSelectedThreadKey: jest.fn(),
    setAllowAutoSelectThread: jest.fn(),
    singleThreadView: true,
    selectedThread,
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

jest.mock("../utils", () => ({
  getMessageByLookup: () => undefined,
  markChatAsReadIfUnseen: jest.fn(),
  stableDraftKeyFromThreadKey: (key: string) => key,
}));

jest.mock("../chatroom-layout", () => ({
  ChatRoomLayout: ({ chatContent }: any) => <div>{chatContent}</div>,
}));

jest.mock("../composer", () => ({
  ChatRoomComposer: ({ isActive }: { isActive: boolean }) => (
    <div data-testid="chat-composer" data-active={isActive} />
  ),
}));

jest.mock("../codex-attention-card", () => ({
  CodexAttentionCard: ({ initialRecord }: any) => (
    <div data-testid={`attention-${initialRecord.attention_id}`} />
  ),
}));

jest.mock("../use-codex-attention", () => ({
  useCodexAttentionSummary: () => ({
    count: attentionRecords.length,
    records: attentionRecords,
    byThread: new Map(),
    targetByThread: new Map(),
  }),
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

describe("ChatPanel external side chat persistence", () => {
  beforeEach(() => {
    attentionRecords = [];
    persistExternalSideChatSelectedThreadKey.mockClear();
    renderChatRoomThreadPanel.mockClear();
    const getComputedStyle = window.getComputedStyle;
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) => getComputedStyle(element));
  });

  afterEach(() => jest.restoreAllMocks());

  function renderPanel(
    desc?: Record<string, unknown>,
    opts?: {
      hideCompactThreadHeader?: boolean;
      hideTopControls?: boolean;
      isVisible?: boolean;
      tabIsVisible?: boolean;
      agentWorkspace?: boolean;
      agentWorkspaceActive?: boolean;
    },
  ) {
    const actions = {
      scrollToIndex: jest.fn(),
      getCodexConfig: jest.fn(),
      getThreadMetadata: jest.fn(),
      getMessagesInThread: jest.fn(() => []),
      frameTreeActions: {
        set_frame_data: jest.fn(),
      },
      frameId: "frame-1",
    } as any;

    render(
      <ChatEmbeddingOptionsProvider
        value={{
          hideCompactThreadHeader: opts?.hideCompactThreadHeader,
          hideTopControls: opts?.hideTopControls,
          agentWorkspace: opts?.agentWorkspace,
          agentWorkspaceActive: opts?.agentWorkspaceActive,
        }}
      >
        <ChatPanel
          actions={actions}
          project_id="project-1"
          path=".notes.ipynb.sage-chat"
          messages={new Map()}
          threadIndex={undefined}
          docVersion={0}
          desc={desc as any}
          isVisible={opts?.isVisible}
          tabIsVisible={opts?.tabIsVisible}
        />
      </ChatEmbeddingOptionsProvider>,
    );

    return actions;
  }

  it("keeps Escape owned by sharing when chat mounts its closed tools drawer", () => {
    const cancel = jest.fn();
    render(
      <CollaboratorsModal
        open
        title="Share to conversation"
        onCancel={cancel}
        transitionName=""
        maskTransitionName=""
      >
        <KeyboardBoundary boundary="collaboration-share-dialog">
          <input aria-label="Search conversations" />
        </KeyboardBoundary>
      </CollaboratorsModal>,
    );
    const search = screen.getByRole("textbox", {
      name: "Search conversations",
    });
    act(() => search.focus());

    renderPanel(undefined, {
      agentWorkspace: true,
      agentWorkspaceActive: true,
    });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Escape", code: "Escape", keyCode: 27 });
    fireEvent.keyUp(search, { key: "Escape", code: "Escape", keyCode: 27 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("mounts mobile tools on first open and restores focus after Escape", async () => {
    const matchMedia = window.matchMedia;
    jest.spyOn(window, "matchMedia").mockImplementation((query) => ({
      ...matchMedia(query),
      matches: query.includes("max-width"),
    }));
    const previous = renderChatRoomThreadPanel.getMockImplementation()!;
    renderChatRoomThreadPanel.mockImplementation((props) => (
      <ThreadPanelToolbar
        showInline={false}
        portal={props.topRightControlsPortal}
        render={() => (
          <button onClick={props.onMobileToolsAction}>Search thread</button>
        )}
      />
    ));
    try {
      renderPanel();
      expect(
        screen.queryByRole("button", { name: "Search thread" }),
      ).toBeNull();
      const trigger = screen.getByRole("button", { name: "Chat tools" });
      const user = userEvent.setup();
      act(() => trigger.focus());
      await user.keyboard("{Enter}");
      const tools = await screen.findByRole("dialog", { name: "Chat tools" });
      const search = within(tools).getByRole("button", {
        name: "Search thread",
      });
      await user.click(search);
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Chat tools" })).toBeNull(),
      );
      await waitFor(() => expect(trigger).toHaveFocus());

      await user.keyboard("{Enter}");
      await screen.findByRole("dialog", { name: "Chat tools" });
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Chat tools" })).toBeNull(),
      );
      await waitFor(() => expect(trigger).toHaveFocus());
    } finally {
      renderChatRoomThreadPanel.mockImplementation(previous);
    }
  });

  it("recovers focus left on the closed drawer wrapper", () => {
    render(
      <>
        <button>Chat tools</button>
        <div tabIndex={-1} data-testid="closed-tools">
          <div hidden role="dialog" aria-label="Chat tools" />
        </div>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Chat tools" });
    const drawer = screen.getByTestId("closed-tools");
    act(() => drawer.focus());
    expect(drawer).toHaveFocus();
    act(() => restoreChatToolsFocus({ trigger, drawer, open: false }));
    expect(trigger).toHaveFocus();
  });

  it("does not steal handed-off focus or focus from a reopened drawer", () => {
    render(
      <>
        <button>Chat tools</button>
        <div role="dialog" aria-label="Chat tools" tabIndex={-1} />
        <div role="dialog" aria-label="Thread search">
          <input aria-label="Find messages" />
        </div>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Chat tools" });
    const drawer = screen.getByRole("dialog", { name: "Chat tools" });
    const search = screen.getByRole("textbox", { name: "Find messages" });
    act(() => search.focus());
    act(() => restoreChatToolsFocus({ trigger, drawer, open: false }));
    expect(search).toHaveFocus();
    act(() => drawer.focus());
    act(() => restoreChatToolsFocus({ trigger, drawer, open: true }));
    expect(drawer).toHaveFocus();
  });

  it("uses workspace activity for an agent composer when shared frame visibility is stale", () => {
    renderPanel(undefined, {
      agentWorkspace: true,
      agentWorkspaceActive: true,
      isVisible: false,
      tabIsVisible: true,
    });
    expect(screen.getByTestId("chat-composer")).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("keeps the agent composer inactive when its workspace is hidden", () => {
    renderPanel(undefined, {
      agentWorkspace: true,
      agentWorkspaceActive: false,
      isVisible: true,
      tabIsVisible: true,
    });
    expect(screen.getByTestId("chat-composer")).toHaveAttribute(
      "data-active",
      "false",
    );
  });

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

  it("enables the sidebar toggle for ordinary full chatrooms", () => {
    renderPanel();

    expect(renderChatRoomThreadPanel).toHaveBeenCalled();
    expect(
      renderChatRoomThreadPanel.mock.lastCall?.[0]?.allowSidebarToggle,
    ).toBe(true);
    expect(renderChatRoomThreadPanel.mock.lastCall?.[0]?.sidebarHidden).toBe(
      false,
    );
  });

  it("does not enable the sidebar toggle for external side chat", () => {
    renderPanel({ "data-externalSideChat": true });

    expect(renderChatRoomThreadPanel).toHaveBeenCalled();
    expect(
      renderChatRoomThreadPanel.mock.lastCall?.[0]?.allowSidebarToggle,
    ).toBe(false);
  });

  it("lets an embedded surface suppress the compact thread header", () => {
    renderPanel(undefined, { hideCompactThreadHeader: true });

    expect(
      renderChatRoomThreadPanel.mock.lastCall?.[0]?.hideCompactThreadHeader,
    ).toBe(true);
  });

  it("lets an embedded surface remove the internal top controls", () => {
    renderPanel(undefined, { hideTopControls: true });

    expect(renderChatRoomThreadPanel.mock.lastCall?.[0]?.hideTopControls).toBe(
      true,
    );
  });

  it("leaves the selected thread viewport to ChatLog", () => {
    const actions = renderPanel();

    expect(actions.scrollToIndex).not.toHaveBeenCalled();
  });

  it("does not override explicit fragment jumps when opening a thread", () => {
    const actions = renderPanel({ "data-fragmentId": "1234" });

    expect(actions.scrollToIndex).not.toHaveBeenCalled();
  });

  it("routes durable Codex attention requests through the selected thread", async () => {
    renderPanel({
      "data-codexAttentionDate": "1234",
      "data-codexAttentionId": "attention-1",
      "data-codexAttentionOpenToken": 7,
    });

    await waitFor(() =>
      expect(renderChatRoomThreadPanel.mock.lastCall?.[0]).toEqual(
        expect.objectContaining({
          activityJumpDate: undefined,
          activityJumpAttentionId: "attention-1",
          activityJumpToken: 1,
        }),
      ),
    );
  });

  it("renders selected-thread attention above the composer", () => {
    attentionRecords = [
      { attention_id: "attention-1", thread_id: "thread-1" },
      { attention_id: "attention-other", thread_id: "thread-2" },
    ];

    renderPanel();

    const attention = screen.getByTestId("attention-attention-1");
    const composer = screen.getByTestId("chat-composer");
    expect(
      attention.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      document.querySelector('[data-testid="attention-attention-other"]'),
    ).toBeNull();
  });

  it("disables thread-search shortcuts when the backing tab is hidden", () => {
    renderPanel(undefined, {
      isVisible: false,
      tabIsVisible: false,
    });

    expect(renderChatRoomThreadPanel).toHaveBeenCalled();
    expect(renderChatRoomThreadPanel.mock.lastCall?.[0]?.shortcutEnabled).toBe(
      false,
    );
  });
});
