import { readTargetDiff } from "./read-target-diff";
import type { ImmutableReviewTarget } from "@cocalc/frontend/components/diff-viewer/review-model";

const target: ImmutableReviewTarget = {
  kind: "commit",
  repository: {
    projectId: "p",
    commonDirectory: "/repo/.git",
    locator: "/repo",
    objectFormat: "sha1",
  },
  commit: "a".repeat(40),
  parent: null,
  parentIndex: 0,
};

test("metadata mismatch is an error, never a partially mapped review", async () => {
  const reader = {
    changedFiles: jest.fn().mockResolvedValue([]),
    patch: jest
      .fn()
      .mockResolvedValue("diff --git a/a b/a\nnew file mode 100644\n"),
    commitSummary: jest.fn().mockResolvedValue(""),
  };
  await expect(readTargetDiff(reader, target, 3)).rejects.toMatchObject({
    kind: "incomplete",
  });
});

test("summary plus patch cannot bypass the drawer line limit", async () => {
  const reader = {
    changedFiles: jest.fn().mockResolvedValue([]),
    patch: jest.fn().mockResolvedValue(""),
    commitSummary: jest.fn().mockResolvedValue("    message\n".repeat(20001)),
  };
  await expect(readTargetDiff(reader, target, 3)).rejects.toMatchObject({
    kind: "incomplete",
  });
});
