import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChatReaderView } from "../reader-view";
import type { ReaderChange, ReaderState } from "../reader-model";

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
jest.mock("@cocalc/frontend/components/copy-button", () => ({
  __esModule: true,
  default: () => <button data-testid="copy-button">copy</button>,
}));
jest.mock("../contextual-reply", () => ({
  __esModule: true,
  default: ({ children, source, disabled }: any) => (
    <div
      data-testid="contextual-reply"
      data-source={source.id}
      data-disabled={String(!!disabled)}
    >
      {children}
    </div>
  ),
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
      (_thread: string, change: ReaderChange) => {
        const next = change(state, count - 1);
        state = next.state;
        if (next.watermarkCount != null && next.watermarkCount > count)
          count = next.watermarkCount;
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
  // Newest first, as in an inbox.
  expect(options().map((o) => o.textContent)).toEqual([
    expect.stringContaining("third question"),
    expect.stringContaining("second question"),
    expect.stringContaining("first question"),
  ]);
  expect(options().map(isUnread)).toEqual([true, true, false]);
  expect(screen.getByText("2 unread")).toBeInTheDocument();
  // An item shows its replies in the reading pane.
  await keys.click(screen.getByText(/first question/));
  expect(screen.getByRole("article")).toHaveTextContent("first answer");
  // Clicking an item leaves the focus where the keys work.
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
  // k goes up to the newer one: read, and the watermark moves over it.
  await keys.keyboard("k");
  expect(screen.getByRole("article")).toHaveTextContent("second question");
  expect(count()).toBe(3);
  expect(options().map(isUnread)).toEqual([true, false, false]);
  // j goes back down, to the older one.
  await keys.keyboard("j");
  expect(screen.getByRole("article")).toHaveTextContent("first answer");
});

test("u jumps to the next unread; m marks unread; y archives", async () => {
  // Turned on by the person: the keys work at once.
  const { state, count } = setup(thread, 0, { autoFocus: true });
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
  const keys = user();
  // The first unread one from the top: the newest.
  await keys.keyboard("u");
  expect(screen.getByRole("article")).toHaveTextContent("third question");
  // Read out of order: the watermark stays.
  expect(count()).toBe(0);
  // u again: the next unread one down, then from the top.
  await keys.keyboard("u");
  expect(screen.getByRole("article")).toHaveTextContent("second question");
  await keys.keyboard("k");
  await keys.keyboard("m");
  expect(state().u).toEqual(["p3"]);
  expect(isUnread(options()[0])).toBe(true);
  await keys.keyboard("y");
  // Archived: gone from the list, and the next (older) item opens.
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
  // Scrolled away from the top, where new items would appear.
  Object.defineProperty(list, "scrollTop", { value: 500, writable: true });
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
  // Scrolled away from the top, where new items appear.
  const list = screen.getByRole("listbox");
  Object.defineProperty(list, "scrollTop", { value: 500, writable: true });
  setMessages([...thread, person("p4", "fourth", 5), person("p5", "fifth", 6)]);
  // Announced: it appears in a live region that was already there.
  const status = screen.getByRole("status", { name: "New messages" });
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(
    within(status).getByRole("button", { name: "2 new" }),
  ).toBeInTheDocument();
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
  // A phone starts on a message.
  expect(screen.queryByRole("listbox")).toBeNull();
  await keys.click(screen.getByRole("button", { name: "All messages" }));
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
  await keys.keyboard("j");
  expect(screen.getByRole("article")).toHaveTextContent("third question");
});

test("new items at the top are seen when the list is at the top", () => {
  const { setMessages } = setup(thread, 4);
  setMessages([...thread, person("p4", "fourth", 5)]);
  expect(screen.queryByRole("button", { name: /new/ })).toBeNull();
  expect(options()[0]).toHaveTextContent("fourth");
});

test("the reading pane has the log's selection actions and a copy button", async () => {
  setup(thread, 4, { projectId: "project-1", path: "a.chat" });
  await user().click(screen.getByText(/first question/));
  const pane = screen.getByRole("article");
  // Each message: copy as markdown, and Reply/Quote/Copy on a selection.
  expect(within(pane).getAllByTestId("copy-button")).toHaveLength(2);
  expect(within(pane).getAllByTestId("contextual-reply")).toHaveLength(2);
  expect(
    within(pane)
      .getAllByTestId("contextual-reply")
      .map((el) => el.getAttribute("data-source")),
  ).toEqual(["p1", "a1"]);
});

test("narrow: keys keep working as items open, though the list goes", async () => {
  setup(thread, 4, { narrow: true });
  const keys = user();
  // Back on the list, which has the focus.
  await keys.click(screen.getByRole("button", { name: "All messages" }));
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
  // Opening an item replaces the list.
  await keys.keyboard("j");
  expect(screen.getByRole("article")).toHaveTextContent("third question");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("Reader"));
  await keys.keyboard("j");
  expect(screen.getByRole("article")).toHaveTextContent("second question");
});

test("phone: starts on the first unread message, with one bar to move and act", async () => {
  // p1 (with its answer) is read; p2 and p3 are not.
  const { state } = setup(thread, 2, { narrow: true });
  const keys = user();
  expect(screen.getByRole("article")).toHaveTextContent("third question");
  const bar = screen.getByRole("toolbar", { name: "Message navigation" });
  expect(bar).toHaveTextContent("1 of 3");
  // The list's header (Mark all read, Show archived) waits for the list.
  expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
  expect(within(bar).getByRole("button", { name: "Newer" })).toBeDisabled();
  await keys.click(within(bar).getByRole("button", { name: "Older" }));
  expect(screen.getByRole("article")).toHaveTextContent("second question");
  expect(bar).toHaveTextContent("2 of 3");
  await keys.click(within(bar).getByRole("button", { name: "Mark unread" }));
  expect(state().u).toEqual(["p2"]);
  await keys.click(within(bar).getByRole("button", { name: "Archive" }));
  expect(state().a).toEqual({ p2: "p2" });
  await keys.click(screen.getByRole("button", { name: "All messages" }));
  expect(
    screen.getByRole("button", { name: "Mark all read" }),
  ).toBeInTheDocument();
});

test("Newer and Older keep the keys working, though the pane is replaced", async () => {
  setup(thread, 4);
  const keys = user();
  await keys.click(screen.getByText(/second question/));
  await keys.click(screen.getByRole("button", { name: "Older" }));
  expect(screen.getByRole("article")).toHaveTextContent("first question");
  expect(document.activeElement).toBe(screen.getByRole("listbox"));
  await keys.keyboard("k");
  expect(screen.getByRole("article")).toHaveTextContent("second question");
});
