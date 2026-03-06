/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import SideChat from "../side-chat";

const mockEraseActiveKeyHandler = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  CSS: {},
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? { erase_active_key_handler: mockEraseActiveKeyHandler }
        : undefined,
    getEditorActions: jest.fn(),
  },
  useEditorRedux: () => () => undefined,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading...</div>,
}));

jest.mock("../chatroom", () => ({
  ChatPanel: () => <input data-testid="side-chat-composer" />,
}));

jest.mock("../doc-context", () => ({
  ChatDocProvider: ({ children }: any) => children,
  useChatDoc: () => ({
    messages: [],
    threadIndex: new Map(),
    version: 0,
  }),
}));

jest.mock("../register", () => ({
  isChatActions: () => true,
}));

describe("SideChat keyboard boundary", () => {
  beforeEach(() => {
    mockEraseActiveKeyHandler.mockClear();
  });

  it("marks side chat as a keyboard boundary and clears page shortcuts on focus", () => {
    render(
      <SideChat
        project_id="project-1"
        path="test.chat"
        actions={{ messageCache: {} } as any}
      />,
    );

    expect(
      document.querySelector('[data-cocalc-keyboard-boundary="side-chat"]'),
    ).toBeTruthy();

    fireEvent.focus(screen.getByTestId("side-chat-composer"));

    expect(mockEraseActiveKeyHandler).toHaveBeenCalledTimes(1);
  });
});
