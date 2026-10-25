/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import TodoArtifact from "./todo-artifact";
import { isTodoPath } from "./file-artifact";

const readFile = jest.fn();
const stat = jest.fn();
const open_file = jest.fn().mockResolvedValue(undefined);
const actions = { fs: () => ({ stat, readFile }), open_file };
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions }),
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }) => <div data-testid="markdown">{value}</div>,
}));
jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => <span>a moment ago</span>,
}));

const todo = {
  format: "cocalc-todo",
  version: 1,
  title: "Agents polish",
  description: "What I am working on for **William**.",
  updated: "2026-10-25T06:40:00Z",
  categories: { review: { label: "In review", color: "#1677ff" } },
  sections: [
    { id: "ready", title: "Ready to merge" },
    { id: "next", title: "Next" },
  ],
  items: [
    {
      id: "panel",
      title: "Questions panel",
      status: "waiting",
      section: "ready",
      category: "review",
      priority: "high",
      waiting_for: "William's merge go",
      details: "CI green, review **CLEAR**.",
      links: [{ label: "PR #1377", url: "https://github.com/x/y/pull/1377" }],
    },
    { id: "search", title: "Reader search", status: "done", section: "ready" },
    {
      id: "retarget",
      title: "Retarget #1379",
      status: "doing",
      section: "next",
    },
    { id: "old", title: "Old idea", status: "cancelled", section: "next" },
  ],
};

beforeEach(() => {
  stat.mockResolvedValue({ size: 1000 });
  readFile.mockResolvedValue(JSON.stringify(todo));
});

test("only .todo.json files are todo lists", () => {
  expect(isTodoPath("/home/user/polish.todo.json")).toBe(true);
  expect(isTodoPath("/home/user/POLISH.TODO.JSON")).toBe(true);
  expect(isTodoPath("/home/user/todo.json")).toBe(false);
});

test("sections, statuses, progress, and details on click", async () => {
  render(<TodoArtifact path="/home/user/a.todo.json" historical={false} />);
  await screen.findByText("Agents polish");
  expect(screen.getByText("1 of 3 done")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Ready to merge" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Next" })).toBeTruthy();
  expect(screen.getByText("In review")).toBeTruthy();
  expect(screen.getByText("high priority")).toBeTruthy();
  expect(screen.getByText(/waiting for William's merge go/)).toBeTruthy();
  expect(screen.getByLabelText("In progress")).toBeTruthy();
  // Finished items are crossed out.
  expect(screen.getByText("Reader search").style.textDecoration).toBe(
    "line-through",
  );
  expect(screen.getByText("Old idea").style.textDecoration).toBe(
    "line-through",
  );
  expect(screen.queryByText("CI green, review **CLEAR**.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Questions panel" }));
  expect(screen.getByText("CI green, review **CLEAR**.")).toBeTruthy();
  expect(screen.getByText("PR #1377").getAttribute("href")).toBe(
    "https://github.com/x/y/pull/1377",
  );
});

test("finished items can be hidden", async () => {
  render(<TodoArtifact path="/home/user/a.todo.json" historical={false} />);
  await screen.findByText("Agents polish");
  fireEvent.click(screen.getByLabelText("Hide finished (2)"));
  expect(screen.queryByText("Reader search")).toBeNull();
  expect(screen.queryByText("Old idea")).toBeNull();
  expect(screen.getByText("Retarget #1379")).toBeTruthy();
});

test("a broken item is named, the rest still shown", async () => {
  readFile.mockResolvedValue(
    JSON.stringify({
      ...todo,
      items: [...todo.items, { id: "bad", title: "Bad", status: "maybe" }],
    }),
  );
  render(<TodoArtifact path="/home/user/a.todo.json" historical={false} />);
  await screen.findByText("Agents polish");
  expect(
    screen.getByText(
      "Some of this todo list could not be read; the rest is shown.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("items[4].status")).toBeTruthy();
});

test("refresh follows the file; a file that disappears is not shown", async () => {
  const onToolbarActions = jest.fn();
  render(
    <TodoArtifact
      path="/home/user/a.todo.json"
      historical={false}
      onToolbarActions={onToolbarActions}
    />,
  );
  await screen.findByText("Agents polish");
  readFile.mockRejectedValue(new Error("ENOENT"));
  const tools = onToolbarActions.mock.calls.at(-1)[0];
  await act(async () => {
    tools.find((t) => t.key === "refresh").onClick();
  });
  await screen.findByText("Error: ENOENT");
  expect(screen.queryByText("Agents polish")).toBeNull();
});

test("too large to preview", async () => {
  stat.mockResolvedValue({ size: 2 * 1024 * 1024 });
  render(<TodoArtifact path="/home/user/a.todo.json" historical={false} />);
  await screen.findByText(/exceeds the 1 MiB preview limit/);
});

test("follows the chat's font size", async () => {
  render(
    <TodoArtifact
      path="/home/user/a.todo.json"
      historical={false}
      fontSize={20}
    />,
  );
  const title = await screen.findByText("Agents polish");
  expect(title.style.fontSize).toBe("1.3em");
  expect((title.closest(".smc-vfill") as HTMLElement).style.fontSize).toBe(
    "20px",
  );
});
