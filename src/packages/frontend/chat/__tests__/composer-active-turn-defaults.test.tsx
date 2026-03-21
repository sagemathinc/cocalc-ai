/** @jest-environment jsdom */

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChatRoomComposer } from "../composer";

let latestInputProps: any;

jest.mock("../input", () => ({
  __esModule: true,
  default: (props: any) => {
    latestInputProps = props;
    return <div data-testid="chat-input-probe" />;
  },
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
  latestInputProps = undefined;
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
    input: "follow up",
    setInput: jest.fn(),
    on_send: jest.fn(),
    on_send_immediately: jest.fn(),
    submitMentionsRef: { current: undefined },
    hasInput: true,
    isSelectedThreadAI: true,
    hasActiveAcpTurn: true,
    combinedFeedSelected: false,
    composerTargetKey: null,
    threads: [],
    onComposerTargetChange: jest.fn(),
    onComposerFocusChange: jest.fn(),
    ...overrides,
  };
  return {
    ...render(<ChatRoomComposer {...props} />),
    props,
  };
}

describe("ChatRoomComposer active Codex turn defaults", () => {
  it("uses interrupt-and-send as the primary action during an active Codex turn", () => {
    const { props } = renderComposer();

    expect(screen.getByRole("button", { name: "Send Now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send Now" }));
    expect(props.on_send_immediately).toHaveBeenCalledWith("follow up");

    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(props.on_send).toHaveBeenCalledWith("follow up");
  });

  it("routes shift+enter through the immediate send path during an active Codex turn", () => {
    const { props } = renderComposer();

    act(() => {
      latestInputProps.on_send("follow up");
    });

    expect(props.on_send_immediately).toHaveBeenCalledWith("follow up");
    expect(props.on_send).not.toHaveBeenCalled();
  });
});
