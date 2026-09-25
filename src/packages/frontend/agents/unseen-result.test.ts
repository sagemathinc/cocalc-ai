import { hasUnseenResult, resultKey, setUnseenResult } from "./unseen-result";

test("retains an unseen completion until acknowledged, scoped to account and thread", () => {
  const key = resultKey("account", "project", "a.chat", "thread");
  setUnseenResult(key, true);
  expect(hasUnseenResult(key)).toBe(true);
  expect(localStorage.getItem(key)).toBe("1");
  expect(
    hasUnseenResult(resultKey("other", "project", "a.chat", "thread")),
  ).toBe(false);
  expect(
    hasUnseenResult(resultKey("account", "project", "a.chat", "other")),
  ).toBe(false);
  setUnseenResult(key, false);
  expect(hasUnseenResult(key)).toBe(false);
  expect(localStorage.getItem(key)).toBeNull();
});
