/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: diff line metadata, inline comment anchoring, and line-number layout helpers for git review diffs.

import { isDiffContentLine } from "../diff-prism";
import type { GitReviewCommentSide } from "../git-review-store";
import { hashGitCommitValue } from "./ids";
import type { CommentAnchor, DiffLineMeta } from "./types";

function parseHunkStarts(
  line: string,
): { oldStart: number; newStart: number } | undefined {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return undefined;
  const oldStart = Number(m[1]);
  const newStart = Number(m[2]);
  if (!Number.isFinite(oldStart) || !Number.isFinite(newStart))
    return undefined;
  return { oldStart, newStart };
}

export function buildDiffLineMetas(lines: string[]): DiffLineMeta[] {
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let hunkHeader: string | undefined;
  let hunkHash: string | undefined;
  return lines.map((line) => {
    const isCode = isDiffContentLine(line);
    const prefix = isCode ? line[0] : "";
    const body = isCode ? line.slice(1) : line;
    if (line.startsWith("@@ ")) {
      const starts = parseHunkStarts(line);
      oldLine = starts?.oldStart;
      newLine = starts?.newStart;
      hunkHeader = line;
      hunkHash = hashGitCommitValue(line);
      return {
        raw: line,
        isCode,
        prefix,
        body,
        hunkHeader,
        hunkHash,
        commentable: false,
      };
    }
    let oldLineNumber: number | undefined;
    let newLineNumber: number | undefined;
    let side: GitReviewCommentSide | undefined;
    let lineNumber: number | undefined;
    if (isCode) {
      if (prefix === "+") {
        newLineNumber = newLine;
        if (newLine != null) newLine += 1;
        side = "new";
        lineNumber = newLineNumber;
      } else if (prefix === "-") {
        oldLineNumber = oldLine;
        if (oldLine != null) oldLine += 1;
        side = "old";
        lineNumber = oldLineNumber;
      } else if (prefix === " ") {
        oldLineNumber = oldLine;
        newLineNumber = newLine;
        if (oldLine != null) oldLine += 1;
        if (newLine != null) newLine += 1;
        side = "context";
        lineNumber = newLineNumber ?? oldLineNumber;
      }
    }
    return {
      raw: line,
      isCode,
      prefix,
      body,
      oldLineNumber,
      newLineNumber,
      hunkHeader,
      hunkHash,
      side,
      lineNumber,
      commentable:
        !!isCode &&
        !!hunkHash &&
        side != null &&
        lineNumber != null &&
        Number.isFinite(lineNumber),
    };
  });
}

export function makeCommentAnchor(
  meta: DiffLineMeta,
  filePath: string,
): CommentAnchor | undefined {
  if (!meta.commentable || !meta.side || !meta.lineNumber) return undefined;
  return {
    filePath,
    side: meta.side,
    line: meta.lineNumber,
    hunk_header: meta.hunkHeader,
    hunk_hash: meta.hunkHash,
    snippet: meta.body.slice(0, 240),
  };
}

export function commentAnchorKey({
  side,
  line,
  hunk_hash,
}: {
  side: GitReviewCommentSide;
  line?: number;
  hunk_hash?: string;
}): string {
  return `${side}:${line ?? 0}:${hunk_hash ?? ""}`;
}

export function makeCommentId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `gitc-${Date.now().toString(36)}-${rand}`;
}

export function diffLineNumberColumnWidth(maxLine: number): string {
  const safeMaxLine = Math.max(0, Math.floor(maxLine || 0));
  const digits = Math.max(1, `${safeMaxLine}`.length);
  const chars = Math.max(3, digits);
  return `calc(${chars}ch + 12px)`;
}
