/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const setActiveTab = jest.fn();
const showConnection = jest.fn();
const toggleFullscreen = jest.fn();
const openAccountSettings = jest.fn();
const openSupportTab = jest.fn();

jest.mock("antd", () => ({
  Button: ({ "aria-label": ariaLabel, children, icon, onClick }: any) => (
    <button aria-label={ariaLabel} onClick={onClick} type="button">
      {icon}
      {children}
    </button>
  ),
  Dropdown: ({ children, menu, onOpenChange, open }: any) => (
    <div onClick={() => onOpenChange(!open)}>
      {children}
      {open && (
        <div role="menu">
          {menu.items
            .filter((item) => item.type !== "divider")
            .map((item) => (
              <button
                key={item.key}
                role="menuitem"
                type="button"
                onClick={() => {
                  item.onClick?.({ key: item.key });
                  menu.onClick({ key: item.key });
                }}
              >
                {item.label}
              </button>
            ))}
        </div>
      )}
    </div>
  ),
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    useActions: () => ({
      set_active_tab: setActiveTab,
      show_connection: showConnection,
      toggle_fullscreen: toggleFullscreen,
    }),
    useEffect: React.useEffect,
    useRef: React.useRef,
    useState: React.useState,
    useTypedRedux: (store: string, field: string) => {
      if (store === "account" && field === "groups") return ["admin"];
      if (store === "customize" && field === "zendesk") return true;
      if (store === "page" && field === "fullscreen") return false;
      return undefined;
    },
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: (...args: any[]) => openAccountSettings(...args),
}));
jest.mock("@cocalc/frontend/support/open", () => ({
  __esModule: true,
  default: (...args: any[]) => openSupportTab(...args),
}));
jest.mock("@cocalc/frontend/purchases/ai-usage-warning", () => ({
  AIUsageWarning: () => null,
}));
jest.mock("@cocalc/frontend/purchases/account-cpu-warning", () => ({
  AccountCpuWarning: () => null,
}));
jest.mock("@cocalc/frontend/purchases/account-storage-warning", () => ({
  AccountStorageWarning: () => null,
}));
jest.mock("@cocalc/frontend/purchases/managed-egress-warning", () => ({
  ManagedEgressWarning: () => null,
}));
jest.mock("./connection-indicator", () => ({
  ConnectionIndicator: () => null,
}));
jest.mock("./notifications", () => ({ Notification: () => null }));

import { CompactAgentsTopNav } from "./compact-agents-top-nav";

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

describe("compact Agents navigation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("keeps routine destinations in one accessible menu", () => {
    render(<CompactAgentsTopNav isLoggedIn pageStyle={pageStyle} />);

    fireEvent.click(screen.getByRole("button", { name: "More navigation" }));
    expect(screen.getByRole("menuitem", { name: "Projects" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Notifications" }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Admin" })).toBeTruthy();
  });

  it("routes project and agent-management destinations without a reload", () => {
    render(<CompactAgentsTopNav isLoggedIn pageStyle={pageStyle} />);

    fireEvent.click(screen.getByRole("button", { name: "More navigation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Projects" }));
    expect(setActiveTab).toHaveBeenCalledWith("projects");

    fireEvent.click(screen.getByRole("button", { name: "More navigation" }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Manage agents and connections",
      }),
    );
    expect(openAccountSettings).toHaveBeenCalledWith({ page: "my-agents" });
  });

  it("runs the contextual Open in project command from the menu", () => {
    const onOpenInProject = jest.fn();
    render(
      <CompactAgentsTopNav
        isLoggedIn
        pageStyle={pageStyle}
        onOpenInProject={onOpenInProject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "More navigation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in project" }));

    expect(onOpenInProject).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    render(<CompactAgentsTopNav isLoggedIn pageStyle={pageStyle} />);
    const trigger = screen.getByRole("button", { name: "More navigation" });

    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("runs workspace actions and opens documentation without navigating away", () => {
    const openTerminal = jest.fn();
    const onOpenDocs = jest.fn();
    render(
      <CompactAgentsTopNav
        isLoggedIn
        pageStyle={pageStyle}
        onOpenDocs={onOpenDocs}
        workspaceItems={[
          {
            key: "workspace-terminal",
            label: "Open terminal",
            onClick: openTerminal,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More navigation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal" }));
    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(setActiveTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More navigation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Documentation" }));
    expect(onOpenDocs).toHaveBeenCalledTimes(1);
    expect(setActiveTab).not.toHaveBeenCalled();
  });
});
