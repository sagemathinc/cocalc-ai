import {
  readGitReviewShowMergesPreference,
  persistGitReviewShowMergesPreference,
} from "./drawer-storage";

test("merge commits default to hidden and the choice survives reopening", () => {
  localStorage.clear();
  expect(readGitReviewShowMergesPreference()).toBe(false);
  persistGitReviewShowMergesPreference(true);
  expect(readGitReviewShowMergesPreference()).toBe(true);
  persistGitReviewShowMergesPreference(false);
  expect(readGitReviewShowMergesPreference()).toBe(false);
});

test("unavailable preference storage does not prevent browsing", () => {
  const read = jest
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw Error("unavailable");
    });
  const write = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("unavailable");
    });
  try {
    expect(readGitReviewShowMergesPreference()).toBe(false);
    expect(() => persistGitReviewShowMergesPreference(true)).not.toThrow();
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});
