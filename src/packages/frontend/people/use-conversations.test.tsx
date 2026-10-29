/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render, screen } from "@testing-library/react";
import { fromJS } from "immutable";

const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let mockAccount: string | undefined = me;
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
    field === "account_id" ? mockAccount : undefined,
}));
jest.mock("./api", () => {
  const { EventEmitter } = require("events");
  return {
    peopleApi: () => ({ listConversations: mockList }),
    conversationEvents: new EventEmitter(),
  };
});

import { useLayoutEffect } from "react";
import {
  hasNewChatNotification,
  resetConversationsForTests,
  setConversationsSnapshotForTests,
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
  mockAccount = me;
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
  expect(screen.getByRole("status")).toHaveTextContent("1 unread conversation");

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
  expect(screen.getByRole("status")).toHaveTextContent(
    "2 unread conversations",
  );
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const another = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

test("a list loaded for one account is not shown for another", async () => {
  mockList.mockResolvedValue({
    conversations: [conv("c1")],
    unavailable_bays: 0,
  });
  const first = render(<PeopleUnreadBadge />);
  await flush();
  expect(screen.getByRole("status")).toHaveTextContent("1 unread conversation");
  first.unmount();
  // Someone else signs in; their own list has nothing unread.
  mockAccount = another;
  const pending = deferred<any>();
  mockList.mockReturnValue(pending.promise);
  const { container } = render(<PeopleUnreadBadge />);
  expect(container.textContent).toBe("");
  pending.resolve({ conversations: [], unavailable_bays: 0 });
  await flush();
  expect(container.textContent).toBe("");
});

test("a response for the previous account is dropped after a switch", async () => {
  const forMe = deferred<any>();
  mockList.mockReturnValueOnce(forMe.promise);
  const view = render(<PeopleUnreadBadge />);
  mockAccount = another;
  const forAnother = deferred<any>();
  mockList.mockReturnValueOnce(forAnother.promise);
  view.rerender(<PeopleUnreadBadge />);
  await flush();
  // The first account's answer arrives late.
  forMe.resolve({ conversations: [conv("c1")], unavailable_bays: 0 });
  await flush();
  expect(view.container.textContent).toBe("");
  forAnother.resolve({ conversations: [], unavailable_bays: 0 });
  await flush();
  expect(view.container.textContent).toBe("");
});

test("switching accounts announces nothing false while the new list loads", async () => {
  mockList.mockResolvedValue({
    conversations: [conv("c1")],
    unavailable_bays: 0,
  });
  const view = render(<PeopleUnreadBadge />);
  await flush();
  expect(screen.getByRole("status")).toHaveTextContent("1 unread conversation");
  // Someone else signs in, without the badge unmounting.
  mockAccount = another;
  const forAnother = deferred<any>();
  mockList.mockReturnValueOnce(forAnother.promise);
  view.rerender(<PeopleUnreadBadge />);
  await flush();
  // Loading: not "No unread conversations", which isn't known yet.
  expect(screen.getByRole("status").textContent).toBe("");
  forAnother.resolve({ conversations: [], unavailable_bays: 0 });
  await flush();
  // Nothing was ever unread for this account: still nothing to announce.
  expect(screen.getByRole("status").textContent).toBe("");
});

// Every state Status rendered, including the first, before any effect.
const rendered: string[] = [];
function Status() {
  const { conversations, loading, error } = useConversations(true);
  const state = `${loading ? "loading" : "loaded"}:${conversations.length}:${error ?? "ok"}`;
  rendered.push(state);
  return <span>{state}</span>;
}

test("a new account doesn't inherit the previous account's error", async () => {
  mockList.mockRejectedValue(new Error("bay down"));
  const view = render(<Status />);
  await flush();
  expect(screen.getByText("loaded:0:Error: bay down")).toBeTruthy();
  mockAccount = another;
  mockList.mockReturnValue(deferred<any>().promise);
  view.rerender(<Status />);
  await flush();
  expect(screen.getByText("loading:0:ok")).toBeTruthy();
});

test("after everyone unmounts, a later mount loads again instead of showing the old list", async () => {
  mockList.mockResolvedValue({
    conversations: [conv("c1")],
    unavailable_bays: 0,
  });
  const first = render(<Status />);
  await flush();
  expect(screen.getByText("loaded:1:ok")).toBeTruthy();
  first.unmount();
  // Same account, later; the list hasn't arrived yet.
  mockList.mockReturnValue(deferred<any>().promise);
  rendered.length = 0;
  render(<Status />);
  await flush();
  // Never the old list as loaded, not even on the first render.
  expect(rendered).not.toContain("loaded:1:ok");
  expect(screen.getByText("loading:0:ok")).toBeTruthy();
});

test("a consumer that mounts while the list changes still sees the change", async () => {
  mockList.mockResolvedValue({
    conversations: [conv("c1")],
    unavailable_bays: 0,
  });
  function List({ id }: { id: string }) {
    const { conversations } = useConversations(true);
    return <span>{`${id}:${conversations.length}`}</span>;
  }
  // Changes the list between the late consumer's render and its subscription.
  function ChangeDuringLayout() {
    useLayoutEffect(() => {
      setConversationsSnapshotForTests({
        conversations: [conv("c1"), conv("c2")] as any,
      });
    }, []);
    return null;
  }
  const view = render(<List id="early" />);
  await flush();
  view.rerender(
    <>
      <List id="early" />
      <List id="late" />
      <ChangeDuringLayout />
    </>,
  );
  await flush();
  expect(screen.getByText("early:2")).toBeTruthy();
  expect(screen.getByText("late:2")).toBeTruthy();
});
