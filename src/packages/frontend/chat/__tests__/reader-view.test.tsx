import {
  act,
  cleanup as cleanupAll,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useReaderFullScreen } from "../reader-full-screen";
import { ChatReaderView } from "../reader-view";
import type { ReaderChange, ReaderState } from "../reader-model";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => undefined,
  redux: { getActions: () => undefined },
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
  let state: ReaderState = (props as any).initialState ?? {};
  let count = readCount;
  let stars: string[] = [];
  const actions: any = {
    getThreadReadCount: jest.fn(() => count),
    getReaderState: jest.fn(() => state),
    getReaderStars: jest.fn(() => stars),
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
    actions.updateReaderStars = jest.fn(
      (_thread: string, change: (starred: string[]) => string[]) => {
        stars = change(stars);
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
    stars: () => stars,
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
  // Clicking an item gives the open message the focus: Space pages it, and
  // the keys still work from there.
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("article")),
  );
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
  expect(screen.getByText("No unread messages")).toBeInTheDocument();
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
  expect(screen.getByText("No unread messages")).toBeInTheDocument();
});

test("archive all: a clean slate, after confirming", async () => {
  const { count, setMessages } = setup(thread, 0);
  expect(options()).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Archive all" }));
  // Nothing happens until it is confirmed.
  expect(options()).toHaveLength(3);
  expect(
    await screen.findByText("Archive all 3 messages?"),
  ).toBeInTheDocument();
  const [, confirm] = screen.getAllByRole("button", { name: "Archive all" });
  fireEvent.click(confirm);
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.getByText("No unread messages")).toBeInTheDocument();
  expect(count()).toBe(4);
  expect(
    screen.getAllByRole("button", { name: "Archive all" })[0],
  ).toBeDisabled();
  // A new message is in the inbox.
  setMessages([...thread, person("p4", "fourth question", 5)]);
  expect(options()).toHaveLength(1);
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
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("article")),
  );
  await keys.keyboard("k");
  expect(screen.getByRole("article")).toHaveTextContent("second question");
});

test("archiving the open item with the pane's button keeps the keys working", async () => {
  setup(thread, 4);
  const keys = user();
  await keys.click(screen.getByText(/second question/));
  await keys.click(screen.getByRole("button", { name: "Archive" }));
  expect(screen.getByRole("article")).toHaveTextContent("first question");
  // The next message has the focus, so Space pages it after y too.
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("article")),
  );
  await keys.keyboard("k");
  expect(screen.getByRole("article")).toHaveTextContent("third question");
});

test("the running turn's place in the toolbar is kept, so nothing moves", () => {
  setup(thread, 4);
  // Nothing running: the place is there, empty, before the unread count.
  const slot = screen.getByRole("group", { name: "Running turn" });
  expect(slot).toBeEmptyDOMElement();
  expect(slot.nextElementSibling).toHaveTextContent("No unread messages");
  cleanupAll();
  setup(thread, 4, {
    runningStatus: <button type="button">Interrupt</button>,
  });
  const running = screen.getByRole("group", { name: "Running turn" });
  expect(
    within(running).getByRole("button", { name: "Interrupt" }),
  ).toBeInTheDocument();
  expect(running.nextElementSibling).toHaveTextContent("No unread messages");
});

test("narrow: no place is kept (the status shows above)", () => {
  setup(thread, 4, { narrow: true });
  fireEvent.click(screen.getByRole("button", { name: "All messages" }));
  expect(screen.queryByRole("group", { name: "Running turn" })).toBeNull();
});

test("full screen: f shows the open message over the window, paging stays there", async () => {
  setup(thread, 4);
  const keys = user();
  await keys.click(screen.getByText(/second question/));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole("article")),
  );
  await keys.keyboard("f");
  const dialog = screen.getByRole("dialog", { name: "Message, full screen" });
  expect(within(dialog).getByRole("article")).toHaveTextContent(
    "second question",
  );
  expect(dialog).toHaveTextContent("2 of 3");
  // Older (j) moves within full screen.
  await keys.click(within(dialog).getByRole("button", { name: "Older" }));
  expect(
    within(
      screen.getByRole("dialog", { name: "Message, full screen" }),
    ).getByRole("article"),
  ).toHaveTextContent("first question");
  await keys.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("article")).toHaveTextContent("first question");
});

test("full screen: Tab stays inside it", async () => {
  setup(thread, 4);
  const keys = user();
  await keys.click(screen.getByText(/second question/));
  await keys.keyboard("f");
  const dialog = screen.getByRole("dialog", { name: "Message, full screen" });
  const buttons = within(dialog).getAllByRole("button");
  buttons[buttons.length - 1].focus();
  await keys.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await keys.tab({ shift: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
});

test("full screen: a message's own Focus button opens the reader's", async () => {
  function FocusButton() {
    const fullScreen = useReaderFullScreen();
    return (
      <button type="button" onClick={() => fullScreen?.open()}>
        Focus message
      </button>
    );
  }
  setup(thread, 4, { renderItem: () => <FocusButton /> });
  const keys = user();
  await keys.click(screen.getByText(/third question/));
  await keys.click(screen.getByRole("button", { name: "Focus message" }));
  const dialog = screen.getByRole("dialog", { name: "Message, full screen" });
  expect(within(dialog).getByRole("button", { name: "Exit full screen" }));
  await keys.click(
    within(dialog).getByRole("button", { name: "Exit full screen" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("search: the current hit opens its item, and items with hits are marked", () => {
  setup(thread, 4, {
    searchJump: { date: "2", token: 1 },
    searchDates: new Set(["2", "4"]),
  });
  expect(screen.getByRole("article")).toHaveTextContent("first answer");
  const marked = options().map(
    (option) => within(option).queryByLabelText("Matches the search") != null,
  );
  // p3 (4) and p1 with its answer a1 (2); not p2.
  expect(marked).toEqual([true, false, true]);
});

test("search: a hit in an archived item shows archived items to open it", () => {
  setup(thread, 4, {
    initialState: { a: { p2: "p2" } },
    searchJump: { date: "3", token: 1 },
  });
  expect(screen.getByRole("checkbox", { name: "Show archived" })).toBeChecked();
  expect(screen.getByRole("article")).toHaveTextContent("second question");
});

test("About explains the reader, and its Keys tab lists the shortcuts", async () => {
  setup(thread, 4, { autoFocus: true });
  const keys = user();
  await keys.click(screen.getByRole("button", { name: "About" }));
  const dialog = await screen.findByRole("dialog", {
    name: "About the reader",
  });
  expect(dialog).toHaveTextContent("Show archived");
  expect(dialog).toHaveTextContent("Archive all");
  // Without priorities there are no For you and Low priority views.
  expect(dialog).not.toHaveTextContent("Low priority");
  await keys.click(within(dialog).getByRole("tab", { name: "Keys" }));
  expect(
    within(dialog).getByRole("table", { name: "Keyboard shortcuts" }),
  ).toHaveTextContent("Mark the open message unread");
});

test("? opens About on its Keys tab", async () => {
  setup(thread, 4, { autoFocus: true });
  await user().keyboard("?");
  const dialog = await screen.findByRole("dialog", {
    name: "About the reader",
  });
  expect(within(dialog).getByRole("tab", { name: "Keys" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(dialog).toHaveTextContent("Next unread message");
});

test("the unread status says what it is", () => {
  setup(thread, 2);
  expect(screen.getByText("2 unread")).toBeInTheDocument();
});

test("an agent message is shown as the log shows it: its From card", async () => {
  setup(
    [
      {
        message_id: "rpc1",
        sender_id: "acct",
        date: new Date(1),
        history: [{ content: "Acknowledged", author_id: "acct" }],
        agent_rpc: {
          source: {
            agent_id: "22222222-2222-4222-8222-222222222222",
            project_id: "p1",
          },
          source_label: "@agent-1",
          agent_network_id: "88888888-8888-4888-8888-888888888888",
          attempt_id: "55555555-5555-4555-8555-555555555555",
        },
      },
    ],
    1,
  );
  await user().click(screen.getByRole("option"));
  expect(screen.getByRole("article")).toHaveTextContent(
    /```agent-message .*direction=incoming/,
  );
});

test("a read-only chat offers no replies from a selection, as in the log", async () => {
  setup(thread, 4, { projectId: "project-1", path: "a.chat", readOnly: true });
  await user().click(screen.getByText(/first question/));
  for (const el of within(screen.getByRole("article")).getAllByTestId(
    "contextual-reply",
  ))
    expect(el).toHaveAttribute("data-disabled", "true");
});

test("phone: another thread opens on its own first message", () => {
  const actions: any = {
    getThreadReadCount: jest.fn(() => 0),
    getReaderState: jest.fn(() => ({})),
    getReaderStars: jest.fn(() => []),
    updateReaderState: jest.fn(() => true),
  };
  const view = (threadId: string, messages: any[]) => (
    <ChatReaderView
      actions={actions}
      threadId={threadId}
      messages={messages}
      accountId="acct"
      narrow
    />
  );
  const { rerender } = render(view("thread-1", thread));
  expect(screen.getByRole("article")).toHaveTextContent("third question");
  rerender(view("thread-2", [person("q1", "other thread", 7)]));
  expect(screen.getByRole("article")).toHaveTextContent("other thread");
});

test("phone: a hidden chat opens and reads nothing until it is shown", () => {
  const actions: any = {
    getThreadReadCount: jest.fn(() => 0),
    getReaderState: jest.fn(() => ({})),
    getReaderStars: jest.fn(() => []),
    updateReaderState: jest.fn(() => true),
  };
  const view = (isVisible: boolean) => (
    <ChatReaderView
      actions={actions}
      threadId="thread-1"
      messages={thread}
      accountId="acct"
      narrow
      isVisible={isVisible}
    />
  );
  const { rerender } = render(view(false));
  expect(screen.queryByRole("article")).toBeNull();
  expect(actions.updateReaderState).not.toHaveBeenCalled();
  rerender(view(true));
  expect(screen.getByRole("article")).toHaveTextContent("third question");
  expect(actions.updateReaderState).toHaveBeenCalled();
});

test("phone: in a background browser tab nothing opens or is read until it is shown", () => {
  const actions: any = {
    getThreadReadCount: jest.fn(() => 0),
    getReaderState: jest.fn(() => ({})),
    getReaderStars: jest.fn(() => []),
    updateReaderState: jest.fn(() => true),
  };
  const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(true);
  try {
    render(
      <ChatReaderView
        actions={actions}
        threadId="thread-1"
        messages={thread}
        accountId="acct"
        narrow
      />,
    );
    expect(screen.queryByRole("article")).toBeNull();
    expect(actions.updateReaderState).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByRole("article")).toHaveTextContent("third question");
    expect(actions.updateReaderState).toHaveBeenCalled();
  } finally {
    hidden.mockRestore();
  }
});

test("phone: opens nothing until the read state loads", () => {
  let ready = false;
  const actions: any = {
    isProjectReadStateReady: jest.fn(() => ready),
    getThreadReadCount: jest.fn(() => 0),
    // Once loaded: the newest is archived.
    getReaderState: jest.fn(() => (ready ? { a: { p3: "p3" } } : {})),
    getReaderStars: jest.fn(() => []),
    updateReaderState: jest.fn(() => true),
  };
  const view = (readStateVersion: number) => (
    <ChatReaderView
      actions={actions}
      threadId="thread-1"
      messages={thread}
      accountId="acct"
      readStateVersion={readStateVersion}
      narrow
    />
  );
  const { rerender } = render(view(0));
  expect(screen.queryByRole("article")).toBeNull();
  expect(actions.updateReaderState).not.toHaveBeenCalled();
  ready = true;
  rerender(view(1));
  // Not the archived one it would have opened before.
  expect(screen.getByRole("article")).toHaveTextContent("second question");
});

test("the open item can be shown by the log, and the list can mark items", () => {
  const actions: any = {
    getThreadReadCount: jest.fn(() => 0),
    getReaderState: jest.fn(() => ({})),
    getReaderStars: jest.fn(() => []),
    updateReaderState: jest.fn(() => true),
  };
  render(
    <ChatReaderView
      actions={actions}
      threadId="thread-1"
      messages={thread}
      accountId="acct"
      narrow
      renderItem={(item) => <div data-testid="item-log">{item.id}</div>}
      itemBadges={(item) => (item.id === "p3" ? <span>Question</span> : null)}
    />,
  );
  // Opened on its own (narrow): the newest item, through the log.
  expect(screen.getByTestId("item-log")).toHaveTextContent("p3");
  expect(screen.queryByText("third question")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All messages" }));
  expect(within(options()[0]).getByText("Question")).toBeTruthy();
  expect(within(options()[1]).queryByText("Question")).toBeNull();
});

test("items show their subject; high ones are marked for you, and the open one is titled", () => {
  const actions: any = {
    getThreadReadCount: jest.fn(() => 0),
    getReaderState: jest.fn(() => ({})),
    getReaderStars: jest.fn(() => []),
    updateReaderState: jest.fn(() => true),
  };
  render(
    <ChatReaderView
      actions={actions}
      threadId="thread-1"
      messages={thread}
      accountId="acct"
      itemInfo={(item) =>
        item.id === "p3"
          ? { subject: "Needs your decision", priority: "high" }
          : { subject: `About ${item.id}`, priority: "normal" }
      }
    />,
  );
  const [top, next] = options();
  expect(top).toHaveTextContent("Needs your decision");
  expect(within(top).getByLabelText("For you")).toBeTruthy();
  expect(next).toHaveTextContent("About p2");
  expect(within(next).queryByLabelText("For you")).toBeNull();
  expect(within(next).queryByLabelText("Low priority")).toBeNull();
  fireEvent.click(top);
  expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
    "Needs your decision",
  );
});

describe("views: for you, all, low priority", () => {
  beforeEach(() => localStorage.removeItem("cocalc-chat-reader-view"));
  const info = (item: { id: string }) =>
    ({
      subject: `About ${item.id}`,
      priority: item.id === "p2" || item.id === "p1" ? "low" : "normal",
    }) as const;
  const show = (itemInfo = info) =>
    render(
      <ChatReaderView
        actions={
          {
            getThreadReadCount: jest.fn(() => 0),
            getReaderState: jest.fn(() => ({})),
            getReaderStars: jest.fn(() => []),
            updateReaderState: jest.fn(() => true),
          } as any
        }
        threadId="thread-1"
        messages={thread}
        accountId="acct"
        itemInfo={itemInfo}
      />,
    );
  const subjects = () => options().map((o) => o.textContent);

  test("for you hides what is filed, and counts only what is for you", () => {
    show();
    expect(subjects()).toEqual([expect.stringContaining("About p3")]);
    expect(screen.getByText("For you (1)")).toBeTruthy();
    expect(screen.getByText("1 unread")).toBeTruthy();
    // Low priority: the low ones, with their own count.
    fireEvent.click(screen.getByText("Low priority (2)"));
    expect(subjects()).toEqual([
      expect.stringContaining("About p2"),
      expect.stringContaining("About p1"),
    ]);
    fireEvent.click(screen.getByText("All"));
    expect(options()).toHaveLength(3);
  });

  test("the choice is kept", () => {
    const { unmount } = show();
    fireEvent.click(screen.getByText("All"));
    unmount();
    show();
    expect(options()).toHaveLength(3);
  });

  test("the switcher is a labelled group of choices the keyboard reaches", async () => {
    const keys = user();
    show();
    const group = screen.getByRole("radiogroup", { name: "Which messages" });
    const forYou = within(group).getByRole("radio", { name: /For you/ });
    expect(forYou).toBeChecked();
    // Tab reaches the checked choice; the arrow keys move between them.
    forYou.focus();
    await keys.keyboard("{ArrowRight}");
    const all = within(group).getByRole("radio", { name: "All" });
    expect(all).toBeChecked();
    expect(options()).toHaveLength(3);
  });

  test("filed items that are archived are said to be archived", () => {
    render(
      <ChatReaderView
        actions={
          {
            getThreadReadCount: jest.fn(() => 0),
            getReaderState: jest.fn(() => ({
              a: { p1: "a1", p2: "p2" },
            })),
            getReaderStars: jest.fn(() => []),
            updateReaderState: jest.fn(() => true),
          } as any
        }
        threadId="thread-1"
        messages={thread}
        accountId="acct"
        itemInfo={info}
      />,
    );
    fireEvent.click(screen.getByText(/^Low priority/));
    expect(screen.getByText("Everything here is archived")).toBeTruthy();
  });

  test("the Low priority count includes archived unread items while they are shown", () => {
    render(
      <ChatReaderView
        actions={
          {
            getThreadReadCount: jest.fn(() => 0),
            // p1's item is archived (and unread: nothing has been read).
            getReaderState: jest.fn(() => ({ a: { p1: "a1" } })),
            getReaderStars: jest.fn(() => []),
            updateReaderState: jest.fn(() => true),
          } as any
        }
        threadId="thread-1"
        messages={thread}
        accountId="acct"
        itemInfo={info}
      />,
    );
    expect(screen.getByText("Low priority (1)")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
    expect(screen.getByText("Low priority (2)")).toBeTruthy();
  });

  test("nothing for you says where the rest is", () => {
    show(((item) => ({ subject: item.id, priority: "low" })) as any);
    expect(
      screen.getByText("Nothing for you here: the rest is low priority"),
    ).toBeTruthy();
    expect(screen.getByText("No unread messages")).toBeTruthy();
  });

  test("About explains the views and where priority comes from", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    const dialog = screen.getByRole("dialog", { name: "About the reader" });
    for (const text of [
      "For you",
      "Low priority",
      "Starred",
      "cocalc agent turn --priority",
    ]) {
      expect(dialog).toHaveTextContent(text);
    }
  });
});

describe("stars", () => {
  beforeEach(() => localStorage.removeItem("cocalc-chat-reader-view"));

  test("s stars the open message; Starred lists starred ones, archived too", async () => {
    const { stars } = setup(thread, 0, { autoFocus: true });
    const keys = user();
    await keys.keyboard("u");
    expect(screen.getByRole("article")).toHaveTextContent("third question");
    await keys.keyboard("s");
    expect(stars()).toEqual(["p3"]);
    // Marked in the list, not by color alone: it is named.
    expect(within(options()[0]).getByLabelText("Starred")).toBeTruthy();
    const unstar = screen.getByRole("button", { name: "Unstar" });
    expect(unstar).toHaveAttribute("aria-pressed", "true");
    // Archived, it stays starred, and the Starred view still has it.
    await keys.keyboard("y");
    expect(stars()).toEqual(["p3"]);
    fireEvent.click(screen.getByRole("radio", { name: "Starred (1)" }));
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveTextContent("Alice");
  });

  test("the Star button works from the keyboard, and unstars", async () => {
    const { stars } = setup(thread, 0);
    fireEvent.click(options()[0]);
    // Opening it moves the focus to the message on the next frames.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const keys = user();
    const starButton = screen.getByRole("button", { name: "Star" });
    expect(starButton).toHaveAttribute("aria-pressed", "false");
    starButton.focus();
    await keys.keyboard("{Enter}");
    expect(stars()).toEqual(["p3"]);
    screen.getByRole("button", { name: "Unstar" }).focus();
    await keys.keyboard("{Enter}");
    expect(stars()).toEqual([]);
    fireEvent.click(screen.getByRole("radio", { name: "Starred" }));
    expect(
      screen.getByText("No starred messages (s stars the open one)"),
    ).toBeTruthy();
  });

  test("phone: the bar stars the open message", async () => {
    const { stars } = setup(thread, 0, { narrow: true });
    await waitFor(() => expect(screen.getByRole("article")).toBeTruthy());
    fireEvent.click(
      within(
        screen.getByRole("toolbar", { name: "Message navigation" }),
      ).getByRole("button", { name: "Star" }),
    );
    expect(stars()).toHaveLength(1);
  });

  test("archiving in Starred keeps the message open, as the list keeps it", async () => {
    const { state } = setup(thread, 0, { autoFocus: true });
    const keys = user();
    await keys.keyboard("u");
    await keys.keyboard("s");
    fireEvent.click(screen.getByRole("radio", { name: "Starred (1)" }));
    fireEvent.click(options()[0]);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.getByRole("article")).toHaveTextContent("third question");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(state().a?.p3).toBeTruthy();
    expect(options()).toHaveLength(1);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("article")).toHaveTextContent("third question");
  });
});

describe("the list's width", () => {
  beforeEach(() => localStorage.removeItem("cocalc-chat-reader-list-width"));
  const handle = () =>
    screen.getByRole("separator", { name: /Resize the message list/ });
  const width = () => Number(handle().getAttribute("aria-valuenow"));

  test("arrow keys on its edge resize it, within bounds, and it is kept", () => {
    const { unmount } = render(
      <ChatReaderView
        actions={
          {
            getThreadReadCount: jest.fn(() => 0),
            getReaderState: jest.fn(() => ({})),
            getReaderStars: jest.fn(() => []),
            updateReaderState: jest.fn(() => true),
          } as any
        }
        threadId="thread-1"
        messages={thread}
        accountId="acct"
      />,
    );
    expect(width()).toBe(340);
    expect(handle()).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(width()).toBe(364);
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(width()).toBe(284);
    for (let i = 0; i < 10; i++)
      fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(width()).toBe(220);
    expect(localStorage.getItem("cocalc-chat-reader-list-width")).toBe("220");
    unmount();
    render(
      <ChatReaderView
        actions={
          {
            getThreadReadCount: jest.fn(() => 0),
            getReaderState: jest.fn(() => ({})),
            getReaderStars: jest.fn(() => []),
            updateReaderState: jest.fn(() => true),
          } as any
        }
        threadId="thread-1"
        messages={thread}
        accountId="acct"
      />,
    );
    expect(width()).toBe(220);
  });

  test("dragging its edge resizes it, leaving the open message room", () => {
    // jsdom has no PointerEvent: a mouse event carries the position.
    const hadPointerEvent = "PointerEvent" in window;
    if (!hadPointerEvent) (window as any).PointerEvent = MouseEvent;
    render(
      <ChatReaderView
        actions={
          {
            getThreadReadCount: jest.fn(() => 0),
            getReaderState: jest.fn(() => ({})),
            getReaderStars: jest.fn(() => []),
            updateReaderState: jest.fn(() => true),
          } as any
        }
        threadId="thread-1"
        messages={thread}
        accountId="acct"
      />,
    );
    fireEvent.pointerDown(handle(), { clientX: 340 });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 440 }));
    });
    expect(width()).toBe(440);
    // Not past what leaves the open message its room.
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 5000 }));
    });
    expect(width()).toBe(window.innerWidth - 320);
    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
    expect(localStorage.getItem("cocalc-chat-reader-list-width")).toBe(
      `${window.innerWidth - 320}`,
    );
    if (!hadPointerEvent) delete (window as any).PointerEvent;
  });

  test("a cancelled drag, or one the reader leaves, lets the pointer go", () => {
    const hadPointerEvent = "PointerEvent" in window;
    if (!hadPointerEvent) (window as any).PointerEvent = MouseEvent;
    const added = jest.spyOn(window, "addEventListener");
    const removed = jest.spyOn(window, "removeEventListener");
    const listening = (type: string) =>
      added.mock.calls.filter(([t]) => t === type).length -
      removed.mock.calls.filter(([t]) => t === type).length;
    const view = () => (
      <ChatReaderView
        actions={
          {
            getThreadReadCount: jest.fn(() => 0),
            getReaderState: jest.fn(() => ({})),
            getReaderStars: jest.fn(() => []),
            updateReaderState: jest.fn(() => true),
          } as any
        }
        threadId="thread-1"
        messages={thread}
        accountId="acct"
      />
    );
    try {
      const { unmount } = render(view());
      const before = ["pointermove", "pointerup", "pointercancel"].map(
        listening,
      );
      fireEvent.pointerDown(handle(), { clientX: 340 });
      act(() => {
        window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
      });
      act(() => {
        window.dispatchEvent(new MouseEvent("pointercancel"));
      });
      expect(
        ["pointermove", "pointerup", "pointercancel"].map(listening),
      ).toEqual(before);
      expect(localStorage.getItem("cocalc-chat-reader-list-width")).toBe("400");
      // Moving the pointer after that resizes nothing.
      act(() => {
        window.dispatchEvent(new MouseEvent("pointermove", { clientX: 500 }));
      });
      expect(width()).toBe(400);
      // Gone mid-drag: nothing is left listening.
      fireEvent.pointerDown(handle(), { clientX: 400 });
      expect(listening("pointermove")).toBe(before[0] + 1);
      unmount();
      expect(
        ["pointermove", "pointerup", "pointercancel"].map(listening),
      ).toEqual(before);
    } finally {
      added.mockRestore();
      removed.mockRestore();
      if (!hadPointerEvent) delete (window as any).PointerEvent;
    }
  });

  test("phone: no edge to drag", () => {
    setup(thread, 0, { narrow: true });
    expect(
      screen.queryByRole("separator", { name: /Resize the message list/ }),
    ).toBeNull();
  });
});
