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

// rc-util returns "test-id" for every generated ID under Jest. A hovered
// tooltip can then steal the drawer's aria-labelledby target. Use production
// React ID semantics while retaining explicit IDs supplied by components.
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  ...jest.requireActual("@rc-component/util/lib/hooks/useId"),
  default: (id?: string) => {
    const generated = jest.requireActual("react").useId();
    return id || generated;
  },
}));

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
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open Library" })).toBeNull();
  const dialog = screen.getByRole("dialog", { name: "Artifacts" });
  expect(dialog.closest(".ant-drawer")).toHaveClass("ant-drawer-right");
  expect(dialog.closest(".ant-drawer-content-wrapper")).toHaveStyle({
    maxWidth: "100%",
    width: "400px",
  });
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

test("direct browser hides its portal for an inactive agent workspace", async () => {
  const actions = {
    syncdb: Object.assign(new EventEmitter(), { get: () => [] }),
  } as any;
  const close = jest.fn();
  const view = (active: boolean, agentWorkspace = true) => (
    <>
      <button>Destination</button>
      <ChatEmbeddingOptionsProvider
        value={{ agentWorkspace, agentWorkspaceActive: active }}
      >
        <ArtifactBrowser actions={actions} threadId="one" onClose={close} />
      </ChatEmbeddingOptionsProvider>
    </>
  );
  const { rerender } = render(view(false));
  expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
  rerender(view(true));
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Filter artifacts" }),
    ).toHaveFocus(),
  );
  const destination = screen.getByRole("button", { name: "Destination" });
  destination.focus();
  rerender(view(false));
  expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
  expect(destination).toHaveFocus();
  expect(close).not.toHaveBeenCalled();
  rerender(view(false, false));
  await waitFor(() =>
    expect(screen.getByRole("dialog", { name: "Artifacts" })).toBeVisible(),
  );
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

test.each([false, true])(
  "compact toolbar keyboard and focus restoration (agentWorkspace=%s)",
  async (agentWorkspace) => {
    const rows: any[] = [];
    const syncdb = Object.assign(new EventEmitter(), {
      get_one: () => undefined,
      set: (row) => rows.push(...(Array.isArray(row) ? row : [row])),
      get: () =>
        rows.filter((row) => row.event === "chat-artifact-publication"),
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
      <ChatEmbeddingOptionsProvider value={{ agentWorkspace }}>
        <ArtifactBrowserButton
          actions={{ syncdb } as any}
          threadId="one"
          compact
        />
      </ChatEmbeddingOptionsProvider>,
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
  },
);

test("agent toolbar toggles the panel and Open Library closes it before delegating", async () => {
  const onBrowseAllArtifacts = jest.fn(() => {
    expect(trigger).toHaveFocus();
  });
  render(
    <ChatEmbeddingOptionsProvider
      value={{ agentWorkspace: true, onBrowseAllArtifacts }}
    >
      <ArtifactBrowserButton
        actions={
          {
            syncdb: Object.assign(new EventEmitter(), { get: () => [] }),
          } as any
        }
        threadId="one"
        compact
      />
    </ChatEmbeddingOptionsProvider>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Browse artifacts" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(trigger);
  await screen.findByRole("dialog", { name: "Artifacts" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(document.querySelector(".ant-drawer-mask")).toBeNull();
  await user.click(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  const library = await screen.findByRole("button", { name: "Open Library" });
  library.focus();
  await user.keyboard("{Enter}");
  expect(onBrowseAllArtifacts).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("an open toolbar tooltip does not replace the artifact dialog's accessible name", async () => {
  render(
    <ChatEmbeddingOptionsProvider value={{ agentWorkspace: true }}>
      <ArtifactBrowserButton
        actions={
          {
            syncdb: Object.assign(new EventEmitter(), { get: () => [] }),
          } as any
        }
        threadId="one"
        compact
      />
    </ChatEmbeddingOptionsProvider>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Browse artifacts" });
  await user.hover(trigger);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip).toHaveTextContent("Browse artifacts");
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveAccessibleName("Artifacts");
  expect(dialog.getAttribute("aria-labelledby")).not.toBe(tooltip.id);
});

test.each(["inactive", "thread change"])(
  "agent panel closes without restoring old trigger focus on %s",
  async (reason) => {
    const actions = {
      syncdb: Object.assign(new EventEmitter(), { get: () => [] }),
    } as any;
    const view = (active: boolean, threadId: string) => (
      <>
        <button>Destination</button>
        <div hidden={!active}>
          <ChatEmbeddingOptionsProvider
            value={{ agentWorkspace: true, agentWorkspaceActive: active }}
          >
            <ArtifactBrowserButton
              actions={actions}
              threadId={threadId}
              compact
            />
          </ChatEmbeddingOptionsProvider>
        </div>
      </>
    );
    const { rerender } = render(view(true, "one"));
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Browse artifacts" });
    await user.click(trigger);
    const filter = await screen.findByRole("textbox", {
      name: "Filter artifacts",
    });
    await waitFor(() => expect(filter).toHaveFocus());
    const destination = screen.getByRole("button", { name: "Destination" });
    destination.focus();
    const focus = jest.spyOn(trigger, "focus");
    rerender(
      view(reason !== "inactive", reason === "thread change" ? "two" : "one"),
    );
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(destination).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    // Returning to the old workspace/thread must not resurrect its panel.
    rerender(view(true, "one"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(destination).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
    await user.click(trigger);
    expect(
      await screen.findByRole("dialog", { name: "Artifacts" }),
    ).toBeVisible();
  },
);

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
