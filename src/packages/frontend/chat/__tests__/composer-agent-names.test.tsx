/** @jest-environment jsdom */

import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ChatRoomComposer } from "../composer";
import {
  ChatEmbeddingOptionsProvider,
  type ChatEmbeddingOptions,
} from "../embedding-options";

let lastChatInputProps: any;
let lastCodexConfigProps: any;
// A directory of named agents, and a mention check that records what it saw
// and passes the send through.
let mockAgents: any[] = [];
const mockMentionPreflight = jest.fn(
  async (_value: string, send: () => unknown) => await send(),
);
jest.mock("@cocalc/frontend/agents/use-agent-mentions", () => ({
  useAgentMentions: () => ({
    accountId: "00000000-1000-4000-8000-000000000001",
    agents: mockAgents,
    context: { allowAgentMentions: true, onSelect: jest.fn(), states: {} },
    preflight: (value: string, send: () => unknown) =>
      mockMentionPreflight(value, send),
    namedAgent: undefined,
    ui: null,
  }),
}));
// The computer check passes sends through and records what it saw.
const mockComputerPreflight = jest.fn(
  async (_value: string, send: () => unknown) => await send(),
);
const mockComputerThreads: (string | undefined)[] = [];
jest.mock("@cocalc/frontend/agents/computer-access", () => ({
  useComputerMentionCheck: ({ threadId }: { threadId?: string }) => ({
    preflight: (value: string, send: () => unknown) => {
      mockComputerThreads.push(threadId);
      return mockComputerPreflight(value, send);
    },
    ui: null,
  }),
}));
let mockStoredHeight: string | null = null;

// rc-util's fixed Jest ID makes the popover and modal share one Escape-stack
// entry. Use the distinct IDs supplied by React in a real browser.
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  ...jest.requireActual("@rc-component/util/lib/hooks/useId"),
  default: (id?: string) => {
    const reactId = require("react").useId();
    return id || reactId;
  },
}));

jest.mock("../input", () => ({
  __esModule: true,
  default: (props: any) => {
    lastChatInputProps = props;
    return (
      <>
        <button
          data-testid="chat-input-focus-probe"
          onFocus={props.onFocus}
          onBlur={props.onBlur}
          type="button"
        >
          focus-probe
        </button>
        {props.toolbarRightContent}
        {props.toolbarMenuContent?.(() => {})}
      </>
    );
  },
}));

jest.mock("../codex", () => ({
  CodexConfigButton: (props: any) => {
    const { useState } = require("react");
    const { Modal, Popover } = require("antd");
    const [open, setOpen] = useState(false);
    lastCodexConfigProps = props;
    return (
      <>
        <Popover
          id="composer-settings-popover"
          trigger="click"
          content={<button onClick={() => setOpen(true)}>Choose model</button>}
        >
          <button type="button" aria-label="Codex settings">
            Codex settings
          </button>
        </Popover>
        <Modal
          title="Model settings"
          open={open}
          onCancel={() => setOpen(false)}
          footer={null}
        >
          Model options
        </Modal>
      </>
    );
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("react-intl", () => ({
  ...jest.requireActual("react-intl"),
  FormattedMessage: ({ defaultMessage }) => defaultMessage ?? null,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("@cocalc/frontend/misc", () => ({
  delete_local_storage: jest.fn(),
  get_local_storage: jest.fn(() => mockStoredHeight),
  set_local_storage: jest.fn(),
}));

jest.mock("../utils", () => ({
  INPUT_HEIGHT: "auto",
}));

function agent(name: string, n: number) {
  return {
    account_id: "00000000-1000-4000-8000-000000000001",
    name,
    endpoint: {
      project_id: `00000000-5000-4000-8000-00000000000${n}`,
      agent_id: `00000000-6000-4000-8000-00000000000${n}`,
    },
    thread_title: `Thread ${n}`,
    project_title: `Project ${n}`,
  };
}

function renderComposer(
  draft: string,
  overrides: Partial<React.ComponentProps<typeof ChatRoomComposer>> = {},
) {
  const setInput = jest.fn();
  const on_send = jest.fn();
  const props: React.ComponentProps<typeof ChatRoomComposer> = {
    actions: {
      syncdb: {},
      getThreadMetadata: () => ({ agent_kind: "acp" }),
      isCodexThread: () => true,
    } as any,
    project_id: "project-1",
    path: "chat/test.chat",
    fontSize: 14,
    composerDraftKey: 1,
    composerSession: 1,
    input: draft,
    setInput,
    on_send,
    submitMentionsRef: { current: undefined },
    hasInput: true,
    isSelectedThreadAI: true,
    selectedThread: { key: "thread-1", label: "T", isAI: true } as any,
    threads: [],
    onComposerFocusChange: jest.fn(),
    ...overrides,
  };
  const view = render(
    <ChatEmbeddingOptionsProvider value={{}}>
      <ChatRoomComposer {...props} />
    </ChatEmbeddingOptionsProvider>,
  );
  // The editor still shows what was pasted when the check runs.
  lastChatInputProps.inputControlRef.current = {
    getValue: () => draft,
    focus: () => true,
    captureSelection: () => null,
    insertText: () => true,
  };
  return { setInput, on_send, view, props };
}

const BOUND =
  /<span class="agent-mention" data-agent-reference="[^"]+">@ops2<\/span>/;

describe("ChatRoomComposer pasted agent names", () => {
  afterEach(() => {
    mockAgents = [];
    mockMentionPreflight.mockClear();
  });

  it("binds a pasted @name only one agent has and sends, with no button to click", async () => {
    mockAgents = [agent("ops2", 1), agent("reviewer", 2)];
    const draft = "@ops2 estimates about 1,600 lines.";
    const { setInput, on_send } = renderComposer(draft);
    expect(screen.queryByRole("button", { name: /Resolve @ops2/ })).toBeNull();
    await act(async () => {
      lastChatInputProps.on_send(draft);
    });
    await waitFor(() => expect(on_send).toHaveBeenCalledTimes(1));
    const sent = on_send.mock.calls[0][0];
    expect(sent).toMatch(BOUND);
    expect(sent).toMatch(/ estimates about 1,600 lines\.$/);
    // The same bound draft goes through the agent check, and the editor
    // shows it.
    expect(mockMentionPreflight.mock.calls[0][0]).toMatch(BOUND);
    expect(setInput).toHaveBeenCalledWith(sent, 1);
  });

  it("a first message prepares its agent, then sends the bound draft while the editor still shows the pasted one", async () => {
    mockAgents = [agent("ops2", 1)];
    const draft = "@ops2 estimates about 1,600 lines.";
    const prepare = jest.fn(async () => "prepared-thread");
    const { on_send, view, props } = renderComposer(draft, {
      isNewThreadCodex: true,
      selectedThread: undefined,
      isSelectedThreadAI: false,
      onPrepareAgentThread: prepare,
    });
    await act(async () => {
      lastChatInputProps.on_send(draft);
    });
    // A bound reference needs the agent first.
    expect(prepare).toHaveBeenCalledWith(expect.stringMatching(BOUND));
    expect(on_send).not.toHaveBeenCalled();
    await act(async () => {
      view.rerender(
        <ChatEmbeddingOptionsProvider value={{}}>
          <ChatRoomComposer
            {...props}
            selectedThread={
              { key: "prepared-thread", label: "New", isAI: true } as any
            }
            isSelectedThreadAI
          />
        </ChatEmbeddingOptionsProvider>,
      );
    });
    // The editor has not rendered the bound draft yet: still sent.
    await waitFor(() => expect(on_send).toHaveBeenCalledTimes(1));
    expect(on_send.mock.calls[0][0]).toMatch(BOUND);
  });

  it("still asks which agent a shared name means", async () => {
    mockAgents = [agent("ops2", 1), agent("ops2", 2)];
    const draft = "@ops2 estimates about 1,600 lines.";
    const { setInput, on_send } = renderComposer(draft);
    expect(
      screen.getAllByRole("button", { name: /^Resolve @ops2 to named agent/ }),
    ).toHaveLength(2);
    await act(async () => {
      lastChatInputProps.on_send(draft);
    });
    // Left unbound for the check, which holds it back for a pick.
    await waitFor(() => expect(mockMentionPreflight).toHaveBeenCalled());
    expect(mockMentionPreflight.mock.calls[0][0]).not.toMatch(BOUND);
    expect(setInput).not.toHaveBeenCalled();
  });
});
