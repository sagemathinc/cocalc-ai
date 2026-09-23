/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = jest.fn();
const openAccountSettings = jest.fn();
const signOut = jest.fn();
const confirm = jest.fn();
let membershipClass = "admin";
let hasName = true;

jest.mock("antd", () => ({
  Button: ({ children, onClick, "aria-label": ariaLabel }: any) => (
    <button aria-label={ariaLabel} onClick={onClick} type="button">
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
                onClick={() => menu.onClick({ key: item.key })}
              >
                {item.label}
              </button>
            ))}
        </div>
      )}
    </div>
  ),
  Modal: { confirm: (...args: any[]) => confirm(...args) },
  Tag: ({ children }: any) => <span>{children}</span>,
}));

jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => <span data-testid="avatar" />,
}));
jest.mock("@cocalc/frontend/account/settings-routing", () => ({
  openAccountSettings: (...args: any[]) => openAccountSettings(...args),
}));
jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: (...args: any[]) => api(...args),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));
jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    redux: { getActions: () => ({ sign_out: signOut }) },
    useAsyncEffect: (fn: any, deps: any[]) => {
      React.useEffect(() => {
        let mounted = true;
        void fn(() => mounted);
        return () => {
          mounted = false;
        };
      }, deps);
    },
    useEffect: React.useEffect,
    useRef: React.useRef,
    useState: React.useState,
    useTypedRedux: (_store: string, field: string) =>
      ({
        account_id: "account-1",
        display_name: hasName ? "Ada Lovelace" : "",
        first_name: hasName ? "Ada" : "",
        last_name: hasName ? "Lovelace" : "",
        email_address: "ada@example.com",
      })[field],
  };
});

import { AgentsAccountMenu } from "./account-menu";

describe("Agents account menu", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    membershipClass = "admin";
    hasName = true;
    api.mockImplementation(async () => ({ class: membershipClass }));
  });

  it("shows account identity without a paid or admin plan badge", async () => {
    render(<AgentsAccountMenu />);

    expect(
      screen.getByRole("button", { name: "Account menu for Ada Lovelace" }),
    ).toBeTruthy();
    expect(screen.queryByText("ada@example.com")).toBeNull();
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.queryByText("Upgrade")).toBeNull();
  });

  it("offers an upgrade cue for free accounts", async () => {
    membershipClass = "free";
    render(<AgentsAccountMenu />);

    expect(await screen.findByText("Upgrade")).toBeTruthy();
  });

  it("does not fall back to email when the account has no name", async () => {
    hasName = false;
    render(<AgentsAccountMenu />);
    expect(
      screen.getByRole("button", { name: "Account menu for Account" }),
    ).toBeTruthy();
    expect(screen.queryByText("ada@example.com")).toBeNull();
    await waitFor(() => expect(api).toHaveBeenCalled());
  });

  it("routes account actions and confirms sign out", async () => {
    confirm.mockImplementation(({ onOk }) => onOk());
    render(<AgentsAccountMenu />);

    fireEvent.click(
      screen.getByRole("button", { name: "Account menu for Ada Lovelace" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Membership" }));
    expect(openAccountSettings).toHaveBeenCalledWith({ page: "membership" });

    fireEvent.click(
      screen.getByRole("button", { name: "Account menu for Ada Lovelace" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(confirm).toHaveBeenCalled();
    expect(confirm.mock.calls[0][0].title).toBe("Sign out Ada Lovelace?");
    await waitFor(() => expect(signOut).toHaveBeenCalledWith(false));
  });

  it("closes on Escape and restores focus to the account row", async () => {
    render(<AgentsAccountMenu />);
    const trigger = screen.getByRole("button", {
      name: "Account menu for Ada Lovelace",
    });

    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
