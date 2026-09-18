import { EventEmitter } from "events";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { publishArtifact } from "@cocalc/chat";
import ArtifactBrowser, { ArtifactResults } from "../artifact-browser";

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
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Show in conversation: Plan" }));
  expect(actions.getMessagesInThread).toHaveBeenCalledWith("source");
  expect(gotoFragment).toHaveBeenCalledWith({
    chat: "12345",
    thread: "source",
  });
  expect(close).toHaveBeenCalled();
});
