/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render, screen } from "@testing-library/react";
import { fromJS } from "immutable";

const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const mockList = jest.fn();
let mockMentions: any = fromJS({});
const mockSubscribers = new Set<() => void>();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) =>
      name === "mentions"
        ? { get: (key: string) => (key === "mentions" ? mockMentions : null) }
        : undefined,
    reduxStore: {
      subscribe: (f: () => void) => {
        mockSubscribers.add(f);
        return () => mockSubscribers.delete(f);
      },
    },
  },
  useTypedRedux: (_store: string, field: string) =>
    field === "account_id" ? me : undefined,
}));
jest.mock("./api", () => {
  const { EventEmitter } = require("events");
  return {
    peopleApi: () => ({ listConversations: mockList }),
    conversationEvents: new EventEmitter(),
  };
});

import {
  hasNewChatNotification,
  resetConversationsForTests,
  unreadConversationCount,
  useConversations,
} from "./use-conversations";
import { PeopleUnreadBadge } from "./unread-badge";

const conv = (id: string, extra = {}) => ({
  conversation_id: id,
  project_id: "p",
  path: `/home/user/${id}.chat`,
  title: id,
  created_by: other,
  created: 1,
  last_activity: 3000,
  last_sender_id: other,
  participant_ids: [other, me],
  pinned: false,
  alias: null,
  following: false,
  muted: false,
  last_read: 1000,
  mentioned_at: null,
  ...extra,
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  resetConversationsForTests();
  mockList.mockReset();
  mockMentions = fromJS({});
  mockSubscribers.clear();
});
afterEach(() => jest.useRealTimers());

test("the unread count is conversations for you with something unread", () => {
  const conversations = [
    conv("unread"),
    conv("read", { last_read: 3000 }),
    conv("mine", { last_sender_id: me }),
    conv("muted", { muted: true }),
    // Not for me: someone else's conversation I haven't joined.
    conv("not-mine", { participant_ids: [other] }),
  ] as any;
  expect(unreadConversationCount(conversations, me)).toBe(1);
});

test("only a new notification about a chat file counts", () => {
  const before = fromJS({ a: { path: "/x.chat" } });
  expect(
    hasNewChatNotification(
      before,
      before.set("b", fromJS({ path: "/notes.md" })) as any,
    ),
  ).toBe(false);
  expect(
    hasNewChatNotification(
      before,
      before.set("c", fromJS({ path: "/y.chat" })) as any,
    ),
  ).toBe(true);
  // The first load is not news.
  expect(hasNewChatNotification(undefined, before as any)).toBe(false);
});

test("the page, sidebar and badge share one list, refreshed by a chat notification", async () => {
  mockList.mockResolvedValue({
    conversations: [conv("c1")],
    unavailable_bays: 0,
  });
  function List() {
    const { conversations } = useConversations(true);
    return <span>{conversations.length} listed</span>;
  }
  render(
    <>
      <List />
      <List />
      <PeopleUnreadBadge />
    </>,
  );
  await flush();
  // One request for all three.
  expect(mockList).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText("1 listed")).toHaveLength(2);
  expect(screen.getByLabelText("1 unread conversation")).toBeTruthy();

  // Someone writes: a notification about a chat file arrives.
  mockList.mockResolvedValue({
    conversations: [conv("c1"), conv("c2")],
    unavailable_bays: 0,
  });
  mockMentions = mockMentions.set("n1", fromJS({ path: "/home/user/c2.chat" }));
  act(() => mockSubscribers.forEach((f) => f()));
  await act(async () => {
    jest.advanceTimersByTime(600);
  });
  await flush();
  expect(mockList).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText("2 listed")).toHaveLength(2);
  expect(screen.getByLabelText("2 unread conversations")).toBeTruthy();
});

test("no badge when nothing is unread", async () => {
  mockList.mockResolvedValue({
    conversations: [conv("c1", { last_read: 3000 })],
    unavailable_bays: 0,
  });
  const { container } = render(<PeopleUnreadBadge />);
  await flush();
  expect(container.textContent).toBe("");
});
