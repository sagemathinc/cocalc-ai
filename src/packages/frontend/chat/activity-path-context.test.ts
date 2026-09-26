import {
  activityPathContexts,
  agentMessageDirectory,
} from "./activity-path-context";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

test("agent links use the turn's persisted cwd even after preferences change and logs are trimmed", () => {
  expect(
    agentMessageDirectory({
      workingDirectory: "/home/user/original",
      events: [],
      fallback: "/home/user/next-turn",
    }),
  ).toBe("/home/user/original");
});

test("legacy responses use their config event before current thread settings, not a subprocess cwd", () => {
  const events = [
    {
      type: "event",
      event: { type: "config", workingDirectory: "/home/user" },
    },
    { type: "event", event: { type: "terminal", cwd: "/tmp/build" } },
  ] as AcpStreamMessage[];
  expect(agentMessageDirectory({ events, fallback: "/home/user/later" })).toBe(
    "/home/user",
  );
});

test("missing old turn metadata falls back to the configured absolute cwd, otherwise leaves chat context unchanged", () => {
  expect(agentMessageDirectory({ fallback: "/home/user" })).toBe("/home/user");
  expect(
    agentMessageDirectory({
      workingDirectory: "relative",
      fallback: "/home/user",
    }),
  ).toBe("/home/user");
  expect(agentMessageDirectory({})).toBeUndefined();
  expect(agentMessageDirectory({ fallback: "relative" })).toBeUndefined();
});

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
