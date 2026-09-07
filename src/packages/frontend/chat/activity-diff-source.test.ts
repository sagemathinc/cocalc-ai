import { activityDiffSource } from "./activity-diff-source";
import type { LineDiffResult } from "@cocalc/util/line-diff";

const empty: LineDiffResult = {
  lines: [],
  types: [],
  gutters: [],
  chunkBoundaries: [],
};
test("preserves sparse coordinates, literal operators and final-newline evidence", () => {
  const text =
    "@@ -0,0 +1,1 @@\n++literal\n@@ -90,1 +91,1 @@\n-old\n+new\n\\ No newline at end of file\n";
  const source = activityDiffSource(
    { ...empty, source: { kind: "unified", text } },
    "a.ts",
  );
  expect(source.kind).toBe("patch");
  if (source.kind === "patch") expect(source.patch).toContain(text);
  expect(source.label).toContain("not a Git revision");
});
test("keeps added/deleted documents exactly including missing final newline", () => {
  const source = activityDiffSource(
    { ...empty, source: { kind: "delete", text: "a\nlast" } },
    "a.ts",
  );
  expect(source).toMatchObject({
    kind: "documents",
    before: "a\nlast",
    after: "",
  });
});
test("does not infer lost coordinates from old display gutters", () => {
  expect(() => activityDiffSource(empty, "a.ts")).toThrow("no lossless patch");
});

test("does not normalize carriage returns belonging to source lines", () => {
  const text = "@@ -1 +1 @@\n-old\r\n+new\r\n";
  const result = activityDiffSource(
    { ...empty, source: { kind: "unified", text } },
    "a.txt",
  );
  expect(result.kind === "patch" && result.patch.endsWith(text)).toBe(true);
});
test.each([
  "@@ -0,1 +1,1 @@\n-a\n+b\n",
  "@@ -1 +1 @@\n\\ No newline at end of file\n-a\n+b\n",
  "@@ -1,2 +1,2 @@\n-a\n+b\n",
  "@@ -1 +1 @@\n-a\n+b\n+extra\n",
  "@@ -1 +1 @@\n-a\n@@ -2 +2 @@\n-b\n+c\n",
  "@@ -1 +1 @@\n?unknown\n",
])(
  "rejects incomplete or unsupported patches instead of inventing content",
  (text) => {
    expect(() =>
      activityDiffSource(
        { ...empty, source: { kind: "unified", text } },
        "a.ts",
      ),
    ).toThrow();
  },
);
