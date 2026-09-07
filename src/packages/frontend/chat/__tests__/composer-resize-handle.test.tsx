/** @jest-environment jsdom */

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatRoomComposer } from "../composer";

let lastChatInputProps: any;

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
  return render(<ChatRoomComposer {...props} />);
}

describe("ChatRoomComposer resize handle", () => {
  beforeEach(() => {
    lastChatInputProps = undefined;
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
        expect(screen.getByRole("button", { name: "Set goal" })).not.toBeNull();
      }
    },
  );

  it("does not show the resize handle when the composer is empty but focused", () => {
    const { container } = renderComposer();
    expect(container.querySelector('[style*="row-resize"]')).toBeNull();

    act(() => {
      fireEvent.focus(screen.getByTestId("chat-input-focus-probe"));
    });

    expect(container.querySelector('[style*="row-resize"]')).toBeNull();
  });

  it("shows goal controls for legacy Codex thread metadata", () => {
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

    expect(screen.getByRole("button", { name: "Set goal" })).not.toBeNull();
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
});
