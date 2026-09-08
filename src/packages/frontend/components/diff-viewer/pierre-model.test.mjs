// Run with node --experimental-strip-types --test; tests the real ESM Pierre.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityDiffSource } from "../../chat/activity-diff-source.ts";
import {
  containsPreviewLine,
  parsePreviewSource,
  parseReviewPatchFiles,
} from "./pierre-model.ts";

test("recorded activity retains multiple sparse hunks and literal filenames", () => {
  const [file] = parsePreviewSource(
    activityDiffSource(
      {
        lines: [],
        types: [],
        gutters: [],
        chunkBoundaries: [],
        source: {
          kind: "unified",
          text: "@@ -10,1 +20,1 @@\n--old\n++new\n@@ -90,1 +100,1 @@\n-last\n+changed\n\\ No newline at end of file\n",
        },
      },
      "a b.ts",
    ),
  );
  assert.equal(file.name, "a b.ts");
  assert.equal(file.isPartial, true);
  assert.equal(containsPreviewLine(file, 20, "additions"), true);
  assert.equal(containsPreviewLine(file, 90, "deletions"), true);
  assert.equal(containsPreviewLine(file, 50, "additions"), false);
  assert.equal(file.hunks.length, 2);
});

test("a sparse patch retains old/new line positions and excludes missing context", () => {
  const [file] = parsePreviewSource({
    kind: "patch",
    label: "fixture",
    patch:
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -10,2 +20,2 @@\n-const value = 1;\n+const value = 2;\n // context\n",
  });
  assert.equal(file.isPartial, true);
  assert.equal(containsPreviewLine(file, 10, "deletions"), true);
  assert.equal(containsPreviewLine(file, 20, "additions"), true);
  assert.equal(containsPreviewLine(file, 10, "additions"), false);
  assert.equal(containsPreviewLine(file, 22, "additions"), false);
  assert.equal(containsPreviewLine(file, -1, "deletions"), false);
});

test("complete TimeTravel versions support unchanged lines outside diff hunks", () => {
  const before =
    Array.from({ length: 300 }, (_, i) => `const line${i} = ${i};`).join("\n") +
    "\n";
  const [file] = parsePreviewSource({
    kind: "documents",
    label: "history",
    path: "file.ts",
    before,
    after: before.replace("line50 = 50", "line50 = 51"),
  });
  assert.equal(file.isPartial, false);
  assert.equal(containsPreviewLine(file, 200, "additions"), true);
  assert.equal(containsPreviewLine(file, 301, "additions"), false);
});

test("a truncated patch reports an error instead of presenting a complete review", () => {
  assert.throws(() =>
    parsePreviewSource({
      kind: "patch",
      label: "truncated",
      patch:
        "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-old\n+new\n",
    }),
  );
});

test("production parsing preserves file indexes, renames, deletion sides, and source operators", () => {
  const files = [
    {
      path: "new.ts",
      lines: [
        "diff --git a/old.ts b/new.ts",
        "similarity index 90%",
        "rename from old.ts",
        "rename to new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
        "@@ -1 +1 @@",
        "--before",
        "++after",
      ],
    },
    {
      path: "gone.ts",
      lines: [
        "diff --git a/gone.ts b/gone.ts",
        "deleted file mode 100644",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-deleted",
      ],
    },
  ];
  const parsed = parseReviewPatchFiles(files, false);
  assert.deepEqual(
    parsed.map((x) => x.name),
    ["new.ts", "gone.ts"],
  );
  assert.equal(parsed[0].prevName, "old.ts");
  assert.equal(parsed[1].type, "deleted");
  assert.equal(parsed[0].additionLines[0].trimEnd(), "+after");
  assert.equal(parsed[0].deletionLines[0].trimEnd(), "-before");
  assert.throws(() => parseReviewPatchFiles(files, true), /incomplete/);
  assert.throws(
    () => parseReviewPatchFiles([{ ...files[0], path: "wrong.ts" }], false),
    /filename/,
  );
  assert.throws(
    () =>
      parseReviewPatchFiles(
        [{ ...files[0], lines: [...files[0].lines, ...files[1].lines] }],
        false,
      ),
    /exactly one/,
  );
});

test("production parsing enforces aggregate bounds before invoking the renderer", () => {
  assert.throws(
    () =>
      parseReviewPatchFiles(
        [{ path: "a", lines: Array(20_001).fill("x") }],
        false,
      ),
    /20,000/,
  );
  assert.throws(
    () =>
      parseReviewPatchFiles(
        [{ path: "a", lines: ["x".repeat(4 * 1024 * 1024)] }],
        false,
      ),
    /4 MB/,
  );
});
