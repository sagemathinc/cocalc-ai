/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CalendarActions, TodoActions } from "./actions";
import { CalendarViewer, TodoViewer } from "./viewer";

const show_focused_frame_of_type = jest.fn();
jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({
    path: "/home/user/a.todo.json",
    actions: { show_focused_frame_of_type },
    // Not in desc for a fresh frame: the context resolves the default.
    desc: new Map(),
    font_size: 17,
  }),
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }) => <div data-testid="markdown">{value}</div>,
}));
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({}),
}));

const todo = {
  format: "cocalc-todo",
  version: 1,
  title: "Agents polish",
  items: [
    { id: "a", title: "Ship the viewer", status: "doing" },
    { id: "b", title: "Write tests", status: "done" },
  ],
};

test("a todo list shows from the live document and follows edits", () => {
  const { rerender } = render(<TodoViewer value={JSON.stringify(todo)} />);
  expect(screen.getByText("Agents polish")).toBeTruthy();
  expect(screen.getByText("1 of 2 done")).toBeTruthy();
  rerender(
    <TodoViewer
      value={JSON.stringify({
        ...todo,
        items: todo.items.map((i) => ({ ...i, status: "done" })),
      })}
    />,
  );
  expect(screen.getByText("2 of 2 done")).toBeTruthy();
});

test("the frame's resolved font size applies on first render", () => {
  render(<TodoViewer value={JSON.stringify(todo)} />);
  const frame = screen.getByText("Agents polish").closest(".smc-vfill");
  expect((frame as HTMLElement).style.fontSize).toBe("17px");
});

test("broken JSON names the problem; an empty file offers the JSON", async () => {
  const { rerender } = render(<TodoViewer value="{" />);
  expect(
    screen.getByText("This is not a todo list CoCalc can show."),
  ).toBeTruthy();
  rerender(<TodoViewer value="" />);
  fireEvent.click(screen.getByRole("button", { name: "Edit the JSON" }));
  expect(show_focused_frame_of_type).toHaveBeenCalledWith("cm");
});

test("Edit the JSON works from the keyboard", async () => {
  show_focused_frame_of_type.mockClear();
  render(<TodoViewer value="" />);
  const edit = screen.getByRole("button", { name: "Edit the JSON" });
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(edit);
  await user.keyboard("{Enter}");
  expect(show_focused_frame_of_type).toHaveBeenCalledWith("cm");
});

test("the view comes from the editor, not the sync path's name", () => {
  // this.path is the sync identity, e.g. a canonical /data/work.json.
  const fake = { path: "/data/work.json" };
  expect(CalendarActions.prototype._raw_default_frame_tree.call(fake)).toEqual({
    type: "calendar",
  });
  expect(TodoActions.prototype._raw_default_frame_tree.call(fake)).toEqual({
    type: "todo",
  });
});

test("a calendar shows as an agenda with the .ics download", () => {
  render(
    <CalendarViewer
      value={JSON.stringify({
        format: "cocalc-calendar",
        version: 1,
        title: "Deadlines",
        timezone: "UTC",
        events: [
          {
            id: "x",
            title: "File the return",
            start: "2999-01-04",
            all_day: true,
          },
        ],
      })}
    />,
  );
  expect(screen.getByText("Deadlines")).toBeTruthy();
});

test("Download .ics works from the keyboard", async () => {
  const createObjectURL = jest.fn(() => "blob:ics");
  Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(
    <CalendarViewer
      value={JSON.stringify({
        format: "cocalc-calendar",
        version: 1,
        title: "Deadlines",
        timezone: "UTC",
        events: [
          { id: "x", title: "File it", start: "2999-01-04", all_day: true },
        ],
      })}
    />,
  );
  const download = screen.getByRole("button", { name: "Download .ics" });
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(download);
  await user.keyboard("{Enter}");
  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(click).toHaveBeenCalledTimes(1);
  click.mockRestore();
});
