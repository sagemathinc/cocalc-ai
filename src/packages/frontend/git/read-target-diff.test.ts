import { budgetPatch, readTargetDiff } from "./read-target-diff";
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

const fileSection = (name: string, changed: number) =>
  [
    `diff --git a/${name} b/${name}`,
    "index 1111111..2222222 100644",
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -0,0 +1,${changed} @@`,
    ...Array.from({ length: changed }, (_, i) => `+line ${i}`),
  ].join("\n");

const entry = (name: string) => ({
  oldPath: name,
  newPath: name,
  oldSource: undefined,
  newSource: undefined,
});

test("a comparison too big to show whole keeps every file, the largest ones by header only", async () => {
  const names = ["a.txt", "b.txt", "huge.txt"];
  const reader = {
    changedFiles: jest.fn().mockResolvedValue(names.map(entry)),
    patch: jest
      .fn()
      .mockResolvedValue(
        [
          fileSection("a.txt", 9_000),
          fileSection("b.txt", 9_000),
          fileSection("huge.txt", 30_000),
        ].join("\n") + "\n",
      ),
    commitSummary: jest.fn().mockResolvedValue("commit x\n\n    message\n"),
  };
  const parsed = await readTargetDiff(reader as any, target, 3);
  // The reader is asked for the whole patch: the budget is per file here.
  expect(reader.patch).toHaveBeenCalledWith(target, 3, Infinity);
  expect(parsed.files.map((f) => f.path)).toEqual(names);
  expect(parsed.linesTruncated).toBe(false);
  expect(parsed.files[0].omittedLines).toBeUndefined();
  expect(parsed.files[1].omittedLines).toBeUndefined();
  // Its section: 5 header lines, 30,000 added lines and the final newline.
  expect(parsed.files[2].omittedLines).toBe(30_006);
  // Only its header is kept.
  expect(parsed.files[2].lines.some((l) => l.startsWith("@@"))).toBe(false);
  expect(parsed.files[2].lines[0]).toBe("diff --git a/huge.txt b/huge.txt");
});

test("a comparison that fits is unchanged", async () => {
  const reader = {
    changedFiles: jest.fn().mockResolvedValue([entry("a.txt")]),
    patch: jest.fn().mockResolvedValue(fileSection("a.txt", 3) + "\n"),
    commitSummary: jest.fn().mockResolvedValue("commit x\n"),
  };
  const parsed = await readTargetDiff(reader as any, target, 3);
  expect(parsed.files[0].omittedLines).toBeUndefined();
  expect(
    parsed.files[0].lines.filter((l) => l.startsWith("+line")),
  ).toHaveLength(3);
});

test("later files' headers are kept: an earlier file gives up its body for them", () => {
  // Fits whole by itself (6 + 8 lines), but not with the 4 later headers.
  const patch = [
    fileSection("a.txt", 9),
    ...["b", "c", "d", "e"].map((n) => fileSection(n, 1)),
  ].join("\n");
  const { patch: kept, omitted } = budgetPatch(patch, 24);
  expect(kept.split("\n").length).toBeLessThanOrEqual(24);
  expect(omitted[0]).toBe(14);
  // Every later file still has at least its header.
  for (const n of ["b", "c", "d", "e"])
    expect(kept).toContain(`diff --git a/${n} b/${n}`);
});

test("more files than their headers can list is refused, never a partial review", async () => {
  const names = Array.from({ length: 6000 }, (_, i) => `f${i}`);
  const reader = {
    changedFiles: jest.fn().mockResolvedValue(names.map(entry)),
    patch: jest
      .fn()
      .mockResolvedValue(names.map((n) => fileSection(n, 1)).join("\n")),
    commitSummary: jest.fn().mockResolvedValue("commit x\n"),
  };
  await expect(readTargetDiff(reader as any, target, 3)).rejects.toMatchObject({
    kind: "unsupported",
    message: expect.stringMatching(/6000 files, too many to list/),
  });
});
