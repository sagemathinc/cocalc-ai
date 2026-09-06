// Run with node --experimental-strip-types --test; tests the real ESM Pierre.
import assert from "node:assert/strict";
import { test } from "node:test";
import { containsPreviewLine, parsePreviewSource } from "./pierre-model.ts";

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
