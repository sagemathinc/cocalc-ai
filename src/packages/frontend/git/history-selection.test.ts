import { currentHistorySelection } from "./history-selection";

test("explicit commit requests reset browsing context even in the same repository", () => {
  const pinned = {
    scope: "project\0/repo",
    requestToken: 1,
    selection: { worktree: "/feature", ref: "HEAD", firstParent: true },
    tip: "a".repeat(40),
  };
  expect(currentHistorySelection(pinned, pinned.scope, 1)).toBe(pinned);
  expect(currentHistorySelection(pinned, pinned.scope, 2)).toBeUndefined();
  expect(currentHistorySelection(pinned, "other\0/repo", 1)).toBeUndefined();
  expect(currentHistorySelection(pinned, "project\0/other", 1)).toBeUndefined();
  expect(currentHistorySelection(undefined, pinned.scope, 1)).toBeUndefined();
});
