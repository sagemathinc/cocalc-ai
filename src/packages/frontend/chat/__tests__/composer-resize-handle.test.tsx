/** @jest-environment jsdom */

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
      </>
    );
  },
}));

jest.mock("../codex", () => ({
  CodexConfigButton: (props: any) => {
    lastCodexConfigProps = props;
    return (
      <button type="button" aria-label="Codex settings">
        Codex settings
      </button>
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
  get_local_storage: jest.fn(() => null),
  set_local_storage: jest.fn(),
}));

jest.mock("../utils", () => ({
  INPUT_HEIGHT: 60,
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
  return render(
    <ChatEmbeddingOptionsProvider value={embeddingOptions}>
      <ChatRoomComposer {...props} />
    </ChatEmbeddingOptionsProvider>,
  );
}

describe("ChatRoomComposer resize handle", () => {
  it.each([false, true])(
    "uses compact settings only on mobile (%s)",
    (mobile) => {
      renderComposer({
        mobile,
        isSelectedThreadAI: true,
        selectedThread: { key: "thread-mobile", label: "Agent" } as any,
      });
      expect(lastCodexConfigProps.compact).toBe(mobile ? "icon" : "composer");
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Codex settings" }),
      ).toBeTruthy();
    },
  );
  beforeEach(() => {
    lastChatInputProps = undefined;
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

  it("does not show the resize handle when the composer is empty but focused", () => {
    const { container } = renderComposer();
    expect(container.querySelector('[style*="row-resize"]')).toBeNull();

    act(() => {
      fireEvent.focus(screen.getByTestId("chat-input-focus-probe"));
    });

    expect(container.querySelector('[style*="row-resize"]')).toBeNull();
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

  it("uses Send as the idle primary action and puts Zen in the toolbar", () => {
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
    expect(screen.getByRole("button", { name: "Zen" })).not.toBeNull();
    expect(screen.queryByText("Zen")).toBeNull();

    act(() => {
      lastChatInputProps.on_send("hello");
    });
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(onSendImmediately).not.toHaveBeenCalled();
  });

  it("makes Steer the running-turn primary action and leaves Queue explicit", () => {
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
    const queue = screen.getByRole("button", { name: "Queue" });
    expect(steer.className).toContain("ant-btn-primary");
    expect(queue.className).not.toContain("ant-btn-primary");

    act(() => {
      lastChatInputProps.on_send("shift-enter guidance");
    });
    expect(onSendImmediately).toHaveBeenCalledWith("shift-enter guidance");
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(queue);
    expect(onSend).toHaveBeenCalledWith("guidance");
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
        "wrap",
      );
      expect(
        screen.getByTestId("chat-composer-input").parentElement?.style.order,
      ).toBe("");
      expect(
        screen.getByTestId("chat-composer-input").parentElement?.style.width,
      ).toBe("100%");
      await userEvent.click(
        screen.getByRole("button", { name: "Zen", exact: true }),
      );
      expect(requestFullscreen).not.toHaveBeenCalled();
      expect(screen.getByTestId("chat-composer").style.position).toBe("fixed");
      await userEvent.click(
        screen.getByRole("button", { name: "Exit Zen", exact: true }),
      );
      expect(screen.getByTestId("chat-composer").style.position).toBe("");
    } finally {
      HTMLElement.prototype.requestFullscreen = original;
    }
  });
});
