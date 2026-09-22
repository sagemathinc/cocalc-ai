import { EventEmitter } from "events";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { moveVisibleArtifactPin } from "../use-artifact-pins";
import userEvent from "@testing-library/user-event";
import { publishArtifact } from "@cocalc/chat";
import ArtifactBrowser, { ArtifactResults } from "../artifact-browser";
import { ArtifactBrowserButton } from "../artifact-discovery";
import { ChatEmbeddingOptionsProvider } from "../embedding-options";

test("Agents scope cannot include unrelated chatroom threads", async () => {
  const rows: any[] = [];
  const syncdb = Object.assign(new EventEmitter(), {
    get_one: () => undefined,
    set: (row) => rows.push(...(Array.isArray(row) ? row : [row])),
    get: () => rows.filter((row) => row.event === "chat-artifact-publication"),
  });
  for (const thread_id of ["one", "two"])
    publishArtifact(syncdb, {
      thread_id,
      artifact_id: "doc",
      operation_id: "op",
      message_id: "message",
      title: `Plan ${thread_id}`,
      markdown: "hello",
    });
  const view = (threadId?: string) => (
    <ChatEmbeddingOptionsProvider value={{ agentWorkspace: true }}>
      <ArtifactBrowser
        actions={{ syncdb } as any}
        threadId={threadId}
        onClose={() => {}}
      />
    </ChatEmbeddingOptionsProvider>
  );
  const { rerender } = render(view("one"));
  expect(
    screen.getByRole("combobox", { name: "Artifact scope" }),
  ).toBeDisabled();
  await waitFor(() => expect(screen.getByText("This agent")).toBeVisible());
  expect(screen.queryByText("Entire chatroom")).toBeNull();
  expect(screen.getByText("Plan one")).toBeVisible();
  expect(screen.queryByText("Plan two")).toBeNull();
  rerender(view("two"));
  expect(screen.getByText("Plan two")).toBeVisible();
  expect(screen.queryByText("Plan one")).toBeNull();
  rerender(view());
  expect(screen.queryByText("Plan two")).toBeNull();
  expect(
    screen.getByText("Select an agent to browse its artifacts."),
  ).toBeVisible();
});

test("pinning and keyboard menu actions retain custom order independently of sorting", async () => {
  const rows: any[] = [];
  const syncdb = Object.assign(new EventEmitter(), {
    get_one: () => undefined,
    set: (row) => rows.push(...(Array.isArray(row) ? row : [row])),
    get: () => rows.filter((row) => row.event === "chat-artifact-publication"),
  });
  for (const title of ["Alpha", "Beta"])
    publishArtifact(syncdb, {
      thread_id: "one",
      artifact_id: title,
      operation_id: "op",
      message_id: "message",
      title,
      markdown: "hello",
    });
  function Results() {
    const [pins, setPins] = useState<string[]>([]);
    return (
      <ArtifactResults
        actions={{ syncdb } as any}
        sort="title"
        organization={{
          pins,
          error: "",
          canPin: true,
          setPinned: (id, pinned) =>
            setPins((pins) =>
              pinned ? [...pins, id] : pins.filter((pin) => pin !== id),
            ),
          move: (visible, id, index) =>
            setPins((pins) => moveVisibleArtifactPin(pins, visible, id, index)),
        }}
      />
    );
  }
  render(<Results />);
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Pin Alpha" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Unpin Alpha" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Pin Beta" }));
  expect(screen.queryByRole("button", { name: /Move .* up/ })).toBeNull();
  const menu = screen.getByRole("button", { name: "More options for Beta" });
  menu.focus();
  await user.keyboard("{Enter}");
  const up = await screen.findByRole("menuitem", { name: "Move up" });
  up.focus();
  fireEvent.keyDown(up, { key: "Enter", keyCode: 13, which: 13 });
  const pinned = within(
    screen.getByRole("region", { name: "Pinned artifacts" }),
  );
  expect(
    pinned
      .getAllByRole("button", { name: /^Unpin / })
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Unpin Beta", "Unpin Alpha"]);
  await user.click(pinned.getByRole("button", { name: "Unpin Beta" }));
  expect(screen.getByRole("button", { name: "Pin Beta" })).toHaveFocus();
});

test("compact toolbar opens the current thread browser by keyboard and restores focus", async () => {
  const rows: any[] = [];
  const syncdb = Object.assign(new EventEmitter(), {
    get_one: () => undefined,
    set: (row) => rows.push(...(Array.isArray(row) ? row : [row])),
    get: () => rows.filter((row) => row.event === "chat-artifact-publication"),
  });
  for (const thread_id of ["one", "two"])
    publishArtifact(syncdb, {
      thread_id,
      artifact_id: "doc",
      operation_id: "op",
      message_id: "message",
      title: `Plan ${thread_id}`,
      markdown: "hello",
    });
  render(
    <ArtifactBrowserButton
      actions={{ syncdb } as any}
      threadId="one"
      compact
    />,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Browse artifacts" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const filter = await screen.findByRole("textbox", {
    name: "Filter artifacts",
  });
  await waitFor(() => expect(filter).toHaveFocus());
  expect(screen.getByText("Plan one")).toBeVisible();
  expect(screen.queryByText("Plan two")).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});

test("filter and keyboard opening preserve the source thread and close the modal", async () => {
  const rows: any[] = [];
  const syncdb = Object.assign(new EventEmitter(), {
    get_one: () => undefined,
    set: (row) => rows.push(...(Array.isArray(row) ? row : [row])),
    get: () => rows.filter((row) => row.event === "chat-artifact-publication"),
  });
  for (const thread_id of ["one", "two"])
    publishArtifact(syncdb, {
      thread_id,
      artifact_id: "doc",
      operation_id: "op",
      message_id: "message",
      title: `Plan ${thread_id}`,
      markdown: "hello",
    });
  const actions: any = {
    syncdb,
    frameId: "chat",
    frameTreeActions: {
      get_frame_ids_in_order: () => [],
      split_frame: jest.fn(),
    },
  };
  const close = jest.fn();
  render(<ArtifactBrowser actions={actions} onClose={close} />);
  const filter = screen.getByRole("textbox", { name: "Filter artifacts" });
  await waitFor(() => expect(filter).toHaveFocus());
  fireEvent.change(filter, { target: { value: "two" } });
  expect(
    screen.queryByRole("button", { name: "Open artifact: Plan one" }),
  ).toBeNull();
  const open = screen.getByRole("button", { name: "Open artifact: Plan two" });
  open.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(actions.frameTreeActions.split_frame).toHaveBeenCalledWith(
    "col",
    "chat",
    "workbench",
    expect.objectContaining({ "data-thread": "two", "data-artifact": "doc" }),
  );
  expect(close).toHaveBeenCalledTimes(1);
});

test("Escape dismisses the artifact browser", async () => {
  const close = jest.fn();
  render(
    <ArtifactBrowser
      actions={
        { syncdb: Object.assign(new EventEmitter(), { get: () => [] }) } as any
      }
      onClose={close}
    />,
  );
  const filter = screen.getByRole("textbox", { name: "Filter artifacts" });
  filter.focus();
  fireEvent.keyDown(filter, { key: "Escape", keyCode: 27, which: 27 });
  await waitFor(() => expect(close).toHaveBeenCalled());
});

test("scope and sort selectors keep room for their longest labels", async () => {
  render(
    <ArtifactBrowser
      actions={
        { syncdb: Object.assign(new EventEmitter(), { get: () => [] }) } as any
      }
      threadId="one"
      onClose={() => {}}
    />,
  );
  const user = userEvent.setup();
  const sort = screen.getByRole("combobox", { name: "Sort artifacts" });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Filter artifacts" }),
    ).toHaveFocus(),
  );
  await user.click(sort);
  fireEvent.click(screen.getByText("Title"));
  expect(sort.closest(".ant-select")).toHaveTextContent("Title");
  expect(sort.closest(".ant-select")).toHaveStyle({ width: "180px" });
  expect(
    screen
      .getByRole("combobox", { name: "Artifact scope" })
      .closest(".ant-select"),
  ).toHaveStyle({ width: "170px" });
});

test("conversation navigation uses the publication's message and thread", async () => {
  const rows: any[] = [];
  const syncdb = Object.assign(new EventEmitter(), {
    get_one: () => undefined,
    set: (row) => rows.push(...(Array.isArray(row) ? row : [row])),
    get: () => rows.filter((row) => row.event === "chat-artifact-publication"),
  });
  publishArtifact(syncdb, {
    thread_id: "source",
    artifact_id: "doc",
    operation_id: "op",
    message_id: "source-message",
    title: "Plan",
    markdown: "hello",
  });
  const gotoFragment = jest.fn();
  const close = jest.fn();
  const actions: any = {
    syncdb,
    getMessagesInThread: jest.fn(() => [
      { message_id: "source-message", date: new Date(12345) },
    ]),
    frameTreeActions: { gotoFragment },
  };
  render(<ArtifactResults actions={actions} query="hello" onOpen={close} />);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "More options for Plan" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Show in conversation" }),
  );
  expect(actions.getMessagesInThread).toHaveBeenCalledWith("source");
  expect(gotoFragment).toHaveBeenCalledWith({
    chat: "12345",
    thread: "source",
  });
  expect(close).toHaveBeenCalled();
});
