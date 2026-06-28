/** @jest-environment jsdom */

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChatRoomComposer } from "../composer";

jest.mock("../input", () => ({
  __esModule: true,
  default: (props: any) => (
    <button
      data-testid="chat-input-focus-probe"
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      type="button"
    >
      focus-probe
    </button>
  ),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("react-intl", () => ({
  defineMessage: (value) => value,
  defineMessages: (value) => value,
  FormattedMessage: ({ defaultMessage }) => defaultMessage ?? null,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
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
  it("does not show the resize handle when the composer is empty but focused", () => {
    const { container } = renderComposer();
    expect(container.querySelector('[style*="row-resize"]')).toBeNull();

    act(() => {
      fireEvent.focus(screen.getByTestId("chat-input-focus-probe"));
    });

    expect(container.querySelector('[style*="row-resize"]')).toBeNull();
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
});
