/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import SideChat from "../side-chat";

const mockEraseActiveKeyHandler = jest.fn();
const mockGetEditorActions = jest.fn();
const mockChatPanel = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  CSS: {},
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? { erase_active_key_handler: mockEraseActiveKeyHandler }
        : undefined,
    getEditorActions: (...args: any[]) => mockGetEditorActions(...args),
  },
  useEditorRedux: () => () => undefined,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>Loading...</div>,
}));

jest.mock("../chatroom", () => ({
  ChatPanel: (props: any) => {
    mockChatPanel(props);
    return <input data-testid="side-chat-composer" />;
  },
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
    mockGetEditorActions.mockReset();
    mockChatPanel.mockReset();
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

  it("ignores closed prop actions and falls back to live context actions", () => {
    const liveActions = {
      messageCache: {},
      isClosed: () => false,
    } as any;
    mockGetEditorActions.mockReturnValue(liveActions);

    render(
      <SideChat
        project_id="project-1"
        path="test.chat"
        actions={
          {
            messageCache: {},
            isClosed: () => true,
          } as any
        }
      />,
    );

    expect(mockChatPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: liveActions,
      }),
    );
  });
});
