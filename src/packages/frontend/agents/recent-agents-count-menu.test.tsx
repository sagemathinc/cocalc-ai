/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecentAgentsCountMenu } from "./recent-agents-count-menu";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

function setup(count = 3) {
  const onChange = jest.fn();
  render(
    <RecentAgentsCountMenu title="Recent" count={count} onChange={onChange} />,
  );
  const heading = screen.getByRole("button", {
    name: `Recent agents: showing ${count}. Change how many`,
  });
  return { onChange, heading };
}

describe("choosing how many recent agents the sidebar shows", () => {
  it("is a button that says what it shows and that it opens a menu", () => {
    const { heading } = setup(5);
    expect(heading).toHaveAttribute("aria-haspopup", "menu");
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(heading).toHaveTextContent("Recent");
  });

  it("works from the keyboard, and focus returns to the heading", async () => {
    const user = userEvent.setup();
    const { onChange, heading } = setup(3);
    await user.tab();
    expect(heading).toHaveFocus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu", {
      name: "How many recent agents to show",
    });
    expect(heading).toHaveAttribute("aria-expanded", "true");
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Show 3 recent agents",
      "Show 5 recent agents",
      "Show 7 recent agents",
      "Show 10 recent agents",
    ]);
    // The menu takes focus, so the arrow keys move within it.
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
    // Choosing an item (rc-menu's arrow keys and Enter need a layout box,
    // which jsdom never has, so the item is chosen by its role and name).
    await user.click(
      screen.getByRole("menuitem", { name: "Show 5 recent agents" }),
    );
    expect(onChange).toHaveBeenCalledWith(5);
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("aria-expanded", "false");
  });

  it("Escape closes it without a change, focus back on the heading", async () => {
    const user = userEvent.setup();
    const { onChange, heading } = setup(3);
    await user.click(heading);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(heading).toHaveAttribute("aria-expanded", "false"),
    );
    await waitFor(() => expect(heading).toHaveFocus());
    expect(onChange).not.toHaveBeenCalled();
  });
});
