import { EventEmitter } from "events";
import { fromJS } from "immutable";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { artifactKey, artifactPublicationKey } from "@cocalc/chat";
import { Workbench } from "./workbench";
import { focusChatFrameInput } from "./actions";

jest.mock("./actions", () => ({ focusChatFrameInput: jest.fn() }));
jest.mock("@cocalc/frontend/components/diff-viewer/document-diff", () => ({
  __esModule: true,
  default: ({ before, after }) => (
    <div aria-label="Document changes">
      {before} / {after}
    </div>
  ),
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }) => <p>{value}</p>,
}));
jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: ({ value, getValueRef, height, autoGrow }) => (
    <textarea
      aria-label="Edit artifact"
      defaultValue={value}
      data-height={height}
      data-autogrow={String(autoGrow)}
      ref={(element) => {
        if (element && getValueRef) getValueRef.current = () => element.value;
      }}
    />
  ),
}));

test("selected text remains pinned through remote updates and keyboard focus changes", async () => {
  const target = { thread_id: "thread", artifact_id: "artifact" };
  let record = {
    ...artifactKey(target),
    ...target,
    schema_version: 1,
    kind: "markdown",
    title: "Draft",
    input: "Original passage",
  };
  const syncdb = Object.assign(new EventEmitter(), {
    get_one: () => record,
    get: () => [],
  });
  const stageArtifactFeedback = jest.fn(async () => {});
  const chat = { syncdb, stageArtifactFeedback };
  const actions = { getChatActions: () => chat, set_active_id: jest.fn() };
  render(
    <Workbench
      {...({
        actions,
        desc: fromJS({
          "data-origin": "origin",
          "data-thread": "thread",
          "data-artifact": "artifact",
        }),
        read_only: false,
        font_size: 14,
        project_id: "p",
        path: "x.chat",
      } as any)}
    />,
  );
  const range = document.createRange();
  range.selectNodeContents(screen.getByText("Original passage"));
  act(() => {
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  act(() => {
    record = { ...record, input: "New passage" };
    syncdb.emit("change");
  });
  expect(screen.getByText("Original passage")).toBeTruthy();
  expect(screen.queryByText("New passage")).toBeNull();
  const comment = screen.getByRole("button", { name: "Comment" });
  comment.focus();
  window.getSelection()?.removeAllRanges();
  await act(async () => {
    fireEvent.click(comment);
  });
  expect(stageArtifactFeedback).toHaveBeenCalledWith(
    expect.objectContaining({
      thread_id: "thread",
      markdown: "Original passage",
      quote: "Original passage",
    }),
  );
  expect(focusChatFrameInput).toHaveBeenCalledWith("origin");
  fireEvent.click(
    screen.getByRole("button", { name: "Show updated document" }),
  );
  expect(screen.getByText("New passage")).toBeTruthy();
});

test("Read flushes pending editor text and edit mode requests full height", async () => {
  const target = { thread_id: "thread", artifact_id: "artifact" };
  let record = {
    ...artifactKey(target),
    ...target,
    schema_version: 1,
    kind: "markdown",
    title: "Draft",
    input: "Original",
  };
  const syncdb = Object.assign(new EventEmitter(), {
    get_one: () => record,
    get: () => [],
    set: jest.fn((patch) => {
      record = { ...record, ...patch };
    }),
    commit: jest.fn(),
    save: jest.fn(async () => {}),
  });
  render(
    <Workbench
      {...({
        actions: { getChatActions: () => ({ syncdb }) },
        desc: fromJS({
          "data-origin": "origin",
          "data-thread": "thread",
          "data-artifact": "artifact",
        }),
        read_only: false,
        font_size: 14,
      } as any)}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Edit artifact" });
  expect(editor).toHaveAttribute("data-height", "100%");
  expect(editor).toHaveAttribute("data-autogrow", "false");
  fireEvent.change(editor, { target: { value: "Pending human edit" } });
  expect(record.input).toBe("Original");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
  });
  expect(record.input).toBe("Pending human edit");
  expect(syncdb.save).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Pending human edit")).toBeTruthy();
});

test("historical views stay pinned and See changes uses the preceding publication", async () => {
  const target = { thread_id: "thread", artifact_id: "artifact" };
  const publication = (operation_id, markdown, time) => ({
    ...artifactPublicationKey(target, operation_id),
    ...target,
    schema_version: 1,
    operation_id,
    message_id: "message",
    published_at: time,
    snapshot: { title: "Draft", markdown },
  });
  const pubs = [
    publication("first", "Old", "2026-09-09T00:00:00Z"),
    publication("second", "New", "2026-09-09T01:00:00Z"),
  ];
  const current = {
    ...artifactKey(target),
    ...target,
    schema_version: 1,
    kind: "markdown",
    title: "Draft",
    input: "Live human edit",
  };
  const syncdb = Object.assign(new EventEmitter(), {
    get: () => pubs,
    get_one: (key) =>
      key.event === "chat-artifact"
        ? current
        : pubs.find((pub) => pub.sender_id === key.sender_id),
  });
  const actions = {
    getChatActions: () => ({ syncdb }),
    set_frame_data: jest.fn(),
  };
  render(
    <Workbench
      {...({
        actions,
        id: "frame",
        desc: fromJS({
          "data-thread": "thread",
          "data-artifact": "artifact",
          "data-version": "second",
        }),
        read_only: false,
        font_size: 14,
      } as any)}
    />,
  );
  expect(screen.getByText("New")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "See changes" }));
  expect((await screen.findByLabelText("Document changes")).textContent).toBe(
    "Old / New",
  );
  act(() => {
    current.input = "Another edit";
    syncdb.emit("change");
  });
  expect(screen.getByLabelText("Document changes").textContent).toBe(
    "Old / New",
  );
});

test("read-only workbenches expose the document but cannot edit or stage feedback", () => {
  const target = { thread_id: "thread", artifact_id: "artifact" };
  const record = {
    ...artifactKey(target),
    ...target,
    schema_version: 1,
    kind: "markdown",
    title: "Read-only draft",
    input: "Visible content",
  };
  const stageArtifactFeedback = jest.fn();
  const syncdb = Object.assign(new EventEmitter(), {
    get_one: () => record,
    get: () => [],
  });
  render(
    <Workbench
      {...({
        actions: { getChatActions: () => ({ syncdb, stageArtifactFeedback }) },
        desc: fromJS({
          "data-origin": "origin",
          "data-thread": target.thread_id,
          "data-artifact": target.artifact_id,
        }),
        read_only: true,
        font_size: 14,
      } as any)}
    />,
  );
  expect(screen.getByText("Visible content")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  const comment = screen.getByRole("button", { name: "Comment" });
  expect(comment).toBeDisabled();
  fireEvent.click(comment);
  expect(stageArtifactFeedback).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: "Edit artifact" })).toBeNull();
});
