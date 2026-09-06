/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  buildLegacyFileLocations,
  buildLegacyReviewAnnotations,
  legacyAnchorForLocation,
  legacyFindLocation,
  legacySourceRange,
  locateLegacyComment,
} from "./legacy-locations";
import type { GitReviewCommentV2 } from "../git-review-store";
import { makeCommentAnchor } from "./diff-lines";

const files = buildLegacyFileLocations([
  {
    path: "file.ts",
    lines: [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -10,3 +20,3 @@ function example()",
      " context",
      "--oldOperator",
      "++newOperator",
      " tail",
    ],
  },
]);

const anchor = makeCommentAnchor(files[0].lines[4], "file.ts")!;
const comment: GitReviewCommentV2 = {
  id: "stable-v2-id",
  file_path: "file.ts",
  ...anchor,
  body_md: "**please check** ![](attachment.png)",
  status: "submitted",
  submitted_at: 5,
  submission_turn_id: "turn",
  created_at: 1,
  updated_at: 2,
  local_revision: 3,
};

test("old and new context selections create the same unchanged V2 anchor", () => {
  expect(legacyAnchorForLocation(files[0], "old", 10)).toEqual(anchor);
  expect(legacyAnchorForLocation(files[0], "new", 20)).toEqual(anchor);
  expect(legacyAnchorForLocation(files[0], "old", 11)).toMatchObject({
    side: "old",
    line: 11,
    snippet: "-oldOperator",
  });
  expect(legacyAnchorForLocation(files[0], "new", 21)).toMatchObject({
    side: "new",
    line: 21,
    snippet: "+newOperator",
  });
  for (const line of [0, -1, 1.5, NaN, 999])
    expect(legacyAnchorForLocation(files[0], "new", line)).toBeUndefined();
  expect(
    legacyAnchorForLocation(
      { ...files[0], lines: [...files[0].lines, ...files[0].lines] },
      "new",
      20,
    ),
  ).toBeUndefined();
});

test("annotations group exact locations and retain unmatched and submitted records", () => {
  const second = { ...comment, id: "second" };
  const unmatched = { ...comment, id: "unmatched", snippet: "different" };
  const resolved = { ...comment, id: "resolved", status: "resolved" as const };
  const comments = [comment, second, unmatched, resolved];
  const before = JSON.stringify(comments);
  const input = {
    targetId: "target",
    files,
    comments,
    firstParentProvenance: true,
    showResolvedComments: false,
  };
  const result = buildLegacyReviewAnnotations(input);
  expect(result.byFile.get(files[0].fileId)).toEqual([
    { side: "additions", lineNumber: 20, comments: [comment, second] },
  ]);
  expect(result.unmatched.map((x) => x.comment)).toEqual([unmatched]);
  expect(result.byFile.get(files[0].fileId)![0].comments[0]).toBe(comment);
  expect(
    buildLegacyReviewAnnotations({
      ...input,
      showResolvedComments: true,
    }).byFile.get(files[0].fileId)![0].comments,
  ).toEqual([comment, second, resolved]);
  expect(
    buildLegacyReviewAnnotations({
      ...input,
      firstParentProvenance: false,
    }).unmatched.map((x) => x.comment),
  ).toEqual([comment, second, unmatched]);
  expect(JSON.stringify(comments)).toBe(before);
});

test("V2 context anchors retain unequal old/new lines and the original record", () => {
  const before = JSON.stringify(comment);
  const result = locateLegacyComment({
    files,
    targetId: "target",
    comment,
    firstParentProvenance: true,
  });
  expect(result.kind).toBe("matched");
  if (result.kind !== "matched") throw Error("expected match");
  expect(result.oldLine).toBe(10);
  expect(result.newLine).toBe(20);
  expect(result.location).toMatchObject({ side: "new", line: 20 });
  expect(result.comment).toBe(comment);
  expect(JSON.stringify(comment)).toBe(before);
});

test("ambiguous provenance, paths, and changed snippets remain visible and unmatched", () => {
  for (const overrides of [
    { firstParentProvenance: false },
    { files: [...files, ...files] },
    { comment: { ...comment, snippet: "wrong" } },
    { comment: { ...comment, line: 10 } },
    { files: [] },
  ]) {
    const input = {
      files,
      targetId: "target",
      comment,
      firstParentProvenance: true,
      ...overrides,
    };
    const result = locateLegacyComment(input);
    expect(result.kind).toBe("unmatched");
    expect(result.comment).toBe(input.comment);
  }
});

test("context-size changes can match exact side, line and snippet without changing V2 hunk evidence", () => {
  const changed = {
    ...comment,
    hunk_hash: "older-context-hash",
    hunk_header: "old header",
  };
  expect(
    locateLegacyComment({
      files,
      targetId: "target",
      comment: changed,
      firstParentProvenance: true,
    }).kind,
  ).toBe("matched");
  expect(changed.hunk_hash).toBe("older-context-hash");
});

test("search maps offscreen rows to source coordinates, not a display index", () => {
  const match = legacyFindLocation("target", files, {
    id: "find",
    kind: "line",
    fileIndex: 0,
    lineIndex: 6,
    preview: "+newOperator",
  });
  expect(match?.location).toMatchObject({ side: "new", line: 21 });
  expect(
    legacyFindLocation("target", files, {
      id: "file",
      kind: "file",
      fileIndex: 0,
      preview: "file.ts",
    })?.location,
  ).toBeUndefined();
});

test("source copying excludes patch markers but preserves literal operators and partial columns", () => {
  const base = {
    targetId: "target",
    fileId: files[0].fileId,
    side: "new" as const,
    line: 20,
    endLine: 22,
  };
  expect(legacySourceRange(files[0], base)).toBe("context\n+newOperator\ntail");
  expect(
    legacySourceRange(files[0], {
      ...base,
      side: "old",
      line: 10,
      endLine: 12,
    }),
  ).toBe("context\n-oldOperator\ntail");
  expect(
    legacySourceRange(files[0], {
      ...base,
      line: 21,
      endLine: 21,
      column: 2,
      endColumn: 5,
    }),
  ).toBe("new");
  expect(legacySourceRange(files[0], { ...base, endLine: 23 })).toBeUndefined();
});
