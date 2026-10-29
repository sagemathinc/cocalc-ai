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

import { PeopleUnreadAnnouncer, PeopleUnreadBadge } from "./unread-badge";

test("the announcer is a live region that stays mounted and says each change, including back to zero", () => {
  mockUnread = { count: 0, loaded: true, account_id: A };
  const { rerender } = render(<PeopleUnreadAnnouncer />);
  const region = screen.getByRole("status");
  expect(region).toHaveAttribute("aria-live", "polite");
  // Nothing was ever unread: nothing to announce.
  expect(region.textContent).toBe("");

  mockUnread = { count: 3, loaded: true, account_id: A };
  rerender(<PeopleUnreadAnnouncer />);
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("3 unread conversations");

  mockUnread = { count: 1, loaded: true, account_id: A };
  rerender(<PeopleUnreadAnnouncer />);
  expect(region.textContent).toBe("1 unread conversation");

  mockUnread = { count: 0, loaded: true, account_id: A };
  rerender(<PeopleUnreadAnnouncer />);
  expect(screen.getByRole("status")).toBe(region);
  expect(region.textContent).toBe("No unread conversations");
});

test("after switching accounts, nothing is announced until the new list says so", () => {
  mockUnread = { count: 2, loaded: true, account_id: A };
  const { rerender } = render(<PeopleUnreadAnnouncer />);
  const region = screen.getByRole("status");
  expect(region.textContent).toBe("2 unread conversations");

  // Signed in as B: the list is loading, so 0 means nothing yet.
  mockUnread = { count: 0, loaded: false, account_id: B };
  rerender(<PeopleUnreadAnnouncer />);
  expect(region.textContent).toBe("");

  // B's list has nothing unread, and B never had anything unread here.
  mockUnread = { count: 0, loaded: true, account_id: B };
  rerender(<PeopleUnreadAnnouncer />);
  expect(region.textContent).toBe("");

  mockUnread = { count: 1, loaded: true, account_id: B };
  rerender(<PeopleUnreadAnnouncer />);
  expect(region.textContent).toBe("1 unread conversation");
});

test("a badge is quiet: no live region, but the count stays in its name", () => {
  mockUnread = { count: 5, loaded: true, account_id: A };
  const { container } = render(<PeopleUnreadBadge />);
  const badge = container.querySelector(".ant-badge");
  expect(badge).not.toBeNull();
  expect(badge).toHaveAttribute("aria-hidden", "true");
  expect(badge?.textContent).toContain("5");
  expect(screen.queryByRole("status")).toBeNull();
  expect(container.querySelector("[aria-live]")).toBeNull();
  expect(container.textContent).toContain(" 5 unread conversations");
});

test("no badge while nothing is unread, or while loading", () => {
  mockUnread = { count: 0, loaded: true, account_id: A };
  expect(render(<PeopleUnreadBadge />).container.textContent).toBe("");
  mockUnread = { count: 4, loaded: false, account_id: B };
  expect(render(<PeopleUnreadBadge />).container.textContent).toBe("");
});

test("with badges in the sidebar and the menu, each change is announced once", () => {
  mockUnread = { count: 2, loaded: true, account_id: A };
  const { container } = render(
    <>
      <PeopleUnreadBadge />
      <PeopleUnreadBadge />
      <PeopleUnreadAnnouncer />
    </>,
  );
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
});
