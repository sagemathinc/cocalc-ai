import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChatReaderView } from "../reader-view";
import type { ReaderState } from "../reader-model";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: () => <span>sometime</span>,
  Tooltip: ({ children }: any) => children,
}));
jest.mock("../bounded-static-markdown", () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => <div>{value}</div>,
}));
jest.mock("../user-name", () => ({
  getUserName: () => "Alice",
}));

const person = (id: string, text: string, ms: number) =>
  ({
    message_id: id,
    sender_id: "acct",
    date: new Date(ms),
    history: [{ content: text, author_id: "acct" }],
  }) as any;
const agent = (id: string, text: string, ms: number) =>
  ({
    message_id: id,
    sender_id: "codex",
    date: new Date(ms),
    acp_thread_id: "t",
    history: [{ content: text, author_id: "codex" }],
  }) as any;

function setup(initial: any[], readCount = 0, props: object = {}) {
  let state: ReaderState = {};
  let count = readCount;
  const actions: any = {
    getThreadReadCount: jest.fn(() => count),
    getReaderState: jest.fn(() => state),
  };
  let setMessages!: (messages: any[]) => void;
  function Harness() {
    const [messages, set] = useState(initial);
    const [version, setVersion] = useState(0);
    setMessages = set;
    actions.updateReaderState = jest.fn(
      (_thread: string, update: (s: ReaderState) => ReaderState) => {
        state = update(state);
        setVersion((v) => v + 1);
        return true;
      },
    );
    actions.markThreadRead = jest.fn((_thread: string, next: number) => {
      count = next;
      setVersion((v) => v + 1);
      return true;
    });
    return (
      <ChatReaderView
        actions={actions}
        threadId="thread-1"
        messages={messages}
        accountId="acct"
        readStateVersion={version}
        {...props}
      />
    );
  }
  render(<Harness />);
  return {
    actions,
    state: () => state,
    count: () => count,
    setMessages: (messages: any[]) => act(() => setMessages(messages)),
  };
}

const options = () => screen.getAllByRole("option");
const isUnread = (option: HTMLElement) =>
  within(option).queryByLabelText("unread") != null;
// Real keystrokes: they reach the reader only where the focus is.
const user = () => userEvent.setup();

const thread = [
  person("p1", "first question", 1),
  agent("a1", "first answer", 2),
  person("p2", "second question", 3),
  person("p3", "third question", 4),
];

test("items are unread past the watermark; opening one reads it", async () => {
  const { count } = setup(thread, 2);
  const keys = user();
  expect(options().map(isUnread)).toEqual([false, true, true]);
  expect(screen.getByText("2 unread")).toBeInTheDocument();
  // An item shows its replies in the reading pane.
  await keys.click(screen.getByText(/first question/));
  expect(screen.getByRole("article")).toHaveTextContent("first answer");
  // Clicking an item leaves the focus where the keys work.
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
  // j opens the next one: read, and the watermark moves over it.
  await keys.keyboard("j");
  expect(screen.getByRole("article")).toHaveTextContent("second question");
  expect(count()).toBe(3);
  expect(options().map(isUnread)).toEqual([false, false, true]);
});

test("u jumps to the next unread; m marks unread; y archives", async () => {
  // Turned on by the person: the keys work at once.
  const { state, count } = setup(thread, 0, { autoFocus: true });
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
  const keys = user();
  await keys.keyboard("u");
  expect(screen.getByRole("article")).toHaveTextContent("first question");
  expect(count()).toBe(2);
  await keys.keyboard("m");
  expect(state().u).toEqual(["p1"]);
  expect(isUnread(options()[0])).toBe(true);
  await keys.keyboard("y");
  // Archived: gone from the list, and the next item opens.
  expect(options()).toHaveLength(2);
  expect(screen.getByRole("article")).toHaveTextContent("second question");
  fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
  expect(options()).toHaveLength(3);
});

test("without the focus, keys do nothing", async () => {
  const { count } = setup(thread, 0);
  await user().keyboard("j");
  expect(screen.queryByRole("article")).toBeNull();
  expect(count()).toBe(0);
});

test("showing archived items is not new items", () => {
  setup(thread, 4);
  const list = screen.getByRole("listbox");
  Object.defineProperty(list, "scrollHeight", { value: 1000 });
  Object.defineProperty(list, "clientHeight", { value: 100 });
  fireEvent.click(screen.getByText(/third question/));
  fireEvent.keyDown(list, { key: "y" });
  expect(options()).toHaveLength(2);
  fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
  expect(options()).toHaveLength(3);
  expect(screen.queryByRole("button", { name: /new/ })).toBeNull();
});

test("new items wait behind a button; mark all read", () => {
  const { setMessages, count } = setup(thread, 4);
  expect(screen.getByText("All read")).toBeInTheDocument();
  // jsdom lays nothing out, so the list counts as scrolled up.
  const list = screen.getByRole("listbox");
  Object.defineProperty(list, "scrollHeight", { value: 1000 });
  Object.defineProperty(list, "clientHeight", { value: 100 });
  setMessages([...thread, person("p4", "fourth", 5), person("p5", "fifth", 6)]);
  expect(screen.getByRole("button", { name: "2 new" })).toBeInTheDocument();
  expect(screen.getByText("2 unread")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
  expect(count()).toBe(6);
  expect(screen.getByText("All read")).toBeInTheDocument();
});

test("unread archived items still count while hidden", async () => {
  setup(thread, 4, { autoFocus: true });
  const keys = user();
  await keys.click(screen.getByText(/second question/));
  await keys.keyboard("m");
  await keys.keyboard("y");
  expect(options()).toHaveLength(2);
  expect(screen.getByText("1 unread (1 archived)")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Mark all read" })).toBeEnabled();
});

test("narrow: back to the list keeps the keys working", async () => {
  setup(thread, 0, { narrow: true });
  const keys = user();
  await keys.click(screen.getByText(/second question/));
  expect(screen.queryByRole("listbox")).toBeNull();
  await keys.click(screen.getByRole("button", { name: "All messages" }));
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
  await keys.keyboard("j");
  expect(screen.getByRole("article")).toHaveTextContent("first question");
});
