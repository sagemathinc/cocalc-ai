import { comparisonRoute, restoreComparisonRoute } from "./comparison-route";
import {
  parseGitComparisonRoute,
  readGitReviewRoute,
  setGitReviewRoute,
} from "./review-route";

const repository = {
  projectId: "p",
  locator: "/work",
  commonDirectory: "/work/.git",
  objectFormat: "sha1" as const,
};
const route = {
  commonDirectory: repository.commonDirectory,
  mode: "merge-base" as const,
  base: "a".repeat(40),
  head: "b".repeat(40),
};

test("pinned comparison routes survive reload and are removed on dismissal", () => {
  for (const comparison of [
    route,
    { ...route, mode: "trees" as const },
    {
      commonDirectory: route.commonDirectory,
      head: route.head,
      mode: "parent" as const,
      parentIndex: 1,
    },
  ]) {
    const review = { commit: "abc1234", cwd: repository.locator, comparison };
    const url = setGitReviewRoute(
      new URL("https://example.com/?other=1#thread"),
      review,
    );
    expect(readGitReviewRoute(url)).toEqual(review);
    expect(setGitReviewRoute(url).href).toBe(
      "https://example.com/?other=1#thread",
    );
  }
});

test("rejects moving refs, malformed shapes, mixed object formats, and invalid parents", () => {
  for (const value of [
    null,
    [],
    { ...route, head: "HEAD" },
    { ...route, base: "main" },
    { ...route, base: "a".repeat(64) },
    { ...route, commonDirectory: "bad\0path" },
    { ...route, mode: "parent", parentIndex: -1 },
    { ...route, mode: "parent", parentIndex: 0.5 },
    { ...route, mode: "other" },
  ]) {
    expect(parseGitComparisonRoute(JSON.stringify(value))).toBeUndefined();
  }
  expect(parseGitComparisonRoute("{")).toBeUndefined();
  const url = new URL(
    "https://example.com/?git-hash=abc1234&git-compare=broken",
  );
  expect(readGitReviewRoute(url)).toBeUndefined();
});

test("restoration validates repository ownership before resolving pinned endpoints", async () => {
  const reader = {
    invalidateDiscovery: jest.fn(),
    discover: jest.fn().mockResolvedValue({ repository }),
    compare: jest.fn().mockResolvedValue({ kind: "comparison" }),
    pinCommit: jest.fn().mockResolvedValue({ kind: "commit" }),
  };
  await restoreComparisonRoute(reader, repository, route);
  expect(reader.compare).toHaveBeenCalledWith(
    repository,
    route.base,
    route.head,
    "merge-base",
  );
  await restoreComparisonRoute(reader, repository, {
    commonDirectory: route.commonDirectory,
    head: route.head,
    mode: "parent",
    parentIndex: 1,
  });
  expect(reader.pinCommit).toHaveBeenCalledWith(repository, route.head, 1);
  reader.compare.mockClear();
  reader.discover.mockResolvedValue({
    repository: { ...repository, commonDirectory: "/different/.git" },
  });
  await expect(
    restoreComparisonRoute(reader, repository, route),
  ).rejects.toThrow("different repository");
  expect(reader.compare).not.toHaveBeenCalled();
});

test("serializes requested merge-base endpoint, not its derived ancestor", () => {
  expect(
    comparisonRoute({
      kind: "comparison",
      repository,
      base: "c".repeat(40),
      requestedBase: route.base,
      head: route.head,
      mode: "merge-base",
    }),
  ).toEqual(route);
});
