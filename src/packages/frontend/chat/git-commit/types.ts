/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { GitReviewCommentSide } from "../git-review-store";

export type GitShowFile = {
  path: string;
  lines: string[];
};

export type GitShowSummary = {
  commit?: string;
  author?: string;
  authorDate?: string;
  committer?: string;
  commitDate?: string;
  message: string;
  extraHeaderLines: string[];
};

export type GitShowParsed = {
  summaryLines: string[];
  summary: GitShowSummary;
  files: GitShowFile[];
  repoRoot?: string;
  linesTruncated: boolean;
  originalLineCount: number;
  shownLineCount: number;
};

export type GitDiffFindMatch = {
  id: string;
  kind: "file" | "line";
  fileIndex: number;
  lineIndex?: number;
  preview: string;
};

export type GitLogEntry = {
  hash: string;
  subject: string;
};

export type HeadStatusEntry = {
  path: string;
  displayPath: string;
  statusCode: string;
  statusLabel: string;
  tracked: boolean;
};

export type DiffLineMeta = {
  raw: string;
  isCode: boolean;
  prefix: string;
  body: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  hunkHeader?: string;
  hunkHash?: string;
  side?: GitReviewCommentSide;
  lineNumber?: number;
  commentable: boolean;
};

export type CommentAnchor = {
  filePath: string;
  side: GitReviewCommentSide;
  line: number;
  hunk_header?: string;
  hunk_hash?: string;
  snippet?: string;
};

export type DrawerScrollState = {
  entries: Record<string, { top: number; updated_at: number }>;
  order: string[];
};

export type GitDiffScrollAnchor = {
  anchorId?: string;
  hunkHash?: string;
  offsetTop: number;
};
