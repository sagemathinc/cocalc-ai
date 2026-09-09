import { EventEmitter } from "events";
import { fromJS } from "immutable";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { artifactKey } from "@cocalc/chat";
import { Workbench } from "./workbench";
import { focusChatFrameInput } from "./actions";

jest.mock("./actions", () => ({ focusChatFrameInput: jest.fn() }));
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
  const syncdb = Object.assign(new EventEmitter(), { get_one: () => record });
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
