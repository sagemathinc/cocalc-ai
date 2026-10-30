/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ListedConversation } from "@cocalc/util/people";
import { ConversationCollection } from "./conversation-collection";

const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const project_id = "11111111-1111-4111-8111-111111111111";
const mockRemove = jest.fn(async (_opts: unknown) => {});
const mockMarkRead = jest.fn(async (_opts: unknown) => {});
const mockChanged = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, field: string) =>
    store === "account" && field === "account_id" ? me : undefined,
}));
jest.mock("@cocalc/frontend/account/avatar/avatar-stack", () => ({
  AvatarStack: () => null,
}));
jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: () => null,
}));
jest.mock("./api", () => ({
  peopleApi: () => ({
    setState: jest.fn(async () => ({})),
    markRead: mockMarkRead,
    removeConversation: mockRemove,
  }),
  conversationsChanged: () => mockChanged(),
}));

function conversation(
  conversation_id: string,
  title: string,
  extra: Partial<ListedConversation> = {},
): ListedConversation {
  return {
    conversation_id,
    title,
    project_id,
    path: `/home/user/${conversation_id}.chat`,
    created_by: other,
    created: 1000,
    last_activity: 3000,
    last_sender_id: other,
    participant_ids: [other, me],
    pinned: false,
    alias: null,
    following: false,
    muted: false,
    last_read: 3000,
    mentioned_at: null,
    ...extra,
  };
}

const list = [
  conversation("a", "Alpha", { last_read: 1000 }),
  conversation("b", "Beta"),
  conversation("c", "Gamma", { last_read: 1000 }),
];

function show(bulk = true) {
  return render(
    <ConversationCollection
      conversations={list}
      view="list"
      onSelect={() => {}}
      bulk={bulk}
    />,
  );
}

beforeEach(() => {
  mockRemove.mockClear();
  mockMarkRead.mockClear();
  mockChanged.mockClear();
});

test("select some, then remove them from the list, after confirming", async () => {
  const user = userEvent.setup();
  show();
  expect(screen.queryByRole("toolbar")).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
  // Shift-click selects the range in the order shown.
  await user.keyboard("{Shift>}");
  await user.click(screen.getByRole("checkbox", { name: "Select Gamma" }));
  await user.keyboard("{/Shift}");
  expect(
    screen.getByRole("checkbox", { name: "Select all conversations" }),
  ).toBeChecked();
  expect(screen.getByText(/3 conversations · 3 selected/)).toBeTruthy();
  const toolbar = screen.getByRole("toolbar", {
    name: "Selected conversations",
  });
  await user.click(within(toolbar).getByRole("button", { name: "Remove…" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent(
    "Remove 3 conversations from the conversation list?",
  );
  expect(mockRemove).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(3));
  expect(mockRemove.mock.calls.map(([opts]) => opts)).toEqual([
    { project_id, conversation_id: "a" },
    { project_id, conversation_id: "b" },
    { project_id, conversation_id: "c" },
  ]);
  expect(mockChanged).toHaveBeenCalled();
});

test("mark the selected ones read (only those unread)", async () => {
  const user = userEvent.setup();
  show();
  await user.click(
    screen.getByRole("checkbox", { name: "Select all conversations" }),
  );
  await user.click(screen.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(mockMarkRead).toHaveBeenCalledTimes(2));
  expect(mockMarkRead.mock.calls.map(([opts]) => opts)).toEqual([
    { project_id, conversation_id: "a", read_through: 3000 },
    { project_id, conversation_id: "c", read_through: 3000 },
  ]);
});

test("each row's menu can remove it from the list too", async () => {
  const user = userEvent.setup();
  show();
  await user.click(screen.getByRole("button", { name: "Options for Beta" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove from list..." }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent('Remove "Beta" from the conversation list?');
  await user.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(mockRemove).toHaveBeenCalledWith({
      project_id,
      conversation_id: "b",
    }),
  );
});

test("beside an open conversation (no bulk): no checkboxes", () => {
  show(false);
  expect(screen.queryByRole("checkbox")).toBeNull();
});
