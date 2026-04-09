/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";

let mentionsUnread = 0;
let newsUnread: number | undefined = 0;
let inviteUnread = 0;
const setActiveTabMock = jest.fn();
const setWindowTitleMock = jest.fn();
const trackMock = jest.fn();

jest.mock("antd", () => ({
  Badge: ({ count, children }) => (
    <div data-testid="badge" data-count={String(count ?? "")}>
      {children}
    </div>
  ),
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    React,
    useActions: () => ({
      set_active_tab: setActiveTabMock,
    }),
    useTypedRedux: (_store: string, field: string) => {
      if (field === "unread_count") return mentionsUnread;
      if (field === "unread") return newsUnread;
      return undefined;
    },
  };
});

jest.mock("@cocalc/frontend/collaborators", () => ({
  useUnreadIncomingInviteCount: () => inviteUnread,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name, className, style }) => (
    <span
      data-testid="icon"
      data-name={name}
      className={className}
      style={style}
    />
  ),
}));

jest.mock("@cocalc/frontend/browser", () => ({
  set_window_title: (...args: any[]) => setWindowTitleMock(...args),
}));

jest.mock("@cocalc/frontend/user-tracking", () => ({
  __esModule: true,
  default: (...args: any[]) => trackMock(...args),
}));

import { Notification } from "./notifications";

const pageStyle = {
  topBarStyle: {},
  fileUseStyle: {},
  projectsNavStyle: undefined,
  fontSizeIcons: "20px",
  topPaddingIcons: "8px",
  sidePaddingIcons: "8px",
  isNarrow: false,
  height: 36,
};

describe("top-nav notifications", () => {
  beforeEach(() => {
    mentionsUnread = 0;
    newsUnread = 0;
    inviteUnread = 0;
    setActiveTabMock.mockReset();
    setWindowTitleMock.mockReset();
    trackMock.mockReset();
  });

  it("includes shared unread invite count in the badge total", () => {
    inviteUnread = 1;
    render(
      <Notification
        type="notifications"
        active={false}
        pageStyle={pageStyle}
      />,
    );
    expect(screen.getByTestId("badge").getAttribute("data-count")).toBe("1");
  });

  it("opens notifications when clicked", () => {
    render(
      <Notification
        type="notifications"
        active={false}
        pageStyle={pageStyle}
      />,
    );
    fireEvent.click(screen.getByTestId("badge"));
    expect(setActiveTabMock).toHaveBeenCalledWith("notifications");
    expect(trackMock).toHaveBeenCalledWith("top_nav", { name: "mentions" });
  });
});
