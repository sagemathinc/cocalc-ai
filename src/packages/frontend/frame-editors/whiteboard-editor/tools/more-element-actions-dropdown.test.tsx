/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MoreElementActionsDropdown } from "./more-element-actions-dropdown";

describe("MoreElementActionsDropdown", () => {
  test.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("opens from the keyboard with %s and preserves focus", async (_, key) => {
    const user = userEvent.setup();
    render(
      <MoreElementActionsDropdown items={[{ key: "copy", label: "Copy" }]} />,
    );

    await user.tab();
    const trigger = screen.getByRole("button", {
      name: "More element actions",
    });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.keyboard(key);

    const copyItem = await screen.findByRole("menuitem", { name: "Copy" });
    await waitFor(() => expect(copyItem).toBeVisible());
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "true"),
    );
    expect(trigger).toHaveFocus();
  });
});
