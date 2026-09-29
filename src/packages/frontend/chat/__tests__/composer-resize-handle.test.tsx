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
import userEvent from "@testing-library/user-event";
import {
  allowAgentMentionsInComposer,
  approvedDraftIsCurrent,
  ChatRoomComposer,
} from "../composer";
import {
  ChatEmbeddingOptionsProvider,
  type ChatEmbeddingOptions,
} from "../embedding-options";

let lastChatInputProps: any;
let lastCodexConfigProps: any;
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

function renderComposer(
  overrides: Partial<React.ComponentProps<typeof ChatRoomComposer>> = {},
  embeddingOptions: ChatEmbeddingOptions = {},
) {
  const props: React.ComponentProps<typeof ChatRoomComposer> = {
    actions: {
      syncdb: {},
      getThreadMetadata: () => ({ agent_kind: "none" }),
      isCodexThread: () => false,
    } as any,
    project_id: "project-1",
    path: "chat/test.chat",
    fontSize: 14,
    composerDraftKey: 1,
    composerSession: 1,
    input: "",
    setInput: jest.fn(),
    on_send: jest.fn(),
    submitMentionsRef: { current: undefined },
    hasInput: false,
    isSelectedThreadAI: false,
    threads: [],
    onComposerFocusChange: jest.fn(),
    ...overrides,
  };
  const view = render(
    <ChatEmbeddingOptionsProvider value={embeddingOptions}>
      <ChatRoomComposer {...props} />
    </ChatEmbeddingOptionsProvider>,
  );
  return { ...view, props };
}

describe("ChatRoomComposer resize handle", () => {
  it("fits the text by default in .chat files", () => {
    renderComposer();
    const composer = screen.getByTestId("chat-composer");
    expect(composer.style.maxWidth).toBe("1120px");
    expect(lastChatInputProps.height).toBeUndefined();
    expect(lastChatInputProps.autoGrow).toBe(true);
    expect(lastChatInputProps.autoGrowMinHeight).toBe(40);
    // 40% of jsdom's 768px viewport.
    expect(lastChatInputProps.autoGrowMaxHeight).toBe(307);
    expect(lastChatInputProps.compactModeSwitch).toBe(true);
    expect(lastChatInputProps.softFocus).toBe(true);
    expect(screen.getByTestId("chat-composer-actions").style.borderTop).toBe(
      "",
    );
  });

  it("ignores composer heights saved by older versions", () => {
    mockStoredHeight = "180";
    renderComposer(
      { hasInput: true, input: "A multiline draft" },
      { agentWorkspace: true },
    );
    expect(lastChatInputProps.height).toBeUndefined();
    expect(lastChatInputProps.autoGrow).toBe(true);
    expect(lastChatInputProps.autoGrowMinHeight).toBe(40);
  });

  it("centers an automatically sized Agents composer", () => {
    renderComposer(
      { hasInput: true, input: "draft" },
      { agentWorkspace: true },
    );
    const composer = screen.getByTestId("chat-composer");
    expect(composer.style.maxWidth).toBe("1120px");
    expect(composer.style.margin).toBe("0px auto 6px");
    expect(lastChatInputProps.height).toBeUndefined();
    expect(lastChatInputProps.autoGrow).toBe(true);
    expect(lastChatInputProps.compactModeSwitch).toBe(true);
    expect(lastChatInputProps.softFocus).toBe(true);
  });

  it("shows focus on the Agents composer box without an extra shadow", () => {
    renderComposer({}, { agentWorkspace: true });
    const composer = screen.getByTestId("chat-composer-box");
    expect(composer.style.border).toContain("var(--cocalc-ui-border)");
    fireEvent.focus(screen.getByTestId("chat-input-focus-probe"));
    expect(composer.style.border).toContain("var(--cocalc-ui-focus)");
    expect(composer.style.boxShadow).toBe("");
  });

  it.each([false, true])(
    "offers agent delivery for a new thread only when Codex is selected (%s)",
    (isNewThreadCodex) => {
      renderComposer({
        isNewThreadCodex,
        on_post: jest.fn(),
        hasInput: true,
        input: "draft",
      });
      if (isNewThreadCodex) {
        expect(
          screen.getByRole("button", { name: "Message delivery: To Agent" }),
        ).toBeEnabled();
      } else {
        expect(
          screen.queryByRole("button", { name: /Message delivery:/ }),
        ).not.toBeInTheDocument();
      }
    },
  );

  it("does not show delivery options for an empty agent composer", () => {
    renderComposer({ isNewThreadCodex: true, on_post: jest.fn() });
    expect(
      screen.queryByRole("button", { name: /Message delivery:/ }),
    ).not.toBeInTheDocument();
  });

  it("only offers agent delivery for the selected agent or a new Codex thread", async () => {
    const humanThread = { key: "human", label: "Human", isAI: false } as any;
    const agentThread = { key: "agent", label: "Agent", isAI: true } as any;
    const onSend = jest.fn();
    const view = renderComposer({
      actions: {
        syncdb: {},
        getThreadMetadata: (key: string) => ({
          agent_kind: key === "agent" ? "acp" : "none",
        }),
        isCodexThread: () => false,
      } as any,
      selectedThread: humanThread,
      isNewThreadCodex: true,
      on_post: jest.fn(),
      on_send: onSend,
      hasInput: true,
      input: "hello",
    });
    const rerenderThread = (selectedThread: any, isSelectedThreadAI: boolean) =>
      view.rerender(
        <ChatEmbeddingOptionsProvider value={{}}>
          <ChatRoomComposer
            {...view.props}
            selectedThread={selectedThread}
            isSelectedThreadAI={isSelectedThreadAI}
          />
        </ChatEmbeddingOptionsProvider>,
      );

    expect(
      screen.queryByRole("button", { name: /Message delivery:/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();

    rerenderThread(agentThread, true);
    expect(
      screen.getByRole("button", { name: "Message delivery: To Agent" }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Message delivery: To Agent" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /Post/ }));
    expect(screen.getByRole("button", { name: "Post message" })).toBeEnabled();

    rerenderThread(humanThread, false);
    expect(
      screen.queryByRole("button", { name: /Message delivery:/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Post message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("unmounts the inactive editor without resetting delivery or its draft", async () => {
    const onSend = jest.fn();
    const onPost = jest.fn();
    const view = renderComposer({
      actions: {
        syncdb: {},
        getThreadMetadata: () => ({ agent_kind: "acp" }),
      } as any,
      selectedThread: { key: "agent", label: "Agent", isAI: true } as any,
      isSelectedThreadAI: true,
      input: "unsent draft",
      hasInput: true,
      on_send: onSend,
      on_post: onPost,
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Message delivery: To Agent" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: /Post/ }));

    const rerenderActive = (isActive: boolean) =>
      view.rerender(
        <ChatEmbeddingOptionsProvider value={{}}>
          <ChatRoomComposer {...view.props} isActive={isActive} />
        </ChatEmbeddingOptionsProvider>,
      );
    rerenderActive(false);
    expect(screen.queryByTestId("chat-input-focus-probe")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Message delivery: Post" }),
    ).toBeEnabled();

    rerenderActive(true);
    expect(screen.getByTestId("chat-input-focus-probe")).toBeInTheDocument();
    expect(lastChatInputProps.input).toBe("unsent draft");
    fireEvent.click(screen.getByRole("button", { name: "Post message" }));
    expect(onPost).toHaveBeenCalledTimes(1);
    expect(onPost).toHaveBeenCalledWith("unsent draft");
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses compact settings only on mobile (%s)",
    (mobile) => {
      renderComposer({
        mobile,
        isSelectedThreadAI: true,
        selectedThread: { key: "thread-mobile", label: "Agent" } as any,
      });
      expect(lastCodexConfigProps.compact).toBe(
        mobile ? "mobile-composer" : "composer",
      );
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Codex settings" }),
      ).toBeTruthy();
    },
  );
  beforeEach(() => {
    lastChatInputProps = undefined;
    mockStoredHeight = null;
  });

  it("allows agent mentions only in explicit ACP or new Codex threads", () => {
    expect(
      allowAgentMentionsInComposer({
        agentKind: "none",
        hasSelectedThread: true,
        isNewThreadCodex: false,
      }),
    ).toBe(false);
    expect(
      allowAgentMentionsInComposer({
        agentKind: undefined,
        hasSelectedThread: true,
        isNewThreadCodex: false,
      }),
    ).toBe(false);
    expect(
      allowAgentMentionsInComposer({
        agentKind: "acp",
        hasSelectedThread: true,
        isNewThreadCodex: false,
      }),
    ).toBe(true);
    expect(
      allowAgentMentionsInComposer({
        agentKind: "none",
        hasSelectedThread: false,
        isNewThreadCodex: true,
      }),
    ).toBe(true);
    expect(
      allowAgentMentionsInComposer({
        agentKind: "none",
        hasSelectedThread: true,
        isNewThreadCodex: true,
      }),
    ).toBe(false);
  });

  it("checks approved sends against the live editor instead of debounced state", () => {
    expect(
      approvedDraftIsCurrent({
        approvedDraft: "latest editor draft",
        editorDraft: "latest editor draft",
      }),
    ).toBe(true);
    expect(
      approvedDraftIsCurrent({
        approvedDraft: "latest editor draft",
        editorDraft: undefined,
      }),
    ).toBe(true);
    expect(
      approvedDraftIsCurrent({
        approvedDraft: "approved draft",
        editorDraft: "changed during approval",
      }),
    ).toBe(false);
  });

  it("prepares naming before the first turn using the latest private editor draft, without sending", async () => {
    const user = userEvent.setup();
    const prepare = jest.fn(async () => "prepared-thread");
    const send = jest.fn();
    renderComposer({
      isNewThreadCodex: true,
      input: "older debounced value",
      hasInput: true,
      onPrepareAgentThread: prepare,
      on_send: send,
    });
    lastChatInputProps.inputControlRef.current = {
      getValue: () => "latest private draft with the newly selected reference",
      focus: () => true,
      captureSelection: () => null,
      insertText: () => true,
    };
    screen.getByRole("button", { name: "Name agent" }).focus();
    await user.keyboard("{Enter}");
    expect(prepare).toHaveBeenCalledWith(
      "latest private draft with the newly selected reference",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["button", "keyboard callback"])(
    "snapshots the live editor for %s sends despite serialized newline differences",
    async (method) => {
      const user = userEvent.setup();
      const send = jest.fn();
      renderComposer({
        input: "unsupported-file-write\n",
        hasInput: true,
        on_send: send,
      });
      lastChatInputProps.inputControlRef.current = {
        getValue: () => "unsupported-file-write\n\n",
        focus: () => true,
      };
      if (method === "button") {
        screen.getByRole("button", { name: "Send" }).focus();
        await user.keyboard("{Enter}");
      } else {
        await act(async () => {
          lastChatInputProps.on_send("unsupported-file-write\n");
        });
      }
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("unsupported-file-write\n\n");
    },
  );

  it.each([false, true])(
    "shows the selected thread title without a custom appearance (AI: %s)",
    async (isAI) => {
      const user = userEvent.setup();
      const onEditThreadAppearance = jest.fn();
      const onSend = jest.fn();
      renderComposer({
        onEditThreadAppearance,
        on_send: onSend,
        selectedThread: {
          key: "thread-1",
          label: "Original title",
          displayLabel: "Goal UI smoke test",
          newestTime: 0,
          messageCount: 1,
          hasCustomName: true,
          hasCustomAppearance: false,
          readCount: 1,
          unreadCount: 0,
          isAI,
          isAutomation: false,
          isPinned: false,
          isArchived: false,
        },
        actions: {
          syncdb: {},
          getThreadMetadata: () => ({ agent_kind: isAI ? "acp" : "none" }),
          isCodexThread: () => isAI,
        } as any,
      });

      const title = screen.getByText("Goal UI smoke test");
      expect(title.getAttribute("title")).toBe("Goal UI smoke test");
      expect(title.parentElement?.style.marginLeft).toBe("auto");
      const edit = screen.getByRole("button", {
        name: "Edit Thread Appearance: Goal UI smoke test",
      });
      expect(edit.getAttribute("aria-haspopup")).toBe("dialog");
      await user.click(edit);
      expect(onEditThreadAppearance).toHaveBeenCalledTimes(1);
      edit.focus();
      await user.keyboard("{Enter}");
      expect(onEditThreadAppearance).toHaveBeenCalledTimes(2);
      await user.keyboard(" ");
      expect(onEditThreadAppearance).toHaveBeenCalledTimes(3);
      expect(onSend).not.toHaveBeenCalled();
      if (isAI) {
        await user.click(
          screen.getByRole("button", { name: "Add files and more" }),
        );
        expect(
          await screen.findByRole("menuitem", { name: "Set goal" }),
        ).not.toBeNull();
      }
    },
  );

  it("hides the identity row when requested by an embedded surface", () => {
    renderComposer(
      {
        selectedThread: {
          key: "thread-embedded",
          label: "Agent thread title",
          newestTime: 0,
          messageCount: 1,
          hasCustomName: true,
          hasCustomAppearance: false,
          readCount: 1,
          unreadCount: 0,
          isAI: true,
          isAutomation: false,
          isPinned: false,
          isArchived: false,
        },
        onEditThreadAppearance: jest.fn(),
      },
      { hideComposerIdentity: true },
    );

    expect(
      screen.queryByRole("button", {
        name: "Edit Thread Appearance: Agent thread title",
      }),
    ).toBeNull();
    expect(screen.getByTestId("chat-input-focus-probe")).toBeInTheDocument();
  });

  it("resizing reserves room for the current draft without disabling autosizing", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderComposer();
    jest
      .spyOn(screen.getByTestId("chat-composer-input"), "getBoundingClientRect")
      .mockReturnValue({ height: 50 } as DOMRect);
    const handle = screen.getByRole("separator", { name: "Resize composer" });
    expect(handle).toHaveAttribute("aria-valuetext", "Fits the text");
    handle.focus();
    await user.keyboard("{ArrowUp}");
    // A minimum height: the editor still grows with its text.
    expect(lastChatInputProps.height).toBeUndefined();
    expect(lastChatInputProps.autoGrow).toBe(true);
    expect(lastChatInputProps.autoGrowMinHeight).toBe(70);
    expect(handle).toHaveAttribute("aria-valuetext", "At least 70 pixels");
    // Down to about one line, not below.
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(lastChatInputProps.autoGrowMinHeight).toBe(40);
    await user.keyboard("{ArrowUp}{ArrowUp}{Home}");
    expect(lastChatInputProps.autoGrowMinHeight).toBe(40);
    expect(handle).toHaveAttribute("aria-valuetext", "Fits the text");
    expect(handle).toHaveFocus();

    // The reserved room belongs to one draft: sending resets it.
    await user.keyboard("{ArrowUp}");
    expect(lastChatInputProps.autoGrowMinHeight).toBe(70);
    rerender(
      <ChatEmbeddingOptionsProvider value={{} as any}>
        <ChatRoomComposer {...props} composerSession={2} />
      </ChatEmbeddingOptionsProvider>,
    );
    expect(lastChatInputProps.autoGrowMinHeight).toBe(40);
  });

  it("never lets the handle be dragged out of reach", async () => {
    const user = userEvent.setup();
    renderComposer();
    const handle = screen.getByRole("separator", { name: "Resize composer" });
    // 60% of jsdom's 768px viewport.
    expect(handle).toHaveAttribute("aria-valuemax", "461");
    handle.focus();
    for (let i = 0; i < 40; i++) await user.keyboard("{ArrowUp}");
    expect(lastChatInputProps.autoGrowMinHeight).toBe(461);
  });

  it("keeps dictation in the composer control rail", () => {
    renderComposer({ hasInput: true, input: "draft" });

    const dictate = screen.getByRole("button", { name: "Dictate message" });
    const actions = screen.getByTestId("chat-composer-actions");
    expect(actions.contains(dictate)).toBe(true);
    expect(actions.contains(screen.getByRole("button", { name: "Send" }))).toBe(
      true,
    );
  });

  it("offers goal controls for legacy Codex thread metadata", async () => {
    const user = userEvent.setup();
    renderComposer({
      selectedThread: {
        key: "thread-legacy",
        label: "Legacy Codex",
        newestTime: 0,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 1,
        unreadCount: 0,
        isAI: true,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
      },
      actions: {
        syncdb: {},
        getThreadMetadata: () => ({
          agent_kind: "none",
          agent_model: "gpt-5.6",
        }),
        isCodexThread: () => true,
      } as any,
    });

    await user.click(
      screen.getByRole("button", { name: "Add files and more" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Set goal" }),
    ).not.toBeNull();
  });

  it("does not add a divider beside the thread title", () => {
    renderComposer({
      selectedThread: {
        key: "thread-accent",
        label: "hi",
        displayLabel: "hi",
        newestTime: 0,
        messageCount: 1,
        hasCustomName: true,
        hasCustomAppearance: true,
        readCount: 1,
        unreadCount: 0,
        isAI: false,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
        threadColor: "#1677ff",
      },
      onEditThreadAppearance: jest.fn(),
    });

    const title = screen.getByRole("button", {
      name: "Edit Thread Appearance: hi",
    });
    expect(title.style.borderLeft).toBe("0px");
    expect(title.style.paddingLeft).toBe("4px");
  });

  it("uses the shared attachment and submit controls for human chats", () => {
    renderComposer({
      selectedThread: {
        key: "thread-human",
        label: "Human thread",
        newestTime: 0,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 1,
        unreadCount: 0,
        isAI: false,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
      },
    });

    expect(
      screen.getByRole("button", { name: "Add files and more" }),
    ).not.toBeNull();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    expect(send.style.width).toBe("32px");
    expect(send.style.height).toBe("32px");
  });

  it("keeps execution settings available for AI threads without ACP metadata", () => {
    renderComposer({
      isSelectedThreadAI: true,
      selectedThread: {
        key: "thread-ai",
        label: "AI thread",
        newestTime: 0,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 1,
        unreadCount: 0,
        isAI: true,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
      },
    });

    expect(
      screen.getByRole("button", { name: "Codex settings" }),
    ).not.toBeNull();
  });

  it("uses a product-neutral prompt for agent chats", () => {
    renderComposer({
      isSelectedThreadAI: true,
      selectedThread: {
        key: "thread-agent",
        label: "Agent thread",
        newestTime: 0,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 1,
        unreadCount: 0,
        isAI: true,
        isAutomation: false,
        isPinned: false,
        isArchived: false,
      },
      actions: {
        syncdb: {},
        getThreadMetadata: () => ({ agent_kind: "acp" }),
        isCodexThread: () => true,
      } as any,
    });

    expect(lastChatInputProps.placeholder).toBe(
      "What would you like to work on?",
    );
  });

  it("shows a proactive Codex setup banner for unconfigured AI chats", () => {
    const onOpenCodexPaymentConfig = jest.fn();
    renderComposer({
      codexPaymentSource: { source: "none" } as any,
      isSelectedThreadAI: true,
      onOpenCodexPaymentConfig,
    });

    expect(
      screen.getByText(
        "To use AI in CoCalc, connect a ChatGPT plan or OpenAI API key.",
      ),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Connect AI" }));
    expect(onOpenCodexPaymentConfig).toHaveBeenCalled();
  });

  it.each([false, true])(
    "separates native goals and payment setup from generic runtime=%s",
    (generic) => {
      renderComposer({
        selectedThread: { key: "thread", label: "Agent" } as any,
        actions: {
          syncdb: {},
          isCodexThread: () => true,
          getThreadMetadata: () => ({
            agent_kind: "acp",
            ...(generic ? { agent_runtime: { kind: "acp" } } : {}),
            acp_goal: {
              goal: {
                objective: "Legacy goal",
                status: "active",
                tokensUsed: 0,
                timeUsedSeconds: 0,
              },
            },
          }),
        } as any,
        isSelectedThreadAI: true,
        codexPaymentSource: { source: "none" } as any,
        onOpenCodexPaymentConfig: jest.fn(),
      });
      const goal = screen.queryByRole("button", {
        name: "Goal: Legacy goal (active)",
      });
      const payment = screen.queryByRole("button", { name: "Connect AI" });
      expect(screen.getByRole("button", { name: "Name agent" })).not.toBeNull();
      if (generic) {
        expect(goal).toBeNull();
        expect(payment).toBeNull();
      } else {
        expect(goal).not.toBeNull();
        expect(payment).not.toBeNull();
      }
    },
  );

  it("does not show the Codex setup banner while payment source is loading", () => {
    renderComposer({
      codexPaymentSource: { source: "none" } as any,
      codexPaymentSourceLoading: true,
      isSelectedThreadAI: true,
    });

    expect(
      screen.queryByText(
        "To use AI in CoCalc, connect a ChatGPT plan or OpenAI API key.",
      ),
    ).toBeNull();
  });

  it("distinguishes the current model from membership without changing the conversation", async () => {
    const user = userEvent.setup();
    const onOpenCodexPaymentConfig = jest.fn();
    renderComposer({
      codexPaymentSource: {
        source: "none",
        hasSiteApiKey: true,
        siteAiUsageLimitPositive: true,
        siteFundedCodex: { enabled: true },
      } as any,
      isSelectedThreadAI: true,
      onOpenCodexPaymentConfig,
    });
    expect(
      screen.queryByText(
        "To use AI in CoCalc, connect a ChatGPT plan or OpenAI API key.",
      ),
    ).toBeNull();
    expect(
      screen.getByText(
        /To continue using this model.*CoCalc Membership is available for new conversations with its included model/,
      ),
    ).toBeVisible();
    const paymentSettings = screen.getByRole("button", {
      name: "Payment settings",
    });
    paymentSettings.focus();
    expect(paymentSettings).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onOpenCodexPaymentConfig).toHaveBeenCalledTimes(1);
  });

  it.each([
    { hasSiteApiKey: false },
    { siteAiUsageLimitPositive: false },
    { siteFundedCodex: { enabled: false } },
  ])("does not advertise unavailable membership: %j", (unavailable) => {
    renderComposer({
      codexPaymentSource: {
        source: "none",
        hasSiteApiKey: true,
        siteAiUsageLimitPositive: true,
        siteFundedCodex: { enabled: true },
        ...unavailable,
      } as any,
      isSelectedThreadAI: true,
      onOpenCodexPaymentConfig: jest.fn(),
    });
    expect(screen.queryByText(/CoCalc Membership is available/)).toBeNull();
    expect(screen.getByRole("button", { name: "Connect AI" })).toBeVisible();
  });

  it("shows the Codex setup banner for site-billed AI sources", () => {
    renderComposer({
      codexPaymentSource: {
        source: "site-api-key",
        siteAiUsageLimitPositive: false,
      } as any,
      isSelectedThreadAI: true,
    });

    expect(
      screen.getByText(
        "To use AI in CoCalc, connect a ChatGPT plan or OpenAI API key.",
      ),
    ).not.toBeNull();
  });

  it("does not show the Codex setup banner for positive site-billed AI limits", () => {
    renderComposer({
      codexPaymentSource: {
        source: "site-api-key",
        siteAiUsageLimitPositive: true,
      } as any,
      isSelectedThreadAI: true,
    });

    expect(
      screen.queryByText(
        "To use AI in CoCalc, connect a ChatGPT plan or OpenAI API key.",
      ),
    ).toBeNull();
  });

  it("uses Send as the idle primary action and puts fullscreen in the menu", () => {
    const onSend = jest.fn();
    const onSendImmediately = jest.fn();
    renderComposer({
      hasInput: true,
      input: "hello",
      isSelectedThreadAI: true,
      on_send: onSend,
      on_send_immediately: onSendImmediately,
    });

    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Fullscreen" })).not.toBeNull();
    expect(lastChatInputProps.toolbarRightContent).toBeUndefined();

    act(() => {
      lastChatInputProps.on_send("hello");
    });
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(onSendImmediately).not.toHaveBeenCalled();
  });

  it("switches the running-turn primary action between Steer and Queue", async () => {
    const onSend = jest.fn();
    const onSendImmediately = jest.fn();
    renderComposer({
      mobile: true,
      hasActiveAcpTurn: true,
      hasInput: true,
      input: "guidance",
      isSelectedThreadAI: true,
      on_send: onSend,
      on_send_immediately: onSendImmediately,
    });

    const steer = screen.getByRole("button", { name: "Steer" });
    expect(steer.className).toContain("ant-btn-primary");
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();

    act(() => {
      lastChatInputProps.on_send("shift-enter guidance");
    });
    expect(onSendImmediately).toHaveBeenCalledWith("shift-enter guidance");
    expect(onSend).not.toHaveBeenCalled();

    act(() => {
      lastChatInputProps.on_queue("alt-enter guidance");
    });
    expect(onSend).toHaveBeenCalledWith("alt-enter guidance");

    await userEvent.click(
      screen.getByRole("button", { name: "Message delivery: To Agent" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Queue Alt\+Enter/ }),
    );
    expect(
      screen.getByRole("button", { name: "Message delivery: Queue" }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    expect(onSend).toHaveBeenCalledWith("guidance");
  });

  it("queues generic ACP follow-ups from the keyboard and primary button", () => {
    const onSend = jest.fn();
    const onSendImmediately = jest.fn();
    renderComposer({
      selectedThread: { key: "generic-thread" } as any,
      actions: {
        syncdb: {},
        getThreadMetadata: () => ({
          agent_kind: "acp",
          agent_runtime: { kind: "acp" },
        }),
        isCodexThread: () => true,
      } as any,
      hasActiveAcpTurn: true,
      hasInput: true,
      input: "follow-up",
      isSelectedThreadAI: true,
      on_send: onSend,
      on_send_immediately: onSendImmediately,
    });
    expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
    const queue = screen.getByRole("button", { name: "Queue" });
    expect(queue.className).toContain("ant-btn-primary");
    act(() => lastChatInputProps.on_send("keyboard follow-up"));
    expect(onSend).toHaveBeenCalledWith("keyboard follow-up");
    fireEvent.click(queue);
    expect(onSend).toHaveBeenCalledWith("follow-up");
    expect(onSendImmediately).not.toHaveBeenCalled();
  });

  it("offers live guidance and explicit queueing for a running qualified Claude turn", async () => {
    const onSend = jest.fn();
    const onSendImmediately = jest.fn();
    renderComposer({
      selectedThread: { key: "claude-thread" } as any,
      actions: {
        syncdb: {},
        getThreadMetadata: () => ({
          agent_kind: "acp",
          agent_runtime: {
            version: 1,
            kind: "acp",
            profile: { version: 2, id: "claude-code" },
          },
        }),
        isCodexThread: () => true,
      } as any,
      hasActiveAcpTurn: true,
      hasInput: true,
      input: "guidance",
      isSelectedThreadAI: true,
      on_send: onSend,
      on_send_immediately: onSendImmediately,
    });
    expect(screen.getByRole("button", { name: "Steer" })).not.toBeNull();
    act(() => lastChatInputProps.on_send("keyboard guidance"));
    expect(onSendImmediately).toHaveBeenCalledWith("keyboard guidance");
    expect(onSend).not.toHaveBeenCalled();
    const user = userEvent.setup();
    const delivery = screen.getByRole("button", {
      name: "Message delivery: To Agent",
    });
    delivery.focus();
    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole("menuitem", { name: /Queue Alt\+Enter/ }),
    );
    expect(delivery).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    expect(onSend).toHaveBeenCalledWith("guidance");
  });

  it("keeps settings popovers and dialogs inside the fullscreen composer", async () => {
    const user = userEvent.setup();
    const fullscreenDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "fullscreenElement",
    );
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    try {
      renderComposer({
        isSelectedThreadAI: true,
        selectedThread: { key: "thread-ai" } as any,
      });
      const composer = screen.getByTestId("chat-composer");
      composer.requestFullscreen = async () => {
        fullscreenElement = composer;
        document.dispatchEvent(new Event("fullscreenchange"));
      };
      await user.click(
        screen.getByRole("button", { name: "Fullscreen", exact: true }),
      );

      screen.getByRole("button", { name: "Codex settings" }).focus();
      await user.keyboard("{Enter}");
      const chooseModel = await screen.findByRole("button", {
        name: "Choose model",
      });
      expect(composer).toContainElement(chooseModel);
      chooseModel.focus();
      await user.keyboard("{Enter}");
      const dialog = await screen.findByRole("dialog", {
        name: "Model settings",
      });
      expect(composer).toContainElement(dialog);
      within(dialog).getByRole("button", { name: "Close" }).focus();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(dialog).not.toBeVisible());

      act(() => {
        fullscreenElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      });
      expect(
        screen.getByRole("button", { name: "Fullscreen", exact: true }),
      ).toBeVisible();
    } finally {
      if (fullscreenDescriptor) {
        Object.defineProperty(
          document,
          "fullscreenElement",
          fullscreenDescriptor,
        );
      } else {
        delete (document as any).fullscreenElement;
      }
    }
  });

  it("keeps phone input readable and expands without browser fullscreen", async () => {
    const requestFullscreen = jest.fn();
    const original = HTMLElement.prototype.requestFullscreen;
    HTMLElement.prototype.requestFullscreen = requestFullscreen;
    try {
      renderComposer({
        mobile: true,
        hasInput: true,
        input: "draft",
        fontSize: 13,
      });
      expect(lastChatInputProps.fontSize).toBe(16);
      expect(lastChatInputProps.autoFocus).toBe(false);
      expect(screen.getByTestId("chat-composer").style.flexDirection).toBe(
        "column",
      );
      expect(
        screen.getByTestId("chat-composer-actions").style.flexDirection,
      ).toBe("row");
      expect(screen.getByTestId("chat-composer-actions").style.flexWrap).toBe(
        "nowrap",
      );
      expect(
        screen.getByRole("group", { name: "Message options" }),
      ).toHaveStyle({ flexWrap: "wrap", minWidth: 0 });
      expect(
        screen.getByTestId("chat-composer-input").parentElement?.style.order,
      ).toBe("");
      expect(
        screen.getByTestId("chat-composer-input").parentElement?.style.width,
      ).toBe("100%");
      await userEvent.click(
        screen.getByRole("button", { name: "Fullscreen", exact: true }),
      );
      expect(requestFullscreen).not.toHaveBeenCalled();
      expect(screen.getByTestId("chat-composer").style.position).toBe("fixed");
      await userEvent.click(
        screen.getByRole("button", { name: "Exit fullscreen", exact: true }),
      );
      expect(screen.getByTestId("chat-composer").style.position).toBe("");
    } finally {
      HTMLElement.prototype.requestFullscreen = original;
    }
  });

  it.each([false, true])(
    "reserves the right-hand submit column while desktop/mobile options wrap (%s)",
    async (mobile) => {
      const send = jest.fn();
      const steer = jest.fn();
      renderComposer({
        mobile,
        hasActiveAcpTurn: true,
        hasInput: true,
        input: "guidance",
        acpPrompt: "Full agent prompt",
        isSelectedThreadAI: true,
        selectedThread: { key: "thread-layout", label: "Agent" } as any,
        actions: {
          syncdb: {},
          getThreadMetadata: () => ({ agent_kind: "acp" }),
          isCodexThread: () => true,
        } as any,
        on_send: send,
        on_send_immediately: steer,
        on_post: jest.fn(),
      });
      const row = screen.getByRole("group", { name: "Message actions" });
      const options = within(row).getByRole("group", {
        name: "Message options",
      });
      const submit = within(row).getByRole("button", { name: "Steer" });
      expect(row).toHaveStyle({
        display: "flex",
        flexWrap: "nowrap",
        alignItems: "flex-end",
      });
      expect(options).toHaveStyle({
        flex: "1 1 0",
        minWidth: 0,
        flexWrap: "wrap",
      });
      expect(submit).toHaveStyle({ flex: "0 0 32px", width: "32px" });
      expect(submit.parentElement).toBe(row);
      expect(options).not.toContainElement(submit);
      for (const name of [
        "Add files and more",
        "Agent Prompt",
        "Message delivery: To Agent",
      ]) {
        expect(within(options).getByRole("button", { name })).toBeEnabled();
      }
      // Conversation settings are below the message box, not among its actions.
      const settings = screen.getByRole("group", {
        name: "Conversation settings",
      });
      expect(
        within(settings).getByRole("button", { name: "Codex settings" }),
      ).toBeEnabled();
      expect(screen.getByTestId("chat-composer-box")).not.toContainElement(
        settings,
      );
      const user = userEvent.setup();
      const delivery = within(options).getByRole("button", {
        name: "Message delivery: To Agent",
      });
      delivery.focus();
      await user.keyboard("{Enter}");
      const queue = await screen.findByRole("menuitem", {
        name: /Queue Alt\+Enter/,
      });
      await user.click(queue);
      expect(delivery).toHaveFocus();
      expect(
        within(options).getByRole("button", {
          name: "Message delivery: Queue",
        }),
      ).toBe(delivery);
      await user.tab();
      const queueSubmit = within(row).getByRole("button", {
        name: "Queue message",
      });
      expect(queueSubmit).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(send).toHaveBeenCalledWith("guidance");
      await user.tab({ shift: true });
      expect(delivery).toHaveFocus();
      await user.keyboard("{Enter}");
      await user.click(
        await screen.findByRole("menuitem", { name: /To Agent Shift\+Enter/ }),
      );
      await user.tab();
      expect(submit).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(steer).toHaveBeenCalledWith("guidance");
    },
  );
});
