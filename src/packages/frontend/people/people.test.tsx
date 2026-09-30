/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ListedConversation } from "@cocalc/util/conversations";
import { ConversationList } from "./conversation-list";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/account/avatar/avatar-stack", () => ({
  AvatarStack: () => null,
}));
jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: () => null,
}));

const base = {
  project_id: "11111111-1111-4111-8111-111111111111",
  path: "/home/user/a.chat",
  created_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  created: 1000,
  participant_ids: [],
};

const conversations: ListedConversation[] = [
  {
    ...base,
    conversation_id: "c1",
    title: "Pinned and read",
    last_activity: 2000,
    pinned: true,
    last_read: 2000,
  },
  {
    ...base,
    conversation_id: "c2",
    title: "Recent and unread",
    last_activity: 3000,
    pinned: false,
    last_read: 1000,
  },
];

it("groups pinned conversations and announces unread ones", () => {
  render(
    <ConversationList conversations={conversations} onSelect={jest.fn()} />,
  );
  const pinned = screen.getByRole("region", { name: "Pinned" });
  expect(
    within(pinned).getByRole("button", { name: "Pinned and read" }),
  ).toBeInTheDocument();
  const recent = screen.getByRole("region", { name: "Recent" });
  expect(
    within(recent).getByRole("button", { name: "Recent and unread (unread)" }),
  ).toBeInTheDocument();
});

it("opens a conversation with a native button and marks the current one", () => {
  const onSelect = jest.fn();
  render(
    <ConversationList
      conversations={conversations}
      selected="c1"
      onSelect={onSelect}
    />,
  );
  expect(screen.getByRole("button", { current: true })).toHaveAccessibleName(
    "Pinned and read",
  );
  const unread = screen.getByRole("button", { name: /Recent and unread/ });
  unread.focus();
  expect(unread).toHaveFocus();
  fireEvent.click(unread);
  expect(onSelect).toHaveBeenCalledWith(conversations[1]);
});

it("shows the empty text when there are no conversations", () => {
  render(
    <ConversationList
      conversations={[]}
      onSelect={jest.fn()}
      emptyText="None"
    />,
  );
  expect(screen.getByText("None")).toBeInTheDocument();
});
