import { activityPathContexts } from "./activity-path-context";

test("later commands cannot redirect earlier diffs or subsequent agent paths", () => {
  expect(
    activityPathContexts(
      [
        { kind: "config", workingDirectory: "/worktrees/feature" },
        { kind: "diff" },
        { kind: "terminal", cwd: "/tmp/build" },
        { kind: "file", cwd: "/worktrees/other" },
        { kind: "diff" },
      ],
      "/current/thread",
    ),
  ).toEqual([
    "/worktrees/feature",
    "/worktrees/feature",
    "/tmp/build",
    "/worktrees/other",
    "/worktrees/feature",
  ]);
});

test("config changes affect only their own and subsequent events", () => {
  const entries = [
    { kind: "diff" },
    { kind: "config", workingDirectory: "/new" },
    { kind: "diff" },
  ];
  expect(activityPathContexts(entries, "/old")).toEqual([
    "/old",
    "/new",
    "/new",
  ]);
  expect(activityPathContexts(entries)).toEqual([undefined, "/new", "/new"]);
});

test("literal paths survive and relative cwd does not replace known absolute context", () => {
  expect(
    activityPathContexts([
      { kind: "config", workingDirectory: "/work/space " },
      { kind: "terminal", cwd: "relative" },
      { kind: "diff" },
    ]),
  ).toEqual(["/work/space ", "/work/space ", "/work/space "]);
});
