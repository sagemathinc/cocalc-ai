/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { fromJS } from "immutable";

const me = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bea = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const cy = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let mockAccount: string | undefined = me;
// A project shared with Bea, for "N shared projects".
const mockProjects = fromJS({
  p1: { title: "Shared with Bea", users: { [me]: {}, [bea]: {} } },
});
const mockUserSearch = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    users_client: { user_search: (opts) => mockUserSearch(opts) },
  },
}));
const mockApi = {
  listDirect: jest.fn(),
  getDirect: jest.fn(),
  sendDirect: jest.fn(),
  respondDirect: jest.fn(),
  markDirectRead: jest.fn(async () => {}),
  setDirectState: jest.fn(async () => {}),
  deleteDirectMessage: jest.fn(async () => {}),
  startDirect: jest.fn(),
  findDirectRecipient: jest.fn(),
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({ get: () => fromJS({}) }),
    reduxStore: { subscribe: () => () => {} },
  },
  useTypedRedux: (_store: string, field: string) =>
    field === "account_id"
      ? mockAccount
      : field === "project_map"
        ? mockProjects
        : undefined,
}));
jest.mock("./api", () => ({ peopleApi: () => mockApi }));
jest.mock("@cocalc/frontend/users/user", () => ({
  User: ({ account_id }) => <span>{`user:${account_id.slice(0, 4)}`}</span>,
}));
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => null,
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }) => <div>{value}</div>,
}));
// The chat editor (multimode), as a textarea.
jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: ({ value, onChange, onShiftEnter }) => (
    <textarea
      aria-label="Composer"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.shiftKey) onShiftEnter?.(value);
      }}
    />
  ),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: () => <span>ago</span>,
  Tooltip: ({ children }) => <>{children}</>,
}));
jest.mock("./collaborators", () => ({
  usePeople: () => [{ account_id: bea, name: "Bea Tester" }],
}));

import { parsePeopleRoute } from "./route";
import {
  DirectConversationView,
  DirectList,
  DirectMessagesTab,
} from "./direct-messages";
import { NewDirectModal } from "./new-direct";
import {
  directAttentionCount,
  resetDirectForTests,
  useDirectConversations,
} from "./use-direct";

const listed = (id: string, extra = {}) => ({
  conversation_id: id,
  owner_bay_id: "bay-0",
  member_ids: [me, bea],
  member_states: { [me]: "active", [bea]: "active" },
  created_by: me,
  created: 1,
  last_activity: 3000,
  last_sender_id: bea,
  preview: `preview ${id}`,
  title: null,
  state: "active",
  last_read: 1000,
  muted: false,
  pinned: false,
  archived_through: null,
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
  resetDirectForTests();
  for (const f of Object.values(mockApi)) (f as jest.Mock).mockReset();
  mockUserSearch.mockReset();
  mockApi.markDirectRead.mockResolvedValue(undefined);
});

test("routes for direct conversations", () => {
  expect(parsePeopleRoute("messages")).toEqual({ tab: "messages" });
  expect(parsePeopleRoute("messages/abc")).toEqual({
    tab: "messages",
    direct_id: "abc",
  });
});

test("needing attention: unread ones and requests, not muted or my own", () => {
  const conversations = [
    listed("unread"),
    listed("read", { last_read: 3000 }),
    listed("mine", { last_sender_id: me }),
    listed("muted", { muted: true }),
    listed("request", { state: "requested", created_by: bea }),
  ] as any;
  expect(directAttentionCount(conversations, me)).toBe(2);
});

test("requests come first, and the list shows who and what", () => {
  render(
    <DirectList
      conversations={
        [
          listed("c1"),
          listed("c2", {
            state: "requested",
            member_ids: [cy, me],
            created_by: cy,
          }),
        ] as any
      }
      onSelect={() => {}}
    />,
  );
  const sections = screen.getAllByRole("region");
  expect(sections[0]).toHaveAccessibleName("Message requests");
  expect(sections[0]).toHaveTextContent("Request");
  expect(sections[0]).toHaveTextContent("user:cccc");
  expect(sections[1]).toHaveTextContent("preview c1");
});

test("a list loaded for one account is never shown for another", async () => {
  mockApi.listDirect.mockResolvedValue({ conversations: [listed("c1")] });
  function Count() {
    const { conversations } = useDirectConversations(true);
    return <span>{`${conversations.length} listed`}</span>;
  }
  const view = render(<Count />);
  await flush();
  expect(screen.getByText("1 listed")).toBeTruthy();
  let resolve!: (v: any) => void;
  mockApi.listDirect.mockReturnValue(new Promise((r) => (resolve = r)));
  mockAccount = cy;
  view.rerender(<Count />);
  expect(screen.getByText("0 listed")).toBeTruthy();
  resolve({ conversations: [] });
  await flush();
  expect(screen.getByText("0 listed")).toBeTruthy();
});

test("a conversation shows its messages, marks them read and sends with Shift+Enter", async () => {
  mockApi.listDirect.mockResolvedValue({ conversations: [listed("c1")] });
  mockApi.getDirect.mockResolvedValue({
    conversation: listed("c1"),
    messages: [
      {
        message_id: "m1",
        conversation_id: "c1",
        sender_id: bea,
        sent: 3000,
        body: "Hi there",
      },
    ],
  });
  mockApi.sendDirect.mockResolvedValue({
    message_id: "m2",
    conversation_id: "c1",
    sender_id: me,
    sent: 4000,
    body: "Hello",
  });
  render(<DirectConversationView conversation_id="c1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("Hi there")).toBeTruthy());
  expect(mockApi.markDirectRead).toHaveBeenCalledWith({
    conversation_id: "c1",
    read_through: 3000,
  });
  const composer = screen.getByLabelText("Composer");
  fireEvent.change(composer, { target: { value: "Hello" } });
  fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
  await waitFor(() =>
    expect(mockApi.sendDirect).toHaveBeenCalledWith({
      conversation_id: "c1",
      body: "Hello",
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Your message")).toBeTruthy(),
  );
});

test("switching accounts never leaves the previous account's messages on screen", async () => {
  mockApi.listDirect.mockResolvedValue({ conversations: [listed("c1")] });
  mockApi.getDirect.mockResolvedValueOnce({
    conversation: listed("c1"),
    messages: [
      {
        message_id: "m1",
        conversation_id: "c1",
        sender_id: bea,
        sent: 3000,
        body: "private for Ada",
      },
    ],
  });
  const view = render(
    <DirectMessagesTab
      conversation_id="c1"
      onOpen={() => {}}
      onClose={() => {}}
    />,
  );
  await waitFor(() => expect(screen.getByText("private for Ada")).toBeTruthy());
  // Someone else signs in on the same route; their request fails.
  mockAccount = cy;
  mockApi.getDirect.mockRejectedValue(Error("conversation not found"));
  view.rerender(
    <DirectMessagesTab
      conversation_id="c1"
      onOpen={() => {}}
      onClose={() => {}}
    />,
  );
  await waitFor(() =>
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
  );
  expect(screen.queryByText("private for Ada")).toBeNull();
});

test("a request's messages are plain text until accepted: no image loads", async () => {
  const request = listed("c3", { state: "requested", created_by: bea });
  mockApi.listDirect.mockResolvedValue({ conversations: [request] });
  mockApi.getDirect.mockResolvedValue({
    conversation: request,
    messages: [
      {
        message_id: "m1",
        conversation_id: "c3",
        sender_id: bea,
        sent: 3000,
        body: "![probe](https://attacker.example/pixel)",
      },
    ],
  });
  const { container } = render(
    <DirectConversationView conversation_id="c3" onClose={() => {}} />,
  );
  await waitFor(() =>
    expect(
      screen.getByText("![probe](https://attacker.example/pixel)"),
    ).toBeTruthy(),
  );
  expect(container.querySelector("img")).toBeNull();
});

test("a request can be accepted; it isn't marked read until then", async () => {
  const request = listed("c2", {
    state: "requested",
    created_by: bea,
    member_states: { [me]: "requested", [bea]: "active" },
  });
  mockApi.listDirect.mockResolvedValue({ conversations: [request] });
  mockApi.getDirect.mockResolvedValue({ conversation: request, messages: [] });
  mockApi.respondDirect.mockResolvedValue({});
  render(<DirectConversationView conversation_id="c2" onClose={() => {}} />);
  await waitFor(() =>
    expect(screen.getByText(/wants to message you/)).toBeTruthy(),
  );
  expect(mockApi.markDirectRead).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(mockApi.respondDirect).toHaveBeenCalledWith({
      conversation_id: "c2",
      action: "accept",
    }),
  );
});

test("New message: collaborators are found by name, with what tells them apart", async () => {
  mockUserSearch.mockResolvedValue([
    {
      account_id: bea,
      first_name: "Bea",
      last_name: "Tester",
      last_active: 5000,
      created: 1000,
    },
  ]);
  mockApi.startDirect.mockResolvedValue(listed("new"));
  const started = jest.fn();
  render(<NewDirectModal open onClose={() => {}} onStarted={started} />);
  fireEvent.change(
    screen.getByPlaceholderText("Name, email address, or @username"),
    { target: { value: "Bea" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  // The same search as adding collaborators to a project.
  await waitFor(() =>
    expect(mockUserSearch).toHaveBeenCalledWith({ query: "Bea", limit: 30 }),
  );
  const results = await screen.findByRole("region", { name: "Search results" });
  expect(results).toHaveTextContent("Bea Tester");
  expect(results).toHaveTextContent("Collaborator");
  expect(results).toHaveTextContent("1 shared project");
  fireEvent.click(screen.getByRole("button", { name: "Add Bea Tester" }));
  expect(screen.getByRole("region", { name: "Recipients" })).toHaveTextContent(
    "Sending to 1 person",
  );
  fireEvent.change(screen.getByLabelText("Composer"), {
    target: { value: "Hi Bea" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(mockApi.startDirect).toHaveBeenCalledWith({
      member_ids: [bea],
      usernames: [],
      title: null,
      body: "Hi Bea",
    }),
  );
  expect(started).toHaveBeenCalled();
});

test("New message: anyone else only by exact @username, as a message request", async () => {
  mockApi.findDirectRecipient.mockResolvedValue({
    account_id: cy,
    name: "Cy",
    username: "cy",
  });
  mockApi.startDirect.mockResolvedValue(listed("new"));
  render(<NewDirectModal open onClose={() => {}} onStarted={() => {}} />);
  fireEvent.change(
    screen.getByPlaceholderText("Name, email address, or @username"),
    { target: { value: "@cy" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  const results = await screen.findByRole("region", { name: "Search results" });
  // An @username isn't a name search.
  expect(mockUserSearch).not.toHaveBeenCalled();
  expect(results).toHaveTextContent("Message request");
  expect(results).toHaveTextContent("@cy");
  expect(results).toHaveTextContent("No shared projects");
  fireEvent.click(screen.getByRole("button", { name: "Add Cy" }));
  fireEvent.change(screen.getByLabelText("Composer"), {
    target: { value: "Hello" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    // Someone who isn't a collaborator is sent only as a username.
    expect(mockApi.startDirect).toHaveBeenCalledWith({
      member_ids: [],
      usernames: ["cy"],
      title: null,
      body: "Hello",
    }),
  );
});

test("New message: nothing found says how to find people", async () => {
  mockUserSearch.mockResolvedValue([]);
  mockApi.findDirectRecipient.mockResolvedValue(null);
  render(<NewDirectModal open onClose={() => {}} onStarted={() => {}} />);
  fireEvent.change(
    screen.getByPlaceholderText("Name, email address, or @username"),
    { target: { value: "nobody" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(
    await screen.findByText(/for anyone else, use their exact @username/),
  ).toBeTruthy();
});

const message = (id: string, sender: string, sent: number, body: string) => ({
  message_id: id,
  conversation_id: "c1",
  sender_id: sender,
  sent,
  body,
});

test("archived messages are hidden until shown again; nothing is deleted", async () => {
  const archived = listed("c1", { archived_through: 2000 });
  mockApi.listDirect.mockResolvedValue({ conversations: [archived] });
  mockApi.getDirect.mockResolvedValue({
    conversation: archived,
    messages: [
      message("m1", bea, 1000, "old one"),
      message("m2", bea, 3000, "new one"),
    ],
  });
  render(<DirectConversationView conversation_id="c1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("new one")).toBeTruthy());
  expect(screen.queryByText("old one")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Earlier messages are archived.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Show them" }));
  expect(screen.getByText("old one")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide them" }));
  expect(screen.queryByText("old one")).toBeNull();
  expect(mockApi.deleteDirectMessage).not.toHaveBeenCalled();
});

test("Archive hides the messages so far, for you only", async () => {
  mockApi.listDirect.mockResolvedValue({ conversations: [listed("c1")] });
  mockApi.getDirect.mockResolvedValue({
    conversation: listed("c1"),
    messages: [message("m1", bea, 3000, "hello")],
  });
  render(<DirectConversationView conversation_id="c1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await waitFor(() =>
    expect(mockApi.setDirectState).toHaveBeenCalledWith({
      conversation_id: "c1",
      patch: { archived_through: 3000 },
    }),
  );
  await waitFor(() => expect(screen.queryByText("hello")).toBeNull());
});

test("you can delete your own messages, not anyone else's; deleted ones show a placeholder", async () => {
  mockApi.listDirect.mockResolvedValue({ conversations: [listed("c1")] });
  mockApi.getDirect.mockResolvedValue({
    conversation: listed("c1"),
    messages: [
      message("m1", bea, 1000, "from Bea"),
      message("m2", me, 2000, "oops, wrong paste"),
      { ...message("m3", bea, 2500, ""), deleted: true },
    ],
  });
  render(<DirectConversationView conversation_id="c1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText("from Bea")).toBeTruthy());
  expect(screen.getByText("Message deleted")).toBeTruthy();
  // Only my message has a Delete button.
  const buttons = screen.getAllByRole("button", { name: "Delete message" });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(mockApi.deleteDirectMessage).toHaveBeenCalledWith({
      conversation_id: "c1",
      message_id: "m2",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByText("oops, wrong paste")).toBeNull(),
  );
  expect(screen.getAllByText("Message deleted")).toHaveLength(2);
});

test("pinned direct conversations come first, under Pinned; the rest are Recent", () => {
  render(
    <DirectList
      conversations={
        [
          listed("c1", { preview: "recent one" }),
          listed("c2", { pinned: true, preview: "pinned one" }),
        ] as any
      }
      onSelect={() => {}}
    />,
  );
  const text = screen.getByRole("region", {
    name: "Direct conversations",
  }).textContent!;
  expect(text.indexOf("Pinned")).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("pinned one")).toBeLessThan(text.indexOf("Recent"));
  expect(text.indexOf("Recent")).toBeLessThan(text.indexOf("recent one"));
});

test("a group shows who it's with", () => {
  render(
    <DirectList
      conversations={
        [listed("g1", { title: "test", member_ids: [me, bea, cy] })] as any
      }
      onSelect={() => {}}
    />,
  );
  const row = screen.getByRole("region", { name: "Direct conversations" });
  expect(row).toHaveTextContent("test");
  expect(row).toHaveTextContent("user:bbbb");
  expect(row).toHaveTextContent("user:cccc");
});
