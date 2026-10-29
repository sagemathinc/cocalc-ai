/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";

let mockCount = 0;
jest.mock("./use-conversations", () => ({
  useUnreadConversationCount: () => mockCount,
}));

import { PeopleUnreadBadge } from "./unread-badge";

test("a live region that stays mounted announces count changes, including back to zero", () => {
  mockCount = 0;
  const { rerender } = render(<PeopleUnreadBadge />);
  const region = screen.getByRole("status");
  expect(region).toHaveAttribute("aria-live", "polite");
  // Nothing was ever unread: nothing to announce.
  expect(region.textContent).toBe("");

  mockCount = 3;
  rerender(<PeopleUnreadBadge />);
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("3 unread conversations");

  mockCount = 1;
  rerender(<PeopleUnreadBadge />);
  expect(region.textContent).toBe("1 unread conversation");

  mockCount = 0;
  rerender(<PeopleUnreadBadge />);
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("No unread conversations");
});

test("the visible badge shows the count and is hidden from screen readers", () => {
  mockCount = 5;
  const { container } = render(<PeopleUnreadBadge />);
  const badge = container.querySelector(".ant-badge");
  expect(badge).not.toBeNull();
  expect(badge).toHaveAttribute("aria-hidden", "true");
  expect(badge?.textContent).toContain("5");

  mockCount = 0;
  const { container: empty } = render(<PeopleUnreadBadge />);
  expect(empty.querySelector(".ant-badge")).toBeNull();
});
