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
const mockApi = {
  listDirect: jest.fn(),
  getDirect: jest.fn(),
  sendDirect: jest.fn(),
  respondDirect: jest.fn(),
  markDirectRead: jest.fn(async () => {}),
  setDirectMuted: jest.fn(async () => {}),
  startDirect: jest.fn(),
  findDirectRecipient: jest.fn(),
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({ get: () => fromJS({}) }),
    reduxStore: { subscribe: () => () => {} },
  },
  useTypedRedux: (_store: string, field: string) =>
    field === "account_id" ? mockAccount : undefined,
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
jest.mock("@cocalc/frontend/editors/markdown-input", () => ({
  MarkdownInput: ({ value, onChange, onShiftEnter }) => (
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
import { DirectConversationView, DirectList } from "./direct-messages";
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

test("New message: a collaborator prefilled, or someone added by username", async () => {
  mockApi.findDirectRecipient.mockResolvedValue({
    account_id: cy,
    name: "Cy",
    username: "cy",
  });
  mockApi.startDirect.mockResolvedValue(listed("new"));
  const started = jest.fn();
  render(
    <NewDirectModal
      open
      personId={bea}
      onClose={() => {}}
      onStarted={started}
    />,
  );
  fireEvent.change(screen.getByPlaceholderText("@username"), {
    target: { value: "@cy" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(mockApi.findDirectRecipient).toHaveBeenCalledWith({
      username: "@cy",
    }),
  );
  fireEvent.change(screen.getByLabelText("Composer"), {
    target: { value: "Hi both" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    // The collaborator by id; someone else only by username.
    expect(mockApi.startDirect).toHaveBeenCalledWith({
      member_ids: [bea],
      usernames: ["cy"],
      title: "",
      body: "Hi both",
    }),
  );
  expect(started).toHaveBeenCalled();
});

test("New message: an unknown username says so", async () => {
  mockApi.findDirectRecipient.mockResolvedValue(null);
  render(<NewDirectModal open onClose={() => {}} onStarted={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText("@username"), {
    target: { value: "nobody" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      'No one has the username "nobody".',
    ),
  );
});
