import { fromJS } from "immutable";
import {
  recordedTurnDirectory,
  resolveGitTurnDirectory,
} from "./git-turn-context";

const events = [
  {
    type: "event",
    event: { type: "config", workingDirectory: "/old worktree " },
  },
];
test("preserves the recorded literal path instead of current thread settings", async () => {
  const loadEvents = jest.fn();
  expect(
    await resolveGitTurnDirectory({ events, loadEvents, fallback: "/new" }),
  ).toBe("/old worktree ");
  expect(loadEvents).not.toHaveBeenCalled();
  expect(recordedTurnDirectory(fromJS(events))).toBe("/old worktree ");
});
test("loads archived config when the message preview omits it", async () => {
  const loadEvents = jest.fn().mockResolvedValue(events);
  expect(
    await resolveGitTurnDirectory({ events: [], loadEvents, fallback: "/new" }),
  ).toBe("/old worktree ");
  expect(loadEvents).toHaveBeenCalledTimes(1);
});
test("does not silently redirect after a transport error", async () => {
  await expect(
    resolveGitTurnDirectory({
      events: [],
      loadEvents: async () => {
        throw Error("offline");
      },
      fallback: "/new",
    }),
  ).rejects.toThrow("offline");
});
test("retains a fallback hint for old turns without recorded config", async () => {
  expect(
    await resolveGitTurnDirectory({
      events: [],
      loadEvents: async () => [],
      fallback: "/fallback",
    }),
  ).toBe("/fallback");
});
