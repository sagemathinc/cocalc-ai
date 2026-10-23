/** @jest-environment node */

import { prefetchCommitDiff } from "./prefetch";

const repository = {
  projectId: "p",
  commonDirectory: "/r/.git",
  locator: "/r",
  objectFormat: "sha1" as const,
};
const parent = "b".repeat(40);

test("reads the commit's diff once idle, and not after a cancel", async () => {
  const reader = {
    pinCommit: jest.fn(async () => ({
      kind: "commit" as const,
      repository,
      commit: parent,
      parent: null,
      parentIndex: 0,
    })),
    changedFiles: jest.fn(async () => []),
    patch: jest.fn(async () => ""),
    commitSummary: jest.fn(async () => "commit\n"),
  };
  let idle: (() => void) | undefined;
  const schedule = (run: () => void) => {
    idle = run;
    return () => (idle = undefined);
  };
  prefetchCommitDiff(reader as any, repository, parent, 3, schedule);
  expect(reader.pinCommit).not.toHaveBeenCalled();
  idle!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reader.pinCommit).toHaveBeenCalledWith(repository, parent);
  expect(reader.changedFiles).toHaveBeenCalled();
  expect(reader.patch).toHaveBeenCalledWith(expect.anything(), 3, Infinity);

  reader.pinCommit.mockClear();
  const cancel = prefetchCommitDiff(
    reader as any,
    repository,
    parent,
    3,
    schedule,
  );
  cancel();
  expect(idle).toBeUndefined();
  // A root commit has no parent: nothing to read.
  prefetchCommitDiff(reader as any, repository, null, 3, schedule);
  expect(idle).toBeUndefined();
});

test("a failed read ahead is ignored", async () => {
  const reader = {
    pinCommit: jest.fn(async () => {
      throw new Error("gone");
    }),
  };
  prefetchCommitDiff(reader as any, repository, parent, 3, (run) => {
    run();
    return () => {};
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reader.pinCommit).toHaveBeenCalled();
});
