/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DiffLocation } from "@cocalc/frontend/components/diff-viewer/review-model";
import { diffFileKey } from "@cocalc/frontend/components/diff-viewer/review-model";
import type { GitReviewCommentV2 } from "../git-review-store";
import type {
  CommentAnchor,
  DiffLineMeta,
  GitDiffFindMatch,
  GitShowFile,
} from "./types";
import { buildDiffLineMetas, makeCommentAnchor } from "./diff-lines";

export interface LegacyFileLocations {
  file: GitShowFile;
  fileId: string;
  lines: DiffLineMeta[];
}

export function buildLegacyFileLocations(
  files: GitShowFile[],
): LegacyFileLocations[] {
  return files.map((file) => ({
    file,
    // Legacy file paths already include the drawer parser's interpretation.
    // Preserve them for V2 matching; do not silently rewrite historical keys.
    fileId: diffFileKey(file.path, file.path),
    lines: buildDiffLineMetas(file.lines),
  }));
}

export function legacyLineLocation(
  targetId: string,
  file: LegacyFileLocations,
  index: number,
): DiffLocation | undefined {
  const row = file.lines[index];
  if (!row?.commentable) return;
  const side = row.side === "old" ? "old" : "new";
  const line = side === "old" ? row.oldLineNumber : row.newLineNumber;
  if (line == null || line < 1) return;
  return { targetId, fileId: file.fileId, side, line };
}

export function legacyFindLocation(
  targetId: string,
  files: LegacyFileLocations[],
  match: GitDiffFindMatch,
): { fileId: string; location?: DiffLocation } | undefined {
  const file = files[match.fileIndex];
  if (!file) return;
  return {
    fileId: file.fileId,
    location:
      match.lineIndex == null
        ? undefined
        : legacyLineLocation(targetId, file, match.lineIndex),
  };
}

/** A selected context line keeps its V2 context anchor, even in the old pane. */
export function legacyAnchorForLocation(
  file: LegacyFileLocations,
  side: "old" | "new",
  line: number,
): CommentAnchor | undefined {
  if (!Number.isSafeInteger(line) || line < 1) return;
  const rows = file.lines.filter(
    (row) =>
      row.commentable &&
      (side === "old" ? row.oldLineNumber : row.newLineNumber) === line,
  );
  if (rows.length !== 1) return;
  return makeCommentAnchor(rows[0], file.file.path) ?? undefined;
}

export interface LegacyReviewAnnotation {
  side: "additions" | "deletions";
  lineNumber: number;
  comments: GitReviewCommentV2[];
}

export interface LegacyReviewAnnotations {
  byFile: Map<string, LegacyReviewAnnotation[]>;
  unmatched: Array<Extract<LegacyCommentLocation, { kind: "unmatched" }>>;
}

/** Group for rendering without rewriting a stored ID, anchor, or submitted state. */
export function buildLegacyReviewAnnotations({
  targetId,
  files,
  comments,
  firstParentProvenance,
  showResolvedComments,
}: {
  targetId: string;
  files: LegacyFileLocations[];
  comments: GitReviewCommentV2[];
  firstParentProvenance: boolean;
  showResolvedComments: boolean;
}): LegacyReviewAnnotations {
  const result: LegacyReviewAnnotations = { byFile: new Map(), unmatched: [] };
  const groups = new Map<string, LegacyReviewAnnotation>();
  for (const comment of comments) {
    if (!showResolvedComments && comment.status === "resolved") continue;
    const match = locateLegacyComment({
      targetId,
      files,
      comment,
      firstParentProvenance,
    });
    if (match.kind === "unmatched") {
      result.unmatched.push(match);
      continue;
    }
    const { fileId, side, line } = match.location;
    const key = JSON.stringify([fileId, side, line]);
    let group = groups.get(key);
    if (!group) {
      group = {
        side: side === "old" ? "deletions" : "additions",
        lineNumber: line,
        comments: [],
      };
      groups.set(key, group);
      const list = result.byFile.get(fileId) ?? [];
      list.push(group);
      result.byFile.set(fileId, list);
    }
    group.comments.push(comment);
  }
  return result;
}

export type LegacyCommentLocation =
  | {
      kind: "matched";
      comment: GitReviewCommentV2;
      location: DiffLocation;
      oldLine?: number;
      newLine?: number;
    }
  | { kind: "unmatched"; comment: GitReviewCommentV2; reason: string };

/** Resolve for display only. Never mutate the V2 record, IDs, or submitted state. */
export function locateLegacyComment({
  targetId,
  files,
  comment,
  firstParentProvenance,
}: {
  targetId: string;
  files: LegacyFileLocations[];
  comment: GitReviewCommentV2;
  firstParentProvenance: boolean;
}): LegacyCommentLocation {
  const unmatched = (reason: string): LegacyCommentLocation => ({
    kind: "unmatched",
    comment,
    reason,
  });
  if (!firstParentProvenance)
    return unmatched(
      "Legacy comment has no selected-parent/comparison provenance",
    );
  const candidates = files.filter(
    ({ file }) => file.path === comment.file_path,
  );
  if (candidates.length !== 1)
    return unmatched("Legacy file path is absent or ambiguous");
  const file = candidates[0];
  const matches = file.lines.flatMap((row, index) => {
    if (
      !row.commentable ||
      row.side !== comment.side ||
      row.lineNumber !== comment.line
    )
      return [];
    if (
      row.side === "context" &&
      (row.oldLineNumber == null || row.newLineNumber == null)
    )
      return [];
    const hasSnippet = comment.snippet != null;
    const snippetMatches =
      hasSnippet && row.body.slice(0, 240) === comment.snippet;
    if (hasSnippet && !snippetMatches) return [];
    const hunkMatches =
      comment.hunk_hash != null && row.hunkHash === comment.hunk_hash;
    if (!snippetMatches && !hunkMatches) return [];
    const location = legacyLineLocation(targetId, file, index);
    return location
      ? [{ location, oldLine: row.oldLineNumber, newLine: row.newLineNumber }]
      : [];
  });
  if (matches.length !== 1)
    return unmatched("Legacy line/snippet evidence is absent or ambiguous");
  return { kind: "matched", comment, ...matches[0] };
}

// Capture a selected side from source coordinates, never by stripping symbols
// from rendered text. Absence of any intervening line means missing context.
export function legacySourceRange(
  file: LegacyFileLocations,
  location: DiffLocation,
): string | undefined {
  if (file.fileId !== location.fileId) return;
  const end = location.endLine ?? location.line;
  if (
    !Number.isSafeInteger(location.line) ||
    !Number.isSafeInteger(end) ||
    location.line < 1 ||
    end < location.line ||
    end - location.line > 20_000
  )
    return;
  const rows = new Map<number, string>();
  for (const row of file.lines) {
    if (!row.commentable) continue;
    const line =
      location.side === "old" ? row.oldLineNumber : row.newLineNumber;
    if (line != null) {
      if (rows.has(line)) return;
      rows.set(line, row.body);
    }
  }
  const selected: string[] = [];
  for (let line = location.line; line <= end; line++) {
    let body = rows.get(line);
    if (body == null) return;
    const startColumn = line === location.line ? (location.column ?? 1) : 1;
    const endColumn =
      line === end ? (location.endColumn ?? body.length + 1) : body.length + 1;
    if (
      !Number.isInteger(startColumn) ||
      !Number.isInteger(endColumn) ||
      startColumn < 1 ||
      endColumn < startColumn ||
      endColumn > body.length + 1
    )
      return;
    body = body.slice(startColumn - 1, endColumn - 1);
    selected.push(body);
  }
  return selected.join("\n");
}
