import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { AccountPage } from "./account-page";

let mockWidth = 320;
let mockMobile = false;
const mockSetState = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  React,
  useIsMountedRef: () => React.useRef(true),
  useWindowDimensions: () => ({ width: mockWidth, height: 740 }),
  useTypedRedux: (store, key) =>
    store === "account"
      ? { active_page: "my-agents", account_id: "account", is_logged_in: true }[
          key
        ]
      : undefined,
  redux: {
    getActions: () => ({ setState: mockSetState, push_state: jest.fn() }),
  },
}));
jest.mock("@cocalc/frontend/feature", () => ({
  get IS_MOBILE() {
    return mockMobile;
  },
}));
jest.mock("@cocalc/frontend/account/sign-out", () => ({ SignOut: () => null }));
jest.mock("./i18n-selector", () => ({ I18NSelector: () => null }));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Loading: () => null,
  Title: ({ children }) => <h1>{children}</h1>,
}));
jest.mock("./settings-index", () => ({
  SETTINGS_OVERVIEW_PAGE: {
    key: "index",
    component: () => <p>Settings overview</p>,
    label: { id: "index", defaultMessage: "Settings" },
    icon: "cog",
  },
}));
jest.mock("./settings-page-registry", () => ({
  SETTINGS_PAGE_DEFINITIONS: {
    "my-agents": {
      key: "my-agents",
      component: () => <p>My agents directory content</p>,
      label: { id: "agents", defaultMessage: "My Agents" },
      icon: "robot",
    },
    profile: {
      key: "profile",
      component: () => <p>Profile content</p>,
      label: { id: "profile", defaultMessage: "My Profile" },
      icon: "user",
    },
  },
}));
jest.mock("./settings-page", () => ({ renderSettingsPageIcon: () => null }));
jest.mock("./settings-navigation", () => ({
  getSettingsNavigationGroupKey: () => undefined,
  useSettingsNavigationContext: () => ({}),
  getVisibleSettingsNavigation: () => [
    { type: "page", page: "my-agents" },
    { type: "page", page: "profile" },
  ],
}));

beforeEach(() => {
  mockWidth = 320;
  mockMobile = false;
  mockSetState.mockClear();
});
const Page = () => (
  <IntlProvider locale="en">
    <AccountPage />
  </IntlProvider>
);

test("320px desktop viewport uses the existing compact settings menu instead of a 220px sidebar", async () => {
  const { container } = render(<Page />);
  expect(
    container.querySelector("[data-cocalc-mobile-account-settings]"),
  ).not.toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByText("My agents directory content")).toBeTruthy();
  const menu = screen.getByRole("combobox", { name: "Settings menu" });
  menu.focus();
  // rc-select reads legacy `which`, which user-event does not populate.
  fireEvent.keyDown(menu, { key: "ArrowDown", keyCode: 40, which: 40 });
  await screen.findByRole("listbox");
  fireEvent.keyDown(menu, { key: "Escape", keyCode: 27, which: 27 });
  expect(menu).toHaveFocus();
  await waitFor(() => expect(menu).toHaveAttribute("aria-expanded", "false"));
  fireEvent.keyDown(menu, { key: "ArrowDown", keyCode: 40, which: 40 });
  await screen.findByRole("listbox");
  fireEvent.keyDown(menu, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(menu, { key: "Enter", keyCode: 13, which: 13 });
  await waitFor(() =>
    expect(mockSetState).toHaveBeenCalledWith(
      expect.objectContaining({ active_page: "profile" }),
    ),
  );
});

test("resizing automatically switches navigation while preserving the selected page", async () => {
  mockWidth = 1000;
  const user = userEvent.setup();
  const view = render(<Page />);
  const hide = screen.getByRole("button", { name: "Hide settings menu" });
  hide.focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Show settings menu" }),
  ).toHaveAttribute("aria-expanded", "false");
  mockWidth = 320;
  view.rerender(<Page />);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Settings menu" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "My Agents" })).toBeTruthy();
  expect(screen.getByText("My agents directory content")).toBeTruthy();
  mockWidth = 1000;
  view.rerender(<Page />);
  await user.click(screen.getByRole("button", { name: "Show settings menu" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Hide settings menu" }),
    ).toHaveAttribute("aria-expanded", "true"),
  );
});

test("mobile settings menu retains readable page labels", () => {
  mockMobile = true;
  render(<Page />);
  expect(screen.getByRole("combobox", { name: "Settings menu" })).toBeTruthy();
  expect(screen.getAllByText("My Agents").length).toBeGreaterThan(1);
});
