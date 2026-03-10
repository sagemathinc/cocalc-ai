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
    combinedFeedSelected: false,
    composerTargetKey: null,
    threads: [],
    onComposerTargetChange: jest.fn(),
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
});
