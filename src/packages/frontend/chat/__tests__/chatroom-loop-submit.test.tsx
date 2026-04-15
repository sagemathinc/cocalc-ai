/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as immutable from "immutable";
import { ChatPanel } from "../chatroom";

let currentAcpState = immutable.Map();

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
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

const selectedThread = {
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
};

const archivedThread = {
  ...selectedThread,
  key: "archived-ai-thread",
  label: "Archived AI Thread",
  displayLabel: "Archived AI Thread",
  isArchived: true,
};

let currentThreads = [selectedThread];
let currentArchivedThreads: any[] = [];

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
  useChatThreadSelection: () => ({
    selectedThreadKey: "t1",
    setSelectedThreadKey: jest.fn(),
    setAllowAutoSelectThread: jest.fn(),
    isCombinedFeedSelected: false,
    singleThreadView: true,
    selectedThread,
  }),
}));

const setInput = jest.fn();
const clearInput = jest.fn();
const clearComposerDraft = jest.fn();
let lastThreadPanelProps: any = undefined;

jest.mock("../use-chat-composer-draft", () => ({
  useChatComposerDraft: () => ({
    input: "hello",
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
  ChatRoomComposer: ({ loopConfig, on_send, onLoopConfigChange }: any) => (
    <div>
      <div data-testid="loop-state">
        {loopConfig?.enabled === true ? "on" : "off"}
      </div>
      <button onClick={() => on_send()}>send</button>
      <button onClick={() => onLoopConfigChange?.(undefined)}>
        disable loop
      </button>
    </div>
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
      workingDirectory: "/",
    },
  }),
}));

const upsertAgentSessionRecord = jest.fn(() => Promise.resolve());

jest.mock("../agent-session-index", () => ({
  upsertAgentSessionRecord: (record: any) =>
    (upsertAgentSessionRecord as any)(record),
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

describe("ChatPanel loop submit behavior", () => {
  beforeEach(() => {
    setInput.mockClear();
    clearInput.mockClear();
    clearComposerDraft.mockClear();
    upsertAgentSessionRecord.mockClear();
    lastThreadPanelProps = undefined;
    currentThreads = [selectedThread];
    currentArchivedThreads = [];
    currentAcpState = immutable.Map();
  });

  it("turns loop off after a successful send even if thread metadata still has loop enabled", async () => {
    const actions = {
      sendChat: jest.fn(() => Date.now()),
      getThreadMetadata: jest.fn(() => ({
        agent_kind: "acp",
        loop_config: { enabled: true, max_turns: 4 },
        acp_config: { model: "gpt-5.4", sessionMode: "workspace-write" },
      })),
      getMessagesInThread: jest.fn(() => []),
      deleteDraft: jest.fn(),
      getThreadLoopConfig: jest.fn(),
      getThreadLoopState: jest.fn(),
      frameTreeActions: undefined,
      frameId: undefined,
      languageModelStopGenerating: jest.fn(),
      getCodexConfig: jest.fn(() => ({
        model: "gpt-5.4",
        sessionMode: "workspace-write",
      })),
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

    expect(screen.getByTestId("loop-state").textContent).toBe("on");

    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() =>
      expect(screen.getByTestId("loop-state").textContent).toBe("off"),
    );
  });

  it("keeps loop off immediately after disabling even before stale metadata clears", async () => {
    const actions = {
      sendChat: jest.fn(() => Date.now()),
      getThreadMetadata: jest.fn(() => ({
        agent_kind: "acp",
        loop_config: { enabled: true, max_turns: 4 },
        acp_config: { model: "gpt-5.4", sessionMode: "workspace-write" },
      })),
      getMessagesInThread: jest.fn(() => []),
      deleteDraft: jest.fn(),
      getThreadLoopConfig: jest.fn(),
      getThreadLoopState: jest.fn(),
      setThreadLoopConfig: jest.fn(),
      setThreadLoopState: jest.fn(),
      frameTreeActions: undefined,
      frameId: undefined,
      languageModelStopGenerating: jest.fn(),
      getCodexConfig: jest.fn(() => ({
        model: "gpt-5.4",
        sessionMode: "workspace-write",
      })),
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

    expect(screen.getByTestId("loop-state").textContent).toBe("on");

    fireEvent.click(screen.getByRole("button", { name: "disable loop" }));

    await waitFor(() =>
      expect(screen.getByTestId("loop-state").textContent).toBe("off"),
    );
    expect(actions.setThreadLoopConfig).toHaveBeenCalledWith("t1", null);
    expect(actions.setThreadLoopState).toHaveBeenCalledWith("t1", null);
  });

  it("indexes archived ai threads as archived even if their acp state is still running", async () => {
    currentArchivedThreads = [archivedThread];
    currentAcpState = immutable.Map({
      "thread:archived-ai-thread": "running",
    });

    const actions = {
      sendChat: jest.fn(() => Date.now()),
      getThreadMetadata: jest.fn(() => ({
        agent_kind: "acp",
        acp_config: { model: "gpt-5.4", sessionMode: "workspace-write" },
      })),
      getMessagesInThread: jest.fn(() => []),
      deleteDraft: jest.fn(),
      getThreadLoopConfig: jest.fn(),
      getThreadLoopState: jest.fn(),
      frameTreeActions: undefined,
      frameId: undefined,
      languageModelStopGenerating: jest.fn(),
      getCodexConfig: jest.fn(() => ({
        model: "gpt-5.4",
        sessionMode: "workspace-write",
      })),
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

    await waitFor(() =>
      expect(upsertAgentSessionRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_key: "archived-ai-thread",
          status: "archived",
        }),
      ),
    );
  });

  it("opens the latest activity log from the loop banner", async () => {
    const latestAcpDate = "2026-03-20T02:00:00.000Z";
    const olderAcpDate = "2026-03-20T01:00:00.000Z";
    const actions = {
      sendChat: jest.fn(() => Date.now()),
      getThreadMetadata: jest.fn(() => ({
        agent_kind: "acp",
        acp_config: { model: "gpt-5.4", sessionMode: "workspace-write" },
        loop_state: {
          status: "running",
          iteration: 2,
          max_turns: 4,
          updated_at_ms: Date.now(),
        },
      })),
      getMessagesInThread: jest.fn(() => [
        {
          event: "chat",
          sender_id: "assistant",
          message_id: "msg-older",
          thread_id: "t1",
          date: olderAcpDate,
          history: [],
          acp_account_id: "acct",
        },
        {
          event: "chat",
          sender_id: "assistant",
          message_id: "msg-non-acp",
          thread_id: "t1",
          date: "2026-03-20T01:30:00.000Z",
          history: [],
        },
        {
          event: "chat",
          sender_id: "assistant",
          message_id: "msg-latest",
          thread_id: "t1",
          date: latestAcpDate,
          history: [],
          acp_account_id: "acct",
        },
      ]),
      deleteDraft: jest.fn(),
      getThreadLoopConfig: jest.fn(),
      getThreadLoopState: jest.fn(),
      frameTreeActions: undefined,
      frameId: undefined,
      languageModelStopGenerating: jest.fn(),
      getCodexConfig: jest.fn(() => ({
        model: "gpt-5.4",
        sessionMode: "workspace-write",
      })),
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

    expect(
      screen.getByRole("button", { name: "View activity log" }),
    ).not.toBeNull();
    expect(lastThreadPanelProps?.activityJumpDate).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "View activity log" }));

    await waitFor(() =>
      expect(lastThreadPanelProps?.activityJumpDate).toBe(
        `${Date.parse(latestAcpDate)}`,
      ),
    );
    expect(lastThreadPanelProps?.activityJumpToken).toBeGreaterThan(0);
  });

  it("lets the completed-turn modal disable notify for the next turn", async () => {
    currentAcpState = immutable.Map({
      "thread:t1": "running",
    });
    const actions = {
      sendChat: jest.fn(() => Date.now()),
      getThreadMetadata: jest.fn(() => ({
        agent_kind: "acp",
        acp_config: { model: "gpt-5.4", sessionMode: "workspace-write" },
      })),
      getMessagesInThread: jest
        .fn()
        .mockReturnValueOnce([
          {
            date: new Date(1000),
            thread_id: "t1",
            message_id: "m1",
            sender_id: "acct",
            history: [{ author_id: "acct", content: "working" }],
            acp_account_id: "acct",
            generating: false,
            acp_interrupted: false,
          },
        ])
        .mockReturnValueOnce([
          {
            date: new Date(2000),
            thread_id: "t1",
            message_id: "m2",
            sender_id: "acct",
            history: [{ author_id: "acct", content: "done" }],
            acp_account_id: "acct",
            generating: false,
            acp_interrupted: false,
          },
        ])
        .mockReturnValue([]),
      deleteDraft: jest.fn(),
      getThreadLoopConfig: jest.fn(),
      getThreadLoopState: jest.fn(),
      frameTreeActions: undefined,
      frameId: undefined,
      languageModelStopGenerating: jest.fn(),
      getCodexConfig: jest.fn(() => ({
        model: "gpt-5.4",
        sessionMode: "workspace-write",
      })),
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

    await act(async () => {
      lastThreadPanelProps?.onNotifyOnTurnFinishChange?.(true);
    });

    await waitFor(() =>
      expect(lastThreadPanelProps?.notifyOnTurnFinish).toBe(true),
    );

    currentAcpState = immutable.Map();
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

    const notify = await screen.findByRole("checkbox", { name: "Notify" });
    fireEvent.click(notify);

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

    expect(lastThreadPanelProps?.notifyOnTurnFinish).toBe(false);
  });
});
