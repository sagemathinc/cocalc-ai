/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { NavigationConfiguration } from "./configuration";
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
const save = jest.fn();
const settings = new Map();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => settings,
  redux: { getActions: () => ({ set_other_settings_many_and_wait: save }) },
}));
jest.mock("@cocalc/frontend/feature", () => ({ IS_MACOS: false }));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
  getKeyboardBoundaryElement: () => null,
}));
it("lets the user type the full delay before persisting it on blur", async () => {
  save.mockResolvedValue(undefined);
  render(
    <IntlProvider locale="en">
      <NavigationConfiguration />
    </IntlProvider>,
  );
  const delay = screen.getByRole("spinbutton", {
    name: "Double-tap interval (milliseconds)",
  });
  await userEvent.clear(delay);
  await userEvent.type(delay, "650");
  expect(save).not.toHaveBeenCalled();
  await userEvent.tab();
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ quick_navigation_delay: 650 }),
  );
});

it("clears a detected double tap when clicking the already focused test button", async () => {
  render(
    <IntlProvider locale="en">
      <NavigationConfiguration />
    </IntlProvider>,
  );
  const button = screen.getByRole("button", {
    name: "Focus here and double-tap Shift to test",
  });
  await userEvent.click(button);
  await userEvent.keyboard("{Shift}{Shift}");
  expect(screen.getByRole("status").textContent).toBe("Double tap detected.");
  expect(document.activeElement).toBe(button);
  await userEvent.click(button);
  expect(screen.getByRole("status").textContent).toBe("");
  await userEvent.keyboard("{Shift}{Shift}");
  expect(screen.getByRole("status").textContent).toBe("Double tap detected.");
});
