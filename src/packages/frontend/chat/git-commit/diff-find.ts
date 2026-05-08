/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Focus: file-level diff search and rendered-line visibility math for the virtualized git review drawer.

import { buildGitReviewFileSectionId } from "./ids";
import type { GitDiffFindMatch, GitShowParsed } from "./types";

export const INITIAL_RENDERED_DIFF_LINES = 1000;
export const RENDERED_DIFF_LINES_INCREMENT = 1500;

function countCaseInsensitiveMatches(text: string, needle: string): number {
  const haystack = `${text ?? ""}`.toLowerCase();
  const normalizedNeedle = `${needle ?? ""}`.trim().toLowerCase();
  if (!haystack || !normalizedNeedle) return 0;
  let count = 0;
  let start = 0;
  while (start <= haystack.length - normalizedNeedle.length) {
    const idx = haystack.indexOf(normalizedNeedle, start);
    if (idx === -1) break;
    count += 1;
    start = idx + normalizedNeedle.length;
  }
  return count;
}

export function buildGitDiffFindMatches({
  data,
  query,
}: {
  data?: Pick<GitShowParsed, "files">;
  query: string;
}): GitDiffFindMatch[] {
  const normalizedQuery = `${query ?? ""}`.trim();
  if (!normalizedQuery || !data?.files?.length) return [];
  const matches: GitDiffFindMatch[] = [];
  for (const [fileIndex, file] of data.files.entries()) {
    if (countCaseInsensitiveMatches(file.path, normalizedQuery) > 0) {
      matches.push({
        id: `file:${fileIndex}`,
        kind: "file",
        fileIndex,
        preview: file.path,
      });
    }
    for (const [lineIndex, line] of file.lines.entries()) {
      if (countCaseInsensitiveMatches(line, normalizedQuery) === 0) continue;
      matches.push({
        id: `line:${fileIndex}:${lineIndex}`,
        kind: "line",
        fileIndex,
        lineIndex,
        preview: line,
      });
    }
  }
  return matches;
}

export function getRenderedDiffLineLimit(requested?: number): number {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) {
    return INITIAL_RENDERED_DIFF_LINES;
  }
  return Math.max(INITIAL_RENDERED_DIFF_LINES, Math.floor(value));
}

export function getNextRenderedDiffLineLimit(current?: number): number {
  return getRenderedDiffLineLimit(current) + RENDERED_DIFF_LINES_INCREMENT;
}

export function isGitDiffFindTargetRendered({
  data,
  match,
  visibleDiffLinesByFile,
}: {
  data?: Pick<GitShowParsed, "files">;
  match?: GitDiffFindMatch;
  visibleDiffLinesByFile: Record<string, number>;
}): boolean {
  if (!data || !match) return false;
  const file = data.files?.[match.fileIndex];
  if (!file) return false;
  if (match.kind === "file" || typeof match.lineIndex !== "number") {
    return true;
  }
  const sectionId = buildGitReviewFileSectionId(file.path, match.fileIndex);
  const visibleLineLimit = getRenderedDiffLineLimit(
    visibleDiffLinesByFile[sectionId],
  );
  return match.lineIndex < visibleLineLimit;
}

export function getGitDiffFindVisibleLineLimitUpdate({
  data,
  match,
  visibleDiffLinesByFile,
}: {
  data?: Pick<GitShowParsed, "files">;
  match?: GitDiffFindMatch;
  visibleDiffLinesByFile: Record<string, number>;
}): { sectionId: string; neededLimit: number } | undefined {
  if (!data || !match || typeof match.lineIndex !== "number") return;
  const file = data.files?.[match.fileIndex];
  if (!file) return;
  const sectionId = buildGitReviewFileSectionId(file.path, match.fileIndex);
  const neededLimit = getRenderedDiffLineLimit(match.lineIndex + 1);
  const currentVisibleLimit = getRenderedDiffLineLimit(
    visibleDiffLinesByFile[sectionId],
  );
  if (currentVisibleLimit >= neededLimit) {
    return;
  }
  return { sectionId, neededLimit };
}
