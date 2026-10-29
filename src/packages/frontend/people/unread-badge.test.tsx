/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let mockUnread = { count: 0, loaded: true, account_id: A as string };
jest.mock("./use-conversations", () => ({
  useUnreadConversations: () => mockUnread,
}));

import { PeopleUnreadBadge } from "./unread-badge";

test("a live region that stays mounted announces count changes, including back to zero", () => {
  mockUnread = { count: 0, loaded: true, account_id: A };
  const { rerender } = render(<PeopleUnreadBadge />);
  const region = screen.getByRole("status");
  expect(region).toHaveAttribute("aria-live", "polite");
  // Nothing was ever unread: nothing to announce.
  expect(region.textContent).toBe("");

  mockUnread = { count: 3, loaded: true, account_id: A };
  rerender(<PeopleUnreadBadge />);
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("3 unread conversations");

  mockUnread = { count: 1, loaded: true, account_id: A };
  rerender(<PeopleUnreadBadge />);
  expect(region.textContent).toBe("1 unread conversation");

  mockUnread = { count: 0, loaded: true, account_id: A };
  rerender(<PeopleUnreadBadge />);
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("No unread conversations");
});

test("after switching accounts, nothing is announced until the new list says so", () => {
  mockUnread = { count: 2, loaded: true, account_id: A };
  const { rerender } = render(<PeopleUnreadBadge />);
  const region = screen.getByRole("status");
  expect(region.textContent).toBe("2 unread conversations");

  // Signed in as B: the list is loading, so 0 means nothing yet.
  mockUnread = { count: 0, loaded: false, account_id: B };
  rerender(<PeopleUnreadBadge />);
  expect(region.textContent).toBe("");
  expect(document.querySelector(".ant-badge")).toBeNull();

  // B's list has nothing unread, and B never had anything unread here.
  mockUnread = { count: 0, loaded: true, account_id: B };
  rerender(<PeopleUnreadBadge />);
  expect(region.textContent).toBe("");

  mockUnread = { count: 1, loaded: true, account_id: B };
  rerender(<PeopleUnreadBadge />);
  expect(region.textContent).toBe("1 unread conversation");
});

test("the visible badge shows the count and is hidden from screen readers", () => {
  mockUnread = { count: 5, loaded: true, account_id: A };
  const { container } = render(<PeopleUnreadBadge />);
  const badge = container.querySelector(".ant-badge");
  expect(badge).not.toBeNull();
  expect(badge).toHaveAttribute("aria-hidden", "true");
  expect(badge?.textContent).toContain("5");

  mockUnread = { count: 0, loaded: true, account_id: A };
  const { container: empty } = render(<PeopleUnreadBadge />);
  expect(empty.querySelector(".ant-badge")).toBeNull();
});

test("a copy with announce={false} has no live region but keeps the count in its name", () => {
  mockUnread = { count: 2, loaded: true, account_id: A };
  const { container } = render(
    <>
      <PeopleUnreadBadge />
      <PeopleUnreadBadge announce={false} />
    </>,
  );
  // Exactly one live region, so a change is announced once.
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
  // The quiet copy still names the count for whoever reads that item.
  expect(container.textContent).toContain(" 2 unread conversations");
  expect(container.querySelectorAll(".ant-badge")).toHaveLength(2);
});
