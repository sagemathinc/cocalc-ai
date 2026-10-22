import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

function setup(initial: any[], readCount = 0) {
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
    actions.setReaderState = jest.fn((_thread: string, next: ReaderState) => {
      state = next;
      setVersion((v) => v + 1);
      return true;
    });
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
const press = (key: string) =>
  fireEvent.keyDown(screen.getByLabelText("Reader"), { key });

const thread = [
  person("p1", "first question", 1),
  agent("a1", "first answer", 2),
  person("p2", "second question", 3),
  person("p3", "third question", 4),
];

test("items are unread past the watermark; opening one reads it", () => {
  const { count } = setup(thread, 2);
  expect(options().map(isUnread)).toEqual([false, true, true]);
  expect(screen.getByText("2 unread")).toBeInTheDocument();
  // An item shows its replies in the reading pane.
  fireEvent.click(screen.getByText(/first question/));
  expect(screen.getByRole("article")).toHaveTextContent("first answer");
  // j opens the next one: read, and the watermark moves over it.
  press("j");
  expect(screen.getByRole("article")).toHaveTextContent("second question");
  expect(count()).toBe(3);
  expect(options().map(isUnread)).toEqual([false, false, true]);
});

test("u jumps to the next unread; m marks unread; y archives", () => {
  const { state, count } = setup(thread, 0);
  press("u");
  expect(screen.getByRole("article")).toHaveTextContent("first question");
  expect(count()).toBe(2);
  press("m");
  expect(state().u).toEqual(["p1"]);
  expect(isUnread(options()[0])).toBe(true);
  press("y");
  // Archived: gone from the list, and the next item opens.
  expect(options()).toHaveLength(2);
  expect(screen.getByRole("article")).toHaveTextContent("second question");
  fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
  expect(options()).toHaveLength(3);
});

test("new items wait behind a button; mark all read", () => {
  const { setMessages, count } = setup(thread, 4);
  expect(screen.getByText("All read")).toBeInTheDocument();
  // jsdom lays nothing out, so the list counts as scrolled up.
  const list = screen.getByRole("listbox");
  Object.defineProperty(list, "scrollHeight", { value: 1000 });
  Object.defineProperty(list, "clientHeight", { value: 100 });
  setMessages([
    ...thread,
    person("p4", "fourth", 5),
    person("p5", "fifth", 6),
  ]);
  expect(screen.getByRole("button", { name: "2 new" })).toBeInTheDocument();
  expect(screen.getByText("2 unread")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
  expect(count()).toBe(6);
  expect(screen.getByText("All read")).toBeInTheDocument();
});
