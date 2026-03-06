/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { ChatRoomLayout } from "../chatroom-layout";

const mockEraseActiveKeyHandler = jest.fn();

jest.mock("antd", () => {
  const Button = ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
  const Drawer = ({ children, open }: any) =>
    open ? <div data-testid="chat-drawer">{children}</div> : null;
  const Layout = ({ children }: any) => <div>{children}</div>;
  Layout.Content = ({ children }: any) => <div>{children}</div>;
  const Badge = ({ children }: any) => <span>{children}</span>;
  return { Badge, Button, Drawer, Layout };
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: {
    createElement: require("react").createElement,
    Fragment: require("react").Fragment,
  },
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? { erase_active_key_handler: mockEraseActiveKeyHandler }
        : undefined,
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("../chatroom-sidebar", () => ({
  ChatRoomSidebar: ({ children }: any) => <div>{children}</div>,
}));

describe("ChatRoomLayout keyboard boundary", () => {
  beforeEach(() => {
    mockEraseActiveKeyHandler.mockClear();
  });

  it("wraps compact drawer content in a keyboard boundary", () => {
    render(
      <ChatRoomLayout
        variant="compact"
        sidebarWidth={300}
        setSidebarWidth={jest.fn()}
        sidebarVisible={true}
        setSidebarVisible={jest.fn()}
        totalUnread={0}
        sidebarContent={<input data-testid="chat-sidebar-input" />}
        chatContent={<div>chat</div>}
        onNewChat={jest.fn()}
        newChatSelected={false}
      />,
    );

    expect(
      document.querySelector('[data-cocalc-keyboard-boundary="chat-drawer"]'),
    ).toBeTruthy();

    fireEvent.focus(screen.getByTestId("chat-sidebar-input"));

    expect(mockEraseActiveKeyHandler).toHaveBeenCalledTimes(1);
  });
});
