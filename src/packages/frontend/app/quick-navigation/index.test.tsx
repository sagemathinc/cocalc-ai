/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import QuickNavigation from "./index";
const settings = new Map();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => settings,
}));
jest.mock("@cocalc/frontend/feature", () => ({ IS_MACOS: false }));
jest.mock("@cocalc/frontend/alerts", () => ({ alert_message: jest.fn() }));
jest.mock("./configuration", () => ({
  OPEN_NAVIGATION_EVENT: "quick-navigation-open",
  NavigationConfiguration: () => null,
}));
jest.mock("./recent-activity", () => ({
  trackRecentActivity: () => () => {},
}));
jest.mock("./use-data", () => ({
  useNavigationData: () => ({
    items: [
      {
        id: "file",
        title: "paper.tex",
        detail: "Project",
        priority: 0,
        destination: { kind: "file", projectId: "project", path: "paper.tex" },
      },
    ],
  }),
}));
jest.mock("./navigate", () => ({
  HELP_SLUG: "documentation/quick-navigation",
  navigate: jest.fn(),
}));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
  getKeyboardBoundaryElement: () => null,
}));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "",
}));
it("opens from an editor input on double Shift and restores its focus on Escape", async () => {
  render(
    <IntlProvider locale="en">
      <label>
        Editor
        <input />
      </label>
      <QuickNavigation />
    </IntlProvider>,
  );
  const editor = screen.getByRole("textbox", { name: "Editor" });
  editor.focus();
  await userEvent.keyboard("{Shift}{Shift}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("combobox")),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(editor);
});
it("does not open over another modal dialog", async () => {
  render(
    <IntlProvider locale="en">
      <div role="dialog">
        <input aria-label="Other dialog" />
      </div>
      <QuickNavigation />
    </IntlProvider>,
  );
  screen.getByRole("textbox", { name: "Other dialog" }).focus();
  await userEvent.keyboard("{Shift}{Shift}");
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("unmounts the dialog before handing keyboard focus to an editor", async () => {
  const { navigate } = jest.requireMock("./navigate");
  navigate.mockImplementation(() => {
    // A closing/hidden modal can still own rc-dialog's focus lock.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    screen.getByRole("textbox", { name: "Editor" }).focus();
  });
  render(
    <IntlProvider locale="en">
      <input aria-label="Editor" />
      <QuickNavigation />
    </IntlProvider>,
  );
  const editor = screen.getByRole("textbox", { name: "Editor" });
  editor.focus();
  await userEvent.keyboard("{Shift}{Shift}");
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("combobox")),
  );
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(document.activeElement).toBe(editor);
});
