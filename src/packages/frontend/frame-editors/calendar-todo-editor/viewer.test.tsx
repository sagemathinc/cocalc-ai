/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { CalendarViewer, TodoViewer } from "./viewer";

const show_focused_frame_of_type = jest.fn();
jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({
    path: "/home/user/a.todo.json",
    actions: { show_focused_frame_of_type },
    desc: new Map([["font_size", 14]]),
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

test("broken JSON names the problem; an empty file offers the JSON", () => {
  const { rerender } = render(<TodoViewer value="{" />);
  expect(
    screen.getByText("This is not a todo list CoCalc can show."),
  ).toBeTruthy();
  rerender(<TodoViewer value="" />);
  fireEvent.click(screen.getByRole("button", { name: "Edit the JSON" }));
  expect(show_focused_frame_of_type).toHaveBeenCalledWith("cm");
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
  expect(screen.getByRole("button", { name: "Download .ics" })).toBeTruthy();
  expect(screen.getByText("Deadlines")).toBeTruthy();
});
