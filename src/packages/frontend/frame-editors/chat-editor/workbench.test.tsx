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
  default: ({ value, onChange }) => (
    <textarea
      aria-label="Edit artifact"
      value={value}
      onChange={(e) => onChange(e.target.value)}
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
