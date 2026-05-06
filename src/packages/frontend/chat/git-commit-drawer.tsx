/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Checkbox,
  Dropdown,
  Drawer,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Typography,
  type MenuProps,
} from "antd";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { useEffectiveEditorThemeForPath } from "@cocalc/frontend/project/workspaces/use-effective-editor-theme";
import { memo, type ComponentProps } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import { redux } from "@cocalc/frontend/app-framework";
import { Icon, TimeAgo, Tooltip } from "@cocalc/frontend/components";
import { filenameMode } from "@cocalc/frontend/file-associations";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { backtickSequence } from "@cocalc/frontend/markdown/util";
import { containingPath } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import {
  deleteAllReviewRecords,
  exportReviewBundle,
  importReviewBundle,
  loadReviewRecord,
  loadReviewDraft,
  type GitReviewCommentSide,
  type GitReviewCommentV2,
  normalizeCommitSha,
  saveReviewDraft,
  saveReviewRecord,
  type GitReviewRecordV2,
} from "./git-review-store";
import { buildAgentCommitPrompt } from "./git-commit-prompt";
import {
  highlightPrismLines,
  isDiffContentLine,
  languageHintFromPath,
} from "./diff-prism";
import "./git-commit-drawer.css";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

const MAX_GIT_SHOW_LINES = 20_000;
const MAX_GIT_SHOW_OUTPUT_BYTES = 4_000_000;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const HEAD_REF = "HEAD";
const DEFAULT_CONTEXT_LINES = 3;
const GIT_LOG_FETCH_COUNT = 750;
const GIT_LOG_WINDOW_SIZE = 250;
const DRAWER_SIZE_STORAGE_KEY = "cocalc:chat:gitCommitDrawerSize";
const DRAWER_SCROLL_STORAGE_KEY = "cocalc:chat:gitCommitDrawerScroll:v1";
const MAX_DRAWER_SCROLL_ENTRIES = 50;
const DEFAULT_DRAWER_SIZE = 920;
const MIN_DRAWER_SIZE = 520;
const MAX_DRAWER_SIZE = 1800;
const DRAWER_LINE_SCROLL_PX = 40;
const CONTEXT_OPTIONS = [3, 10, 30].map((value) => ({
  value,
  label: `Context ${value}`,
}));
const CARD_BORDER_COLOR = "#d9d9d9";
const CARD_SHADOW = "0 1px 2px rgba(0,0,0,0.06)";
const DIFF_FILE_HEADER_BACKGROUND = COLORS.GRAY_LLL;
const DIFF_FILE_HEADER_BORDER = COLORS.GRAY_LL;
const DIFF_FILE_HEADER_TEXT = COLORS.GRAY_D;
const DIFF_FILE_HEADER_SECONDARY = COLORS.GRAY_M;
const DELETE_ALL_REVIEWS_CONFIRM_TEXT = "delete all";
const EMPTY_GIT_REVIEW_COMMENTS: GitReviewCommentV2[] = [];
const INITIAL_RENDERED_DIFF_LINES = 300;
const RENDERED_DIFF_LINES_INCREMENT = 200;

export function getCommitReviewIndicatorState(
  reviewedByCommit: Record<string, boolean>,
  hash: string,
): { reviewed: boolean; known: boolean } {
  const known = Object.prototype.hasOwnProperty.call(reviewedByCommit, hash);
  return {
    reviewed: known ? Boolean(reviewedByCommit[hash]) : false,
    known,
  };
}

export type GitDrawerScrollCommand =
  | "lineDown"
  | "lineUp"
  | "pageDown"
  | "pageUp"
  | "top";

export function matchGitDrawerScrollCommand(
  evt: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >,
): GitDrawerScrollCommand | undefined {
  if (evt.altKey || evt.ctrlKey || evt.metaKey) return;
  switch (evt.key) {
    case "ArrowDown":
      return "lineDown";
    case "ArrowUp":
      return "lineUp";
    case "PageDown":
      return "pageDown";
    case "PageUp":
      return "pageUp";
    case "Home":
      return "top";
    case " ":
    case "Spacebar":
      return evt.shiftKey ? "pageUp" : "pageDown";
    default:
      return;
  }
}

export function runGitDrawerScrollCommand(
  node: Pick<HTMLDivElement, "scrollTop" | "scrollHeight" | "clientHeight">,
  command: GitDrawerScrollCommand,
): boolean {
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  const pageStep = Math.max(
    DRAWER_LINE_SCROLL_PX,
    Math.round(node.clientHeight * 0.9),
  );
  const current = node.scrollTop;
  let next = current;
  switch (command) {
    case "lineDown":
      next += DRAWER_LINE_SCROLL_PX;
      break;
    case "lineUp":
      next -= DRAWER_LINE_SCROLL_PX;
      break;
    case "pageDown":
      next += pageStep;
      break;
    case "pageUp":
      next -= pageStep;
      break;
    case "top":
      next = 0;
      break;
  }
  const clamped = Math.max(0, Math.min(maxTop, next));
  if (clamped === current) {
    return false;
  }
  node.scrollTop = clamped;
  return true;
}

type GitDiffScrollAnchor = {
  anchorId?: string;
  hunkHash?: string;
  offsetTop: number;
};

function getGitDiffAnchorElements(
  node: Pick<HTMLDivElement, "querySelectorAll">,
): HTMLElement[] {
  return Array.from(
    node.querySelectorAll<HTMLElement>(
      "[data-git-anchor-id],[data-git-hunk-hash]",
    ),
  );
}

export function captureGitDiffScrollAnchor(
  node: Pick<
    HTMLDivElement,
    "querySelectorAll" | "getBoundingClientRect" | "clientHeight"
  >,
): GitDiffScrollAnchor | undefined {
  const elements = getGitDiffAnchorElements(node);
  if (!elements.length) return undefined;
  const containerRect = node.getBoundingClientRect();
  const midpoint = containerRect.top + node.clientHeight / 2;
  const visible = elements.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
  });
  const candidates = visible.length ? visible : elements;
  let best: HTMLElement | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    const distance = Math.abs(rect.top - midpoint);
    if (distance < bestDistance) {
      best = element;
      bestDistance = distance;
    }
  }
  if (!best) return undefined;
  const rect = best.getBoundingClientRect();
  return {
    anchorId: best.dataset.gitAnchorId || undefined,
    hunkHash: best.dataset.gitHunkHash || undefined,
    offsetTop: rect.top - containerRect.top,
  };
}

export function restoreGitDiffScrollAnchor(
  node: Pick<
    HTMLDivElement,
    | "scrollTop"
    | "scrollHeight"
    | "clientHeight"
    | "querySelectorAll"
    | "getBoundingClientRect"
  >,
  anchor?: GitDiffScrollAnchor | null,
): boolean {
  if (!anchor) return false;
  const elements = getGitDiffAnchorElements(node);
  if (!elements.length) return false;
  let target =
    elements.find(
      (element) =>
        !!anchor.anchorId && element.dataset.gitAnchorId === anchor.anchorId,
    ) ??
    elements.find(
      (element) =>
        !!anchor.hunkHash && element.dataset.gitHunkHash === anchor.hunkHash,
    );
  if (!target) return false;
  const containerRect = node.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const rawTop =
    node.scrollTop + (targetRect.top - containerRect.top) - anchor.offsetTop;
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  node.scrollTop = Math.max(0, Math.min(maxTop, rawTop));
  return true;
}

export function scrollGitDrawerElementIntoView(
  node: Pick<
    HTMLDivElement,
    "scrollTop" | "scrollHeight" | "clientHeight" | "getBoundingClientRect"
  >,
  target: Pick<HTMLElement, "getBoundingClientRect">,
  opts: {
    block: "start" | "center";
    offsetTop?: number;
  },
): boolean {
  const containerRect = node.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  let rawTop =
    node.scrollTop +
    (targetRect.top - containerRect.top) -
    Math.max(0, opts.offsetTop ?? 0);
  if (opts.block === "center") {
    rawTop =
      node.scrollTop +
      (targetRect.top - containerRect.top) -
      Math.max(0, (node.clientHeight - targetRect.height) / 2);
  }
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  const nextTop = Math.max(0, Math.min(maxTop, rawTop));
  if (Math.abs(nextTop - node.scrollTop) < 1) {
    return false;
  }
  node.scrollTop = nextTop;
  return true;
}

type GitShowFile = {
  path: string;
  lines: string[];
};

type GitShowSummary = {
  commit?: string;
  author?: string;
  authorDate?: string;
  committer?: string;
  commitDate?: string;
  message: string;
  extraHeaderLines: string[];
};

type GitShowParsed = {
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

export function buildGitReviewFileSectionId(
  path: string,
  index: number,
): string {
  return `git-review-file-${index}-${hashString(path).slice(0, 12)}`;
}

export function buildGitReviewLineElementId({
  filePath,
  fileIndex,
  lineIndex,
}: {
  filePath: string;
  fileIndex: number;
  lineIndex: number;
}): string {
  return `git-review-line-${fileIndex}-${lineIndex}-${hashString(filePath).slice(0, 12)}`;
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

type GitLogEntry = {
  hash: string;
  subject: string;
};

export function filterGitReviewLogEntries({
  entries,
  reviewedByCommit,
  onlyUnreviewed,
}: {
  entries: GitLogEntry[];
  reviewedByCommit: Record<string, boolean>;
  onlyUnreviewed: boolean;
}): GitLogEntry[] {
  if (!onlyUnreviewed) return entries;
  return entries.filter((entry) => reviewedByCommit[entry.hash] !== true);
}

export function resolveGitCommitSearchChange({
  currentSearch,
  nextSearch,
  preserveSearchOnAutoClear,
}: {
  currentSearch: string;
  nextSearch: string;
  preserveSearchOnAutoClear: boolean;
}): {
  search: string;
  preserveSearchOnAutoClear: boolean;
} {
  if (preserveSearchOnAutoClear && nextSearch === "") {
    return {
      search: currentSearch,
      preserveSearchOnAutoClear: false,
    };
  }
  return {
    search: nextSearch,
    preserveSearchOnAutoClear: false,
  };
}

export function resolveGitReviewSaveState({
  next = {},
  draft,
  reviewed,
  reviewNote,
  reviewNoteDraft,
  reviewComments,
}: {
  next?: Partial<Pick<GitReviewRecordV2, "reviewed" | "note" | "comments">>;
  draft?: {
    reviewed: boolean;
    note: string;
    comments?: Record<string, GitReviewCommentV2>;
  };
  reviewed: boolean;
  reviewNote: string;
  reviewNoteDraft: string;
  reviewComments?: Record<string, GitReviewCommentV2>;
}): {
  reviewed: boolean;
  note: string;
  comments: Record<string, GitReviewCommentV2>;
} {
  const draftComments = draft?.comments;
  return {
    reviewed: next.reviewed ?? draft?.reviewed ?? reviewed,
    note: next.note ?? draft?.note ?? reviewNoteDraft ?? reviewNote,
    comments:
      next.comments ??
      (draftComments && Object.keys(draftComments).length > 0
        ? draftComments
        : (reviewComments ?? {})),
  };
}

export function resolveGitReviewSaveCompletion({
  payload,
  sent,
  current,
}: {
  payload: Pick<GitReviewRecordV2, "reviewed" | "note">;
  sent: {
    reviewed: boolean;
    note: string;
  };
  current: {
    reviewed: boolean;
    noteDraft: string;
  };
}): {
  reviewed: boolean;
  reviewNote: string;
  reviewNoteDraft: string;
  reviewDirty: boolean;
} {
  const reviewedChangedSinceSave = current.reviewed !== sent.reviewed;
  const noteChangedSinceSave = current.noteDraft !== sent.note;
  return {
    reviewed: reviewedChangedSinceSave ? current.reviewed : payload.reviewed,
    reviewNote: payload.note,
    reviewNoteDraft: noteChangedSinceSave ? current.noteDraft : payload.note,
    reviewDirty: reviewedChangedSinceSave || noteChangedSinceSave,
  };
}

interface GitCommitDrawerProps {
  projectId?: string;
  sourcePath?: string;
  cwdOverride?: string;
  commitHash?: string;
  open: boolean;
  onClose: () => void;
  fontSize?: number;
  onRequestAgentTurn?: (prompt: string) => void | Promise<void>;
  onDirectCommitLogged?: (info: {
    hash: string;
    subject: string;
  }) => void | Promise<void>;
  onFindInChat?: (query: string) => void | Promise<void>;
  onOpenActivityLog?: () => void;
}

type HeadStatusEntry = {
  path: string;
  displayPath: string;
  statusCode: string;
  statusLabel: string;
  tracked: boolean;
};

type DiffLineMeta = {
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

type CommentAnchor = {
  filePath: string;
  side: GitReviewCommentSide;
  line: number;
  hunk_header?: string;
  hunk_hash?: string;
  snippet?: string;
};

type DrawerScrollState = {
  entries: Record<string, { top: number; updated_at: number }>;
  order: string[];
};

function parseCommitHash(commitHash?: string): string | undefined {
  const trimmed = `${commitHash ?? ""}`.trim();
  if (!trimmed) return undefined;
  if (trimmed.toUpperCase() === HEAD_REF) return HEAD_REF;
  if (!COMMIT_HASH_RE.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

function isHeadCommit(commit?: string): boolean {
  return `${commit ?? ""}`.toUpperCase() === HEAD_REF;
}

async function runGitCommand({
  projectId,
  cwd,
  args,
}: {
  projectId: string;
  cwd: string;
  args: string[];
}) {
  return await webapp_client.project_client.exec({
    project_id: projectId,
    path: cwd,
    command: "git",
    args,
    err_on_exit: false,
    max_output: MAX_GIT_SHOW_OUTPUT_BYTES,
    timeout: 60,
  });
}

export function buildGitShowArgs({
  isHeadSelected,
  contextLines,
  commit,
}: {
  isHeadSelected: boolean;
  contextLines: number;
  commit?: string;
}): string[] {
  if (isHeadSelected) {
    return [
      "-c",
      "core.pager=cat",
      "diff",
      "--no-color",
      "--patch",
      `-U${contextLines}`,
      "HEAD",
    ];
  }
  return [
    "-c",
    "core.pager=cat",
    "show",
    "--no-color",
    "--patch",
    `-U${contextLines}`,
    "--format=fuller",
    `${commit ?? ""}`,
  ];
}

export function buildGitLogArgs(): string[] {
  return [
    "log",
    "--no-merges",
    `-n${GIT_LOG_FETCH_COUNT}`,
    "--format=%H%x09%s",
    "--date-order",
  ];
}

function parseGitShowOutput(stdout: string, repoRoot?: string): GitShowParsed {
  const allLines = `${stdout ?? ""}`.split(/\r?\n/);
  const linesTruncated = allLines.length > MAX_GIT_SHOW_LINES;
  const lines = linesTruncated
    ? allLines.slice(0, MAX_GIT_SHOW_LINES)
    : allLines;
  const files: GitShowFile[] = [];
  const summaryLines: string[] = [];
  let currentFile: GitShowFile | undefined;

  const pushCurrent = () => {
    if (!currentFile) return;
    files.push(currentFile);
    currentFile = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushCurrent();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const path = `${match?.[2] ?? match?.[1] ?? "unknown"}`.trim();
      currentFile = { path, lines: [line] };
      continue;
    }
    if (currentFile) {
      currentFile.lines.push(line);
    } else {
      summaryLines.push(line);
    }
  }
  pushCurrent();

  return {
    summaryLines,
    summary: parseGitShowSummary(summaryLines),
    files,
    repoRoot,
    linesTruncated,
    originalLineCount: allLines.length,
    shownLineCount: lines.length,
  };
}

function parseGitShowSummary(summaryLines: string[]): GitShowSummary {
  const parsed: GitShowSummary = {
    message: "",
    extraHeaderLines: [],
  };
  const messageLines: string[] = [];
  let inMessage = false;
  for (const line of summaryLines) {
    if (inMessage) {
      if (line.startsWith("    ")) {
        messageLines.push(line.slice(4));
      } else {
        messageLines.push(line);
      }
      continue;
    }
    const commitMatch = /^commit\s+([0-9a-f]{7,40})/i.exec(line);
    if (commitMatch) {
      parsed.commit = `${commitMatch[1]}`.toLowerCase();
      continue;
    }
    const authorMatch = /^Author:\s*(.+)$/i.exec(line);
    if (authorMatch) {
      parsed.author = `${authorMatch[1]}`.trim();
      continue;
    }
    const authorDateMatch = /^AuthorDate:\s*(.+)$/i.exec(line);
    if (authorDateMatch) {
      parsed.authorDate = `${authorDateMatch[1]}`.trim();
      continue;
    }
    const committerMatch = /^Commit:\s*(.+)$/i.exec(line);
    if (committerMatch) {
      parsed.committer = `${committerMatch[1]}`.trim();
      continue;
    }
    const commitDateMatch = /^CommitDate:\s*(.+)$/i.exec(line);
    if (commitDateMatch) {
      parsed.commitDate = `${commitDateMatch[1]}`.trim();
      continue;
    }
    const legacyDateMatch = /^Date:\s*(.+)$/i.exec(line);
    if (legacyDateMatch && !parsed.authorDate) {
      parsed.authorDate = `${legacyDateMatch[1]}`.trim();
      continue;
    }
    if (line.trim() === "") {
      if (
        parsed.commit ||
        parsed.author ||
        parsed.authorDate ||
        parsed.committer ||
        parsed.commitDate
      ) {
        inMessage = true;
      }
      continue;
    }
    parsed.extraHeaderLines.push(line);
  }
  parsed.message = messageLines.join("\n").trimEnd();
  return parsed;
}

function parseGitLogOutput(stdout: string): GitLogEntry[] {
  const lines = `${stdout ?? ""}`
    .split(/\r?\n/)
    .filter((line) => line.trim().length);
  const entries: GitLogEntry[] = [];
  for (const line of lines) {
    const [hash, ...subjectParts] = line.split("\t");
    const normalizedHash = `${hash ?? ""}`.trim().toLowerCase();
    if (!COMMIT_HASH_RE.test(normalizedHash)) continue;
    entries.push({
      hash: normalizedHash,
      subject: subjectParts.join("\t").trim(),
    });
  }
  return entries;
}

function parseGitStatusOutput(stdout: string): HeadStatusEntry[] {
  const lines = `${stdout ?? ""}`
    .split(/\r?\n/)
    .filter((line) => line.trim().length);
  const entries: HeadStatusEntry[] = [];
  for (const line of lines) {
    if (line.startsWith("##")) continue;
    if (line.length < 3) continue;
    const status = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const displayPath = rawPath.includes(" -> ")
      ? rawPath.split(" -> ").pop()?.trim() || rawPath
      : rawPath;
    const primary = status.replace(/\s/g, "")[0] ?? "?";
    const statusCode = status.trim() || "??";
    const tracked = status !== "??";
    const statusLabel =
      status === "??"
        ? "untracked"
        : primary === "A"
          ? "added"
          : primary === "D"
            ? "deleted"
            : primary === "R"
              ? "renamed"
              : primary === "M"
                ? "modified"
                : "changed";
    entries.push({
      path: displayPath,
      displayPath,
      statusCode,
      statusLabel,
      tracked,
    });
  }
  return entries;
}

function clampDrawerSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_DRAWER_SIZE;
  return Math.max(MIN_DRAWER_SIZE, Math.min(MAX_DRAWER_SIZE, Math.round(size)));
}

function readDrawerSize(): number {
  try {
    const raw = localStorage.getItem(DRAWER_SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_DRAWER_SIZE;
    const parsed = Number(raw);
    return clampDrawerSize(parsed);
  } catch {
    return DEFAULT_DRAWER_SIZE;
  }
}

function persistDrawerSize(size: number): void {
  try {
    localStorage.setItem(
      DRAWER_SIZE_STORAGE_KEY,
      String(clampDrawerSize(size)),
    );
  } catch {
    // ignore
  }
}

function normalizeDrawerScrollState(raw: unknown): DrawerScrollState {
  const fallback: DrawerScrollState = { entries: {}, order: [] };
  if (!raw || typeof raw !== "object") return fallback;
  const record = raw as Record<string, unknown>;
  const entriesRaw = record.entries;
  const orderRaw = record.order;
  const entries: DrawerScrollState["entries"] = {};
  if (entriesRaw && typeof entriesRaw === "object") {
    for (const [key, value] of Object.entries(
      entriesRaw as Record<string, unknown>,
    )) {
      if (!key || !value || typeof value !== "object") continue;
      const top = Number((value as Record<string, unknown>).top);
      const updated = Number((value as Record<string, unknown>).updated_at);
      if (!Number.isFinite(top) || top < 0) continue;
      entries[key] = {
        top: Math.round(top),
        updated_at:
          Number.isFinite(updated) && updated > 0
            ? Math.round(updated)
            : Date.now(),
      };
    }
  }
  const order = Array.isArray(orderRaw)
    ? orderRaw
        .map((x) => `${x ?? ""}`.trim())
        .filter(
          (x, i, arr) => !!x && arr.indexOf(x) === i && entries[x] != null,
        )
    : [];
  for (const key of Object.keys(entries)) {
    if (!order.includes(key)) order.push(key);
  }
  return { entries, order };
}

function readDrawerScrollState(): DrawerScrollState {
  try {
    const raw = localStorage.getItem(DRAWER_SCROLL_STORAGE_KEY);
    if (!raw) return { entries: {}, order: [] };
    return normalizeDrawerScrollState(JSON.parse(raw));
  } catch {
    return { entries: {}, order: [] };
  }
}

function persistDrawerScrollState(state: DrawerScrollState): void {
  try {
    localStorage.setItem(DRAWER_SCROLL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function readDrawerScrollPosition(storageId: string): number | undefined {
  if (!storageId) return undefined;
  const entry = readDrawerScrollState().entries[storageId];
  if (!entry) return undefined;
  if (!Number.isFinite(entry.top) || entry.top < 0) return undefined;
  return entry.top;
}

function persistDrawerScrollPosition(storageId: string, top: number): void {
  if (!storageId) return;
  if (!Number.isFinite(top) || top < 0) return;
  const state = readDrawerScrollState();
  const id = `${storageId}`.trim();
  if (!id) return;
  const now = Date.now();
  state.entries[id] = { top: Math.round(top), updated_at: now };
  const order = state.order.filter((x) => x !== id);
  order.push(id);
  while (order.length > MAX_DRAWER_SCROLL_ENTRIES) {
    const drop = order.shift();
    if (!drop) continue;
    delete state.entries[drop];
  }
  state.order = order;
  persistDrawerScrollState(state);
}

function resolveOpenPath(
  repoRoot: string | undefined,
  filePath: string,
): string {
  if (!filePath) return filePath;
  if (filePath.startsWith("/")) return filePath;
  if (!repoRoot) return filePath;
  const prefix = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  return `${prefix}/${filePath}`.replace(/\/+/g, "/");
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

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

function buildDiffLineMetas(lines: string[]): DiffLineMeta[] {
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
      hunkHash = hashString(line);
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

function makeCommentAnchor(
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

function makeCommentId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `gitc-${Date.now().toString(36)}-${rand}`;
}

export function diffLineNumberColumnWidth(maxLine: number): string {
  const safeMaxLine = Math.max(0, Math.floor(maxLine || 0));
  const digits = Math.max(1, `${safeMaxLine}`.length);
  const chars = Math.max(3, digits);
  return `calc(${chars}ch + 12px)`;
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(
    target.closest(
      [
        '[contenteditable="true"]',
        '[data-slate-editor="true"]',
        ".slate-editor",
        ".CodeMirror",
        ".CodeMirror-code",
        ".cm-editor",
        ".cm-content",
        '[role="textbox"]',
      ].join(", "),
    ),
  );
}

export function shouldCaptureGitDrawerFindShortcut({
  key,
  altKey,
  ctrlKey,
  metaKey,
  target,
  activeElement,
}: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "target"> & {
  activeElement?: EventTarget | null;
}): boolean {
  if (!(metaKey || ctrlKey) || altKey) return false;
  if (`${key ?? ""}`.toLowerCase() !== "f") return false;
  if (
    isEditableEventTarget(target ?? null) ||
    isEditableEventTarget(activeElement ?? null)
  ) {
    return false;
  }
  return true;
}

function isNotGitRepoError(message: string): boolean {
  const text = `${message ?? ""}`.toLowerCase();
  return (
    text.includes("not a git repository") ||
    text.includes("stopping at filesystem boundary")
  );
}

function parseDateSafe(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isFinite(d.valueOf()) ? d : undefined;
}

function splitCommitMessage(message?: string): {
  subject?: string;
  body?: string;
} {
  const raw = `${message ?? ""}`.replace(/\r\n/g, "\n");
  if (!raw.trim()) return {};
  const lines = raw.split("\n");
  const subject = `${lines[0] ?? ""}`.trim();
  const body = lines.slice(1).join("\n").replace(/^\n+/, "");
  return {
    subject: subject || undefined,
    body: body.trim() ? body : undefined,
  };
}

export function isMergeCommitSummary(summary?: GitShowSummary): boolean {
  return (
    summary?.extraHeaderLines?.some((line) =>
      /^Merge:\s+/i.test(`${line ?? ""}`),
    ) ?? false
  );
}

export function formatMergeCommitBodyMarkdown(
  body?: string,
): string | undefined {
  const text = `${body ?? ""}`.trim();
  if (!text) return undefined;
  const fence = backtickSequence(text);
  return `${fence}\n${text}\n${fence}`;
}

type MarkdownHistoryInputProps = ComponentProps<typeof MarkdownInput> & {
  historyId: string;
};

export function MarkdownHistoryInput({
  historyId: _historyId,
  saveDebounceMs = 0,
  ...props
}: MarkdownHistoryInputProps) {
  return (
    <MarkdownInput
      {...props}
      saveDebounceMs={saveDebounceMs}
      // Git review editors need immediate parent sync so local undo/redo never
      // races against a stale debounced value flush, and undo/redo should stay
      // local to the embedded editor in both backends.
      undoMode="local"
      redoMode="local"
    />
  );
}

function useBufferedMarkdownValue({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [localValue, setLocalValue] = useState(value);
  const localValueRef = useRef(localValue);
  const syncedValueRef = useRef(value);
  const skipUnmountFlushRef = useRef(false);
  const skipNextBlurFlushRef = useRef(false);
  const pendingActionBlurRecoveryRef = useRef(false);

  useEffect(() => {
    localValueRef.current = localValue;
  }, [localValue]);

  useEffect(() => {
    setLocalValue(value);
    localValueRef.current = value;
    syncedValueRef.current = value;
    skipUnmountFlushRef.current = false;
    skipNextBlurFlushRef.current = false;
    pendingActionBlurRecoveryRef.current = false;
  }, [value]);

  const flush = useCallback(
    (nextValue?: string, opts?: { force?: boolean }) => {
      if (!opts?.force && skipNextBlurFlushRef.current) {
        skipNextBlurFlushRef.current = false;
        return;
      }
      pendingActionBlurRecoveryRef.current = false;
      const resolved = nextValue ?? localValueRef.current;
      if (resolved === syncedValueRef.current) return;
      syncedValueRef.current = resolved;
      onChange(resolved);
    },
    [onChange],
  );

  useEffect(() => {
    return () => {
      if (!skipUnmountFlushRef.current) {
        flush();
      }
    };
  }, [flush]);

  const update = useCallback((nextValue: string) => {
    localValueRef.current = nextValue;
    setLocalValue(nextValue);
  }, []);

  const skipNextUnmountFlush = useCallback(() => {
    skipUnmountFlushRef.current = true;
  }, []);

  const prepareForActionFocus = useCallback(() => {
    skipNextBlurFlushRef.current = true;
    pendingActionBlurRecoveryRef.current = true;
  }, []);

  const markActionHandled = useCallback(() => {
    pendingActionBlurRecoveryRef.current = false;
  }, []);

  const recoverPendingActionBlur = useCallback(() => {
    if (!pendingActionBlurRecoveryRef.current) return;
    pendingActionBlurRecoveryRef.current = false;
    skipNextBlurFlushRef.current = false;
    flush(undefined, { force: true });
  }, [flush]);

  return {
    localValue,
    update,
    flush,
    skipNextUnmountFlush,
    prepareForActionFocus,
    markActionHandled,
    recoverPendingActionBlur,
  };
}

export function ReviewNoteEditor({
  historyId,
  value,
  committedValue,
  fontSize,
  saving,
  disabled,
  onPersistDraft,
  onCancel,
  onSave,
}: {
  historyId: string;
  value: string;
  committedValue: string;
  fontSize: number;
  saving: boolean;
  disabled: boolean;
  onPersistDraft: (value: string) => void;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const {
    localValue,
    update,
    flush,
    skipNextUnmountFlush,
    prepareForActionFocus,
    markActionHandled,
    recoverPendingActionBlur,
  } = useBufferedMarkdownValue({
    value,
    onChange: onPersistDraft,
  });
  const dirty = localValue !== committedValue;
  return (
    <>
      <MarkdownHistoryInput
        historyId={historyId}
        cacheId={historyId}
        value={localValue}
        onChange={update}
        onBlur={flush}
        onShiftEnter={(next) => {
          skipNextUnmountFlush();
          flush(next, { force: true });
          onSave(next);
        }}
        placeholder="Private review note (not sent to agent)"
        fontSize={Math.max(13, fontSize)}
        autoGrow
        autoGrowMaxHeight={220}
        hideHelp
        minimal
        compact
        enableMentions={false}
        enableUpload={true}
      />
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Button
          size="small"
          disabled={disabled}
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button
          size="small"
          type="primary"
          disabled={!dirty || saving || disabled}
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            flush(localValue, { force: true });
            onSave(localValue);
          }}
        >
          Save note
        </Button>
      </div>
    </>
  );
}

function InlineDraftCommentEditor({
  filePath,
  anchorId,
  value,
  fontSize,
  loading,
  onChange,
  onCancel,
  onSave,
}: {
  filePath: string;
  anchorId: string;
  value: string;
  fontSize: number;
  loading: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const {
    localValue,
    update,
    flush,
    skipNextUnmountFlush,
    prepareForActionFocus,
    markActionHandled,
    recoverPendingActionBlur,
  } = useBufferedMarkdownValue({
    value,
    onChange,
  });
  return (
    <>
      <MarkdownHistoryInput
        historyId={`git-inline-draft:${filePath}:${anchorId}`}
        cacheId={`git-inline-draft:${filePath}:${anchorId}`}
        value={localValue}
        onChange={update}
        onBlur={flush}
        onShiftEnter={(next) => {
          skipNextUnmountFlush();
          flush(next);
          onSave(next);
        }}
        placeholder="Add inline review comment..."
        fontSize={fontSize}
        autoGrow
        autoGrowMaxHeight={220}
        hideHelp
        minimal
        compact
        enableMentions={false}
        enableUpload={true}
      />
      <div
        style={{
          marginTop: 6,
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        <Button
          size="small"
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button
          size="small"
          type="primary"
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            flush(localValue, { force: true });
            onSave(localValue);
          }}
          disabled={!localValue.trim()}
          loading={loading}
        >
          Add comment
        </Button>
      </div>
    </>
  );
}

function InlineEditCommentEditor({
  filePath,
  commentId,
  value,
  fontSize,
  loading,
  onChange,
  onCancel,
  onSave,
}: {
  filePath: string;
  commentId: string;
  value: string;
  fontSize: number;
  loading: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const {
    localValue,
    update,
    flush,
    skipNextUnmountFlush,
    prepareForActionFocus,
    markActionHandled,
    recoverPendingActionBlur,
  } = useBufferedMarkdownValue({
    value,
    onChange,
  });
  return (
    <>
      <MarkdownHistoryInput
        historyId={`git-inline-edit:${filePath}:${commentId}`}
        cacheId={`git-inline-edit:${filePath}:${commentId}`}
        value={localValue}
        onChange={update}
        onBlur={flush}
        onShiftEnter={(next) => {
          skipNextUnmountFlush();
          flush(next);
          onSave(next);
        }}
        placeholder="Edit inline review comment..."
        fontSize={fontSize}
        autoGrow
        autoGrowMaxHeight={220}
        hideHelp
        minimal
        compact
        enableMentions={false}
        enableUpload={true}
      />
      <Space.Compact size="small">
        <Button
          size="small"
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            onCancel();
          }}
        >
          Cancel
        </Button>
        <Button
          size="small"
          type="primary"
          onMouseDown={prepareForActionFocus}
          onFocus={prepareForActionFocus}
          onBlur={recoverPendingActionBlur}
          onClick={() => {
            markActionHandled();
            skipNextUnmountFlush();
            flush(localValue, { force: true });
            onSave(localValue);
          }}
          disabled={!localValue.trim()}
          loading={loading}
        >
          Save
        </Button>
      </Space.Compact>
    </>
  );
}

export const DiffBlock = memo(function DiffBlock({
  filePath,
  fileIndex,
  lines,
  languageHint,
  fontSize,
  editorTheme,
  comments,
  showResolvedComments,
  commentEnabled,
  commentDisabledMessage,
  activeDraftAnchorId,
  activeDraftBody = "",
  activeEditingId,
  activeEditingBody = "",
  pendingKey = "",
  onOpenDraft = () => {},
  onDraftBodyChange = () => {},
  onCancelDraft = () => {},
  onOpenEdit = () => {},
  onEditingBodyChange = () => {},
  onCancelEdit = () => {},
  onCreateComment,
  onUpdateComment,
  onResolveComment,
  onReopenComment,
  matchedLineIndexes,
  activeMatchedLineIndex,
}: {
  filePath: string;
  fileIndex?: number;
  lines: string[];
  languageHint: string;
  fontSize: number;
  editorTheme?: string | null;
  comments: GitReviewCommentV2[];
  showResolvedComments: boolean;
  commentEnabled: boolean;
  commentDisabledMessage?: string;
  activeDraftAnchorId?: string;
  activeDraftBody?: string;
  activeEditingId?: string;
  activeEditingBody?: string;
  pendingKey?: string;
  onOpenDraft?: (anchor: CommentAnchor) => void;
  onDraftBodyChange?: (value: string) => void;
  onCancelDraft?: () => void;
  onOpenEdit?: (comment: GitReviewCommentV2) => void;
  onEditingBodyChange?: (value: string) => void;
  onCancelEdit?: () => void;
  onCreateComment: (anchor: CommentAnchor, body: string) => Promise<void>;
  onUpdateComment: (id: string, body: string) => Promise<void>;
  onResolveComment: (id: string) => Promise<void>;
  onReopenComment: (id: string) => Promise<void>;
  matchedLineIndexes?: Set<number>;
  activeMatchedLineIndex?: number;
}) {
  const codeFontSize = Math.max(11, fontSize - 1);
  const commentFontSize = Math.max(13, fontSize);
  const commentFontFamily =
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const lineMetas = useMemo(() => buildDiffLineMetas(lines), [lines]);
  const lineNumberWidth = useMemo(() => {
    const maxLine = lineMetas.reduce((max, meta) => {
      const oldVal =
        typeof meta.oldLineNumber === "number" ? meta.oldLineNumber : 0;
      const newVal =
        typeof meta.newLineNumber === "number" ? meta.newLineNumber : 0;
      return Math.max(max, oldVal, newVal);
    }, 0);
    return diffLineNumberColumnWidth(maxLine);
  }, [lineMetas]);
  const highlightedByLine = useMemo(
    () => highlightPrismLines(lineMetas, languageHint),
    [lineMetas, languageHint],
  );
  const commentsByAnchor = useMemo(() => {
    const byAnchor = new Map<string, GitReviewCommentV2[]>();
    for (const comment of comments) {
      if (comment.status === "resolved" && !showResolvedComments) continue;
      const key = commentAnchorKey(comment);
      const existing = byAnchor.get(key) ?? [];
      existing.push(comment);
      byAnchor.set(key, existing);
    }
    return byAnchor;
  }, [comments, showResolvedComments]);
  const commentButtonSlotStyle = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    minWidth: 22,
    height: 22,
  } as const;

  const resolveComment = async (id: string) => {
    await onResolveComment(id);
  };

  const reopenComment = async (id: string) => {
    await onReopenComment(id);
  };

  return (
    <div
      className="cocalc-slate-code-block"
      style={{
        border: `1px solid ${COLORS.GRAY_L}`,
        borderRadius: 6,
        overflow: "hidden",
        fontFamily: "monospace",
        fontSize: codeFontSize,
        padding: 0,
        marginBottom: 0,
      }}
    >
      {lineMetas.map((meta, idx) => {
        const prefix = meta.raw[0];
        const background =
          prefix === "+" && !meta.raw.startsWith("+++ ")
            ? "#e6ffed"
            : prefix === "-" && !meta.raw.startsWith("--- ")
              ? "#ffeef0"
              : "transparent";
        const html = highlightedByLine[idx] ?? "";
        const anchor = makeCommentAnchor(meta, filePath);
        const anchorId = anchor == null ? "" : commentAnchorKey(anchor);
        const lineElementId = buildGitReviewLineElementId({
          filePath,
          fileIndex: fileIndex ?? 0,
          lineIndex: idx,
        });
        const lineComments =
          anchor == null ? [] : (commentsByAnchor.get(anchorId) ?? []);
        const showDraft =
          activeDraftAnchorId != null &&
          activeDraftAnchorId !== "" &&
          activeDraftAnchorId === anchorId;
        const hasFindMatch = matchedLineIndexes?.has(idx) ?? false;
        const isActiveFindMatch = activeMatchedLineIndex === idx;
        return (
          <div key={idx}>
            <div
              id={lineElementId}
              className="cocalc-git-diff-line"
              style={{
                background,
                padding: "2px 8px",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                boxShadow: isActiveFindMatch
                  ? "inset 0 0 0 2px #faad14"
                  : hasFindMatch
                    ? "inset 0 0 0 1px #ffe58f"
                    : undefined,
              }}
              data-git-anchor-id={anchorId || undefined}
              data-git-hunk-hash={meta.hunkHash || undefined}
            >
              <div
                style={{
                  color: COLORS.GRAY_D,
                  width: lineNumberWidth,
                  minWidth: lineNumberWidth,
                  maxWidth: lineNumberWidth,
                  textAlign: "right",
                  userSelect: "none",
                  fontFamily: "monospace",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {meta.oldLineNumber ?? ""}
              </div>
              <div
                style={{
                  color: COLORS.GRAY_D,
                  width: lineNumberWidth,
                  minWidth: lineNumberWidth,
                  maxWidth: lineNumberWidth,
                  textAlign: "right",
                  userSelect: "none",
                  fontFamily: "monospace",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {meta.newLineNumber ?? ""}
              </div>
              {anchor ? (
                <span
                  style={commentButtonSlotStyle}
                  className="cocalc-git-diff-line-comment-slot"
                >
                  <Button
                    size="small"
                    type="primary"
                    className="cocalc-git-diff-line-comment-button"
                    style={{
                      padding: 0,
                      minWidth: 22,
                      width: 22,
                      height: 22,
                    }}
                    onClick={() => {
                      if (!commentEnabled) {
                        alert_message({
                          type: "info",
                          message:
                            commentDisabledMessage ??
                            "Please commit first, then comment.",
                          timeout: 4,
                        });
                        return;
                      }
                      onOpenDraft(anchor);
                    }}
                    title={
                      commentEnabled
                        ? "Add inline comment"
                        : (commentDisabledMessage ??
                          "Please commit first, then comment.")
                    }
                  >
                    +
                  </Button>
                </span>
              ) : (
                <span style={commentButtonSlotStyle} />
              )}
              <div
                className="cocalc-git-diff-line-text"
                style={{ flex: 1 }}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
            {lineComments.length > 0
              ? lineComments.map((comment) => {
                  const isEditing = activeEditingId === comment.id;
                  return (
                    <div
                      key={comment.id}
                      style={{
                        margin: "0 8px 6px 92px",
                        border: `1px solid #d9d9d9`,
                        borderLeft: `4px solid ${COLORS.BLUE}`,
                        borderRadius: 8,
                        padding: "10px 12px",
                        background: "#fff",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                        fontFamily: commentFontFamily,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          marginBottom: 8,
                        }}
                      >
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          Inline review comment
                        </Typography.Text>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 11 }}
                        >
                          {comment.side}:{comment.line ?? "?"}
                        </Typography.Text>
                      </div>
                      {isEditing ? (
                        <InlineEditCommentEditor
                          key={comment.id}
                          filePath={filePath}
                          commentId={comment.id}
                          value={activeEditingBody}
                          fontSize={commentFontSize}
                          loading={pendingKey === `edit:${comment.id}`}
                          onChange={onEditingBodyChange}
                          onCancel={onCancelEdit}
                          onSave={(value) =>
                            void onUpdateComment(comment.id, value)
                          }
                        />
                      ) : (
                        <StaticMarkdown
                          value={comment.body_md}
                          style={{
                            fontSize: commentFontSize,
                            fontFamily: commentFontFamily,
                            lineHeight: 1.5,
                          }}
                          editorTheme={editorTheme}
                        />
                      )}
                      <div
                        style={{
                          marginTop: 10,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                        }}
                      >
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 11 }}
                        >
                          {comment.status === "resolved"
                            ? "Resolved"
                            : comment.status === "submitted"
                              ? "Submitted"
                              : "Draft"}
                        </Typography.Text>
                        {isEditing ? null : (
                          <Space.Compact size="small">
                            <Button
                              size="small"
                              onClick={() => onOpenEdit(comment)}
                            >
                              Edit
                            </Button>
                            {comment.status === "resolved" ? (
                              <Button
                                size="small"
                                type="primary"
                                onClick={() => void reopenComment(comment.id)}
                                loading={pendingKey === `reopen:${comment.id}`}
                              >
                                Reopen
                              </Button>
                            ) : (
                              <Button
                                size="small"
                                type="primary"
                                onClick={() => void resolveComment(comment.id)}
                                loading={pendingKey === `resolve:${comment.id}`}
                              >
                                Resolve
                              </Button>
                            )}
                          </Space.Compact>
                        )}
                      </div>
                    </div>
                  );
                })
              : null}
            {showDraft ? (
              <div
                style={{
                  margin: "0 8px 8px 92px",
                  border: `1px solid #d9d9d9`,
                  borderLeft: `4px solid ${COLORS.BLUE}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  background: "#fff",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                  fontFamily: commentFontFamily,
                }}
              >
                <Typography.Text strong style={{ fontSize: 13 }}>
                  Add inline review comment
                </Typography.Text>
                <InlineDraftCommentEditor
                  key={anchorId}
                  filePath={filePath}
                  anchorId={anchorId}
                  value={activeDraftBody}
                  fontSize={commentFontSize}
                  loading={pendingKey === `create:${anchorId}`}
                  onChange={onDraftBodyChange}
                  onCancel={onCancelDraft}
                  onSave={(value) => {
                    if (!anchor) return;
                    void onCreateComment(anchor, value);
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

const DiffFileSection = memo(function DiffFileSection({
  file,
  index,
  fontSize,
  editorTheme,
  fileComments,
  showResolvedComments,
  isHeadSelected,
  visibleLineLimit,
  onOpenFile,
  onShowMoreLines,
  activeDraftAnchorId,
  activeDraftBody,
  activeEditingId,
  activeEditingBody,
  pendingKey,
  onOpenDraft,
  onDraftBodyChange,
  onCancelDraft,
  onOpenEdit,
  onEditingBodyChange,
  onCancelEdit,
  onCreateComment,
  onUpdateComment,
  onResolveComment,
  onReopenComment,
  matchedFindCount,
  matchedLineIndexes,
  activeFindMatchKind,
  activeFindLineIndex,
}: {
  file: GitShowFile;
  index: number;
  fontSize: number;
  editorTheme?: string | null;
  fileComments: GitReviewCommentV2[];
  showResolvedComments: boolean;
  isHeadSelected: boolean;
  visibleLineLimit: number;
  onOpenFile: (filePath: string) => Promise<void>;
  onShowMoreLines: (sectionId: string) => void;
  activeDraftAnchorId?: string;
  activeDraftBody: string;
  activeEditingId?: string;
  activeEditingBody: string;
  pendingKey: string;
  onOpenDraft: (anchor: CommentAnchor) => void;
  onDraftBodyChange: (value: string) => void;
  onCancelDraft: () => void;
  onOpenEdit: (comment: GitReviewCommentV2) => void;
  onEditingBodyChange: (value: string) => void;
  onCancelEdit: () => void;
  onCreateComment: (anchor: CommentAnchor, body: string) => Promise<void>;
  onUpdateComment: (id: string, body: string) => Promise<void>;
  onResolveComment: (id: string) => Promise<void>;
  onReopenComment: (id: string) => Promise<void>;
  matchedFindCount: number;
  matchedLineIndexes?: Set<number>;
  activeFindMatchKind?: GitDiffFindMatch["kind"];
  activeFindLineIndex?: number;
}) {
  const languageHint = languageHintFromPath(file.path);
  const sectionId = buildGitReviewFileSectionId(file.path, index);
  const visibleLines = file.lines.slice(0, visibleLineLimit);
  const remainingLineCount = Math.max(
    0,
    file.lines.length - visibleLines.length,
  );
  return (
    <div id={sectionId} style={{ marginBottom: 18 }}>
      <div
        style={{
          position: "sticky",
          top: -16,
          zIndex: 3,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 8,
          padding: "8px 10px",
          border: `1px solid ${
            activeFindMatchKind === "file" ? "#faad14" : DIFF_FILE_HEADER_BORDER
          }`,
          borderRadius: 8,
          background: DIFF_FILE_HEADER_BACKGROUND,
          boxShadow:
            activeFindMatchKind === "file"
              ? "0 0 0 2px rgba(250, 173, 20, 0.18)"
              : "0 1px 3px rgba(0,0,0,0.05)",
        }}
      >
        <Button
          type="link"
          size="small"
          style={{
            padding: 0,
            height: "auto",
            fontFamily: "monospace",
            fontWeight: 700,
            fontSize: Math.max(13, fontSize),
            color: DIFF_FILE_HEADER_TEXT,
          }}
          onClick={() => void onOpenFile(file.path)}
        >
          {file.path}
        </Button>
        <Typography.Text
          style={{
            fontSize: 11,
            color: DIFF_FILE_HEADER_SECONDARY,
          }}
        >
          {filenameMode(file.path, "text")}
          {fileComments.length > 0 ? ` · ${fileComments.length} comments` : ""}
          {matchedFindCount > 0 ? ` · ${matchedFindCount} matches` : ""}
          {remainingLineCount > 0
            ? ` · showing ${visibleLines.length.toLocaleString()} / ${file.lines.length.toLocaleString()} diff lines`
            : ""}
        </Typography.Text>
      </div>
      <DiffBlock
        filePath={file.path}
        fileIndex={index}
        lines={visibleLines}
        languageHint={languageHint}
        fontSize={fontSize}
        editorTheme={editorTheme}
        comments={fileComments}
        showResolvedComments={showResolvedComments}
        commentEnabled={!isHeadSelected}
        commentDisabledMessage={
          isHeadSelected ? "Please commit first, then comment." : undefined
        }
        activeDraftAnchorId={activeDraftAnchorId}
        activeDraftBody={activeDraftBody}
        activeEditingId={activeEditingId}
        activeEditingBody={activeEditingBody}
        pendingKey={pendingKey}
        onOpenDraft={onOpenDraft}
        onDraftBodyChange={onDraftBodyChange}
        onCancelDraft={onCancelDraft}
        onOpenEdit={onOpenEdit}
        onEditingBodyChange={onEditingBodyChange}
        onCancelEdit={onCancelEdit}
        onCreateComment={onCreateComment}
        onUpdateComment={onUpdateComment}
        onResolveComment={onResolveComment}
        onReopenComment={onReopenComment}
        matchedLineIndexes={matchedLineIndexes}
        activeMatchedLineIndex={activeFindLineIndex}
      />
      {remainingLineCount > 0 ? (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginTop: 10,
          }}
        >
          <Button onClick={() => onShowMoreLines(sectionId)}>
            Show{" "}
            {Math.min(
              RENDERED_DIFF_LINES_INCREMENT,
              remainingLineCount,
            ).toLocaleString()}{" "}
            more lines
            {remainingLineCount > RENDERED_DIFF_LINES_INCREMENT
              ? ` (${remainingLineCount.toLocaleString()} remaining)`
              : ""}
          </Button>
        </div>
      ) : null}
    </div>
  );
});

export function GitCommitDrawer({
  projectId,
  sourcePath,
  cwdOverride,
  commitHash,
  open,
  onClose,
  fontSize = 14,
  onRequestAgentTurn,
  onDirectCommitLogged,
  onFindInChat,
  onOpenActivityLog,
}: GitCommitDrawerProps) {
  const accountId = useTypedRedux("account", "account_id");
  const editorTheme = useEffectiveEditorThemeForPath(projectId, sourcePath);
  const [drawerSize, setDrawerSize] = useState<number>(readDrawerSize);
  const [contextLines, setContextLines] = useState<number>(
    DEFAULT_CONTEXT_LINES,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<GitShowParsed | undefined>(undefined);
  const [repoRoot, setRepoRoot] = useState<string>("");
  const [gitLog, setGitLog] = useState<GitLogEntry[]>([]);
  const [gitLogError, setGitLogError] = useState<string>("");
  const [nonRepoError, setNonRepoError] = useState<string>("");
  const [gitLogReloadCounter, setGitLogReloadCounter] = useState(0);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [repoBootstrapBusy, setRepoBootstrapBusy] = useState(false);
  const [headStatusLoading, setHeadStatusLoading] = useState(false);
  const [headStatusError, setHeadStatusError] = useState("");
  const [headStatusEntries, setHeadStatusEntries] = useState<HeadStatusEntry[]>(
    [],
  );
  const [headStatusAction, setHeadStatusAction] = useState<string>("");
  const [headCommitBusy, setHeadCommitBusy] = useState(false);
  const [headCommitMessage, setHeadCommitMessage] = useState("");
  const [headCommitError, setHeadCommitError] = useState("");
  const [reviewedByCommit, setReviewedByCommit] = useState<
    Record<string, boolean>
  >({});
  const incomingCommit = useMemo(
    () => parseCommitHash(commitHash),
    [commitHash],
  );
  const [selectedCommit, setSelectedCommit] = useState<string | undefined>(
    incomingCommit,
  );
  const [commitSearch, setCommitSearch] = useState("");
  const [diffFindQuery, setDiffFindQuery] = useState("");
  const [activeDiffFindMatchIndex, setActiveDiffFindMatchIndex] =
    useState<number>(-1);
  const [showOnlyUnreviewedCommits, setShowOnlyUnreviewedCommits] =
    useState(false);
  const commit = selectedCommit;
  const isHeadSelected = isHeadCommit(commit);

  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewTransferBusy, setReviewTransferBusy] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewNoteDraft, setReviewNoteDraft] = useState("");
  const [reviewNoteEditing, setReviewNoteEditing] = useState(false);
  const [reviewUpdatedAt, setReviewUpdatedAt] = useState<number | undefined>(
    undefined,
  );
  const [reviewDirty, setReviewDirty] = useState(false);
  const [reviewRecord, setReviewRecord] = useState<
    GitReviewRecordV2 | undefined
  >(undefined);
  const [reviewSubmitBusy, setReviewSubmitBusy] = useState(false);
  const [showResolvedComments, setShowResolvedComments] = useState(false);
  const [reviewStateCommit, setReviewStateCommit] = useState<
    string | undefined
  >(undefined);
  const [reviewReloadCounter, setReviewReloadCounter] = useState(0);
  const [reviewDeleteAllOpen, setReviewDeleteAllOpen] = useState(false);
  const [reviewDeleteAllConfirmValue, setReviewDeleteAllConfirmValue] =
    useState("");
  const reviewLoadTokenRef = useRef(0);
  const activeReviewCommitRef = useRef<string | undefined>(undefined);
  const reviewNoteDraftRef = useRef(reviewNoteDraft);
  const reviewedRef = useRef(reviewed);
  const preserveCommitSearchOnAutoClearRef = useRef(false);
  const reviewImportInputRef = useRef<HTMLInputElement | null>(null);
  const diffFindInputRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const restoringScrollRef = useRef(false);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const pendingContextAnchorRef = useRef<GitDiffScrollAnchor | null>(null);
  const [visibleDiffLinesByFile, setVisibleDiffLinesByFile] = useState<
    Record<string, number>
  >({});
  const [drawerScrollParent, setDrawerScrollParent] =
    useState<HTMLDivElement | null>(null);
  const [activeInlineDraft, setActiveInlineDraft] = useState<
    CommentAnchor | undefined
  >(undefined);
  const [activeInlineDraftBody, setActiveInlineDraftBody] = useState("");
  const [activeInlineEditId, setActiveInlineEditId] = useState<
    string | undefined
  >(undefined);
  const [activeInlineEditBody, setActiveInlineEditBody] = useState("");
  const [inlineCommentPendingKey, setInlineCommentPendingKey] = useState("");

  const cwd = useMemo(() => {
    const override = `${cwdOverride ?? ""}`.trim();
    if (override) return override;
    return containingPath(sourcePath ?? ".") || ".";
  }, [sourcePath, cwdOverride]);

  useEffect(() => {
    reviewNoteDraftRef.current = reviewNoteDraft;
  }, [reviewNoteDraft]);

  useEffect(() => {
    reviewedRef.current = reviewed;
  }, [reviewed]);
  const scrollStorageId = useMemo(() => {
    const commitKey = `${commit ?? HEAD_REF}`.toLowerCase();
    const raw = `${projectId ?? "no-project"}|${sourcePath ?? ""}|${cwd}|${commitKey}`;
    return hashString(raw);
  }, [projectId, sourcePath, cwd, commit]);

  useEffect(() => {
    if (!open) return;
    setSelectedCommit(incomingCommit);
  }, [incomingCommit, open]);

  useEffect(() => {
    setCommitSearch("");
    setDiffFindQuery("");
    setActiveDiffFindMatchIndex(-1);
    preserveCommitSearchOnAutoClearRef.current = false;
  }, [open]);

  const handleCommitChange = useCallback((value: string) => {
    preserveCommitSearchOnAutoClearRef.current = true;
    setSelectedCommit(value);
  }, []);

  const handleCommitSearch = useCallback((nextSearch: string) => {
    setCommitSearch((currentSearch) => {
      const resolved = resolveGitCommitSearchChange({
        currentSearch,
        nextSearch,
        preserveSearchOnAutoClear: preserveCommitSearchOnAutoClearRef.current,
      });
      preserveCommitSearchOnAutoClearRef.current =
        resolved.preserveSearchOnAutoClear;
      return resolved.search;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    pendingScrollRestoreRef.current =
      readDrawerScrollPosition(scrollStorageId) ?? null;
  }, [open, scrollStorageId]);

  useEffect(() => {
    if (!open) return;
    setVisibleDiffLinesByFile({});
  }, [open, commit, contextLines, reloadCounter]);

  useEffect(() => {
    if (!open) return;
    setActiveInlineDraft(undefined);
    setActiveInlineDraftBody("");
    setActiveInlineEditId(undefined);
    setActiveInlineEditBody("");
    setInlineCommentPendingKey("");
  }, [open, commit, contextLines, reloadCounter]);

  const diffFindMatches = useMemo(
    () =>
      buildGitDiffFindMatches({
        data,
        query: diffFindQuery,
      }),
    [data, diffFindQuery],
  );

  const activeDiffFindMatch =
    activeDiffFindMatchIndex >= 0 &&
    activeDiffFindMatchIndex < diffFindMatches.length
      ? diffFindMatches[activeDiffFindMatchIndex]
      : undefined;

  const diffFindMeta = useMemo(() => {
    const counts = new Map<number, number>();
    const matchedLineIndexes = new Map<number, Set<number>>();
    for (const match of diffFindMatches) {
      counts.set(match.fileIndex, (counts.get(match.fileIndex) ?? 0) + 1);
      if (match.kind === "file") {
        continue;
      } else if (typeof match.lineIndex === "number") {
        const existing = matchedLineIndexes.get(match.fileIndex) ?? new Set();
        existing.add(match.lineIndex);
        matchedLineIndexes.set(match.fileIndex, existing);
      }
    }
    return { counts, matchedLineIndexes };
  }, [diffFindMatches]);

  const activeDiffFindTargetRendered = useMemo(
    () =>
      isGitDiffFindTargetRendered({
        data,
        match: activeDiffFindMatch,
        visibleDiffLinesByFile,
      }),
    [data, activeDiffFindMatch, visibleDiffLinesByFile],
  );

  const activeDiffFindVisibleLineLimitUpdate = useMemo(
    () =>
      getGitDiffFindVisibleLineLimitUpdate({
        data,
        match: activeDiffFindMatch,
        visibleDiffLinesByFile,
      }),
    [data, activeDiffFindMatch, visibleDiffLinesByFile],
  );

  useEffect(() => {
    if (!open) return;
    if (!diffFindQuery.trim()) {
      setActiveDiffFindMatchIndex(-1);
      return;
    }
    setActiveDiffFindMatchIndex(diffFindMatches.length > 0 ? 0 : -1);
  }, [open, commit, diffFindQuery, diffFindMatches.length]);

  useEffect(() => {
    if (diffFindMatches.length === 0) {
      if (activeDiffFindMatchIndex !== -1) {
        setActiveDiffFindMatchIndex(-1);
      }
      return;
    }
    if (
      activeDiffFindMatchIndex < 0 ||
      activeDiffFindMatchIndex >= diffFindMatches.length
    ) {
      setActiveDiffFindMatchIndex(0);
    }
  }, [activeDiffFindMatchIndex, diffFindMatches.length]);

  useEffect(() => {
    if (!open) return;
    const target = pendingScrollRestoreRef.current;
    const anchor = pendingContextAnchorRef.current;
    const node = scrollRef.current;
    if (!node) return;
    let frame: number | undefined;
    const restore = () => {
      if (anchor) {
        restoringScrollRef.current = true;
        if (restoreGitDiffScrollAnchor(node, anchor)) {
          pendingContextAnchorRef.current = null;
          restoringScrollRef.current = false;
          pendingScrollRestoreRef.current = null;
          persistDrawerScrollPosition(scrollStorageId, node.scrollTop);
          return;
        }
        restoringScrollRef.current = false;
        if (loading) {
          return;
        }
        pendingContextAnchorRef.current = null;
      }
      if (target == null) return;
      const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
      if (target > 0 && maxTop <= 0) {
        // Content is not laid out yet; keep pending target and retry on next render.
        return;
      }
      restoringScrollRef.current = true;
      node.scrollTop = Math.min(target, maxTop);
      restoringScrollRef.current = false;
      pendingScrollRestoreRef.current = null;
      persistDrawerScrollPosition(scrollStorageId, node.scrollTop);
    };
    if (typeof requestAnimationFrame === "function") {
      frame = requestAnimationFrame(restore);
      return () => {
        if (frame != null) cancelAnimationFrame(frame);
      };
    }
    restore();
    return;
  }, [open, loading, error, data, nonRepoError, scrollStorageId]);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const rootResult = await runGitCommand({
          projectId,
          cwd,
          args: ["rev-parse", "--show-toplevel"],
        });
        if (rootResult.exit_code !== 0) {
          throw new Error(
            (
              rootResult.stderr ||
              rootResult.stdout ||
              "not a git repository"
            ).trim(),
          );
        }
        const root = `${rootResult.stdout ?? ""}`.trim();
        if (!cancelled) {
          setRepoRoot(root);
          setNonRepoError("");
          setGitLogError("");
        }
        const logResult = await runGitCommand({
          projectId,
          cwd: root || cwd,
          args: buildGitLogArgs(),
        });
        if (logResult.exit_code !== 0) {
          throw new Error(
            (logResult.stderr || logResult.stdout || "git log failed").trim(),
          );
        }
        const entries = parseGitLogOutput(logResult.stdout ?? "");
        if (!cancelled) {
          setGitLog(entries);
          setNonRepoError("");
          setGitLogError("");
        }
      } catch (err) {
        if (cancelled) return;
        const message = `${err ?? "Unable to load git log."}`;
        setRepoRoot("");
        setGitLog([]);
        setGitLogError(message);
        setNonRepoError(isNotGitRepoError(message) ? message : "");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId, cwd, gitLogReloadCounter]);

  useEffect(() => {
    if (!open || !isHeadSelected) return;
    let cancelled = false;
    (async () => {
      if (!projectId) return;
      setHeadStatusLoading(true);
      setHeadStatusError("");
      try {
        const statusResult = await runGitCommand({
          projectId,
          cwd: repoRoot || cwd,
          args: ["status", "--porcelain=v1", "--untracked-files=all"],
        });
        if (statusResult.exit_code !== 0) {
          throw new Error(
            (
              statusResult.stderr ||
              statusResult.stdout ||
              "git status failed"
            ).trim(),
          );
        }
        if (!cancelled) {
          setHeadStatusEntries(parseGitStatusOutput(statusResult.stdout ?? ""));
          setHeadStatusError("");
        }
      } catch (err) {
        if (!cancelled) {
          setHeadStatusEntries([]);
          setHeadStatusError(`${err ?? "Unable to load HEAD status."}`);
        }
      } finally {
        if (!cancelled) {
          setHeadStatusLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isHeadSelected, projectId, repoRoot, cwd, reloadCounter]);

  useEffect(() => {
    if (!open || commit || gitLog.length === 0) return;
    setSelectedCommit(gitLog[0].hash);
  }, [open, commit, gitLog]);

  const navigableGitLog = useMemo(
    () =>
      filterGitReviewLogEntries({
        entries: gitLog,
        reviewedByCommit,
        onlyUnreviewed: showOnlyUnreviewedCommits,
      }),
    [gitLog, reviewedByCommit, showOnlyUnreviewedCommits],
  );

  const commitIndex = useMemo(() => {
    if (!commit) return -1;
    return navigableGitLog.findIndex((entry) => entry.hash === commit);
  }, [navigableGitLog, commit]);

  useEffect(() => {
    if (
      !open ||
      !commit ||
      isHeadSelected ||
      navigableGitLog.length === 0 ||
      commitIndex >= 0
    )
      return;
    const prefixMatches = navigableGitLog.filter((entry) =>
      entry.hash.startsWith(commit),
    );
    if (prefixMatches.length === 1) {
      setSelectedCommit(prefixMatches[0].hash);
    }
  }, [open, commit, isHeadSelected, navigableGitLog, commitIndex]);

  useEffect(() => {
    if (!open || !showOnlyUnreviewedCommits) return;
    if (isHeadSelected) return;
    if (commitIndex >= 0) return;
    if (navigableGitLog.length === 0) return;
    setSelectedCommit(navigableGitLog[0].hash);
  }, [
    open,
    showOnlyUnreviewedCommits,
    isHeadSelected,
    commitIndex,
    navigableGitLog,
  ]);

  useEffect(() => {
    if (!open) return;
    if (nonRepoError) {
      setError("");
      setLoading(false);
      setData(undefined);
    }
  }, [open, nonRepoError]);

  const visibleLogEntries = useMemo(() => {
    if (navigableGitLog.length === 0) return [] as GitLogEntry[];
    if (commitIndex < 0) {
      return navigableGitLog.slice(0, GIT_LOG_WINDOW_SIZE);
    }
    const half = Math.floor(GIT_LOG_WINDOW_SIZE / 2);
    let start = Math.max(0, commitIndex - half);
    let end = Math.min(navigableGitLog.length, start + GIT_LOG_WINDOW_SIZE);
    start = Math.max(0, end - GIT_LOG_WINDOW_SIZE);
    return navigableGitLog.slice(start, end);
  }, [navigableGitLog, commitIndex]);

  const logOptions = useMemo(() => {
    const makeOptionLabel = (entry: GitLogEntry, fallback = false) => {
      const { reviewed, known } = getCommitReviewIndicatorState(
        reviewedByCommit,
        entry.hash,
      );
      const highlightNeedsReview =
        !fallback && !isHeadCommit(entry.hash) && known && !reviewed;
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            width: "100%",
            borderRadius: 6,
            padding: "2px 6px",
            background: highlightNeedsReview ? "#fffbe6" : undefined,
            pointerEvents: "none",
          }}
        >
          <Checkbox
            checked={reviewed}
            disabled
            style={{ pointerEvents: "none", marginInlineEnd: 0 }}
          />
          <span
            style={{
              fontFamily: "monospace",
              whiteSpace: "nowrap",
              color: fallback ? COLORS.GRAY_D : undefined,
            }}
          >
            {entry.hash.slice(0, 10)}
          </span>
          <span
            style={{
              minWidth: 0,
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: fallback ? COLORS.GRAY_D : undefined,
            }}
            title={entry.subject || (fallback ? "selected commit" : "")}
          >
            {entry.subject || (fallback ? "(selected commit)" : "")}
          </span>
        </div>
      );
    };
    const options = [
      {
        value: HEAD_REF,
        label: makeOptionLabel({
          hash: HEAD_REF,
          subject: "Uncommitted changes (git diff HEAD)",
        }),
        search: "HEAD uncommitted changes git diff",
      },
      ...visibleLogEntries.map((entry) => ({
        value: entry.hash,
        label: makeOptionLabel(entry),
        search: `${entry.hash} ${entry.subject}`.trim(),
      })),
    ];
    if (commit && !options.some((opt) => opt.value === commit)) {
      const fallback: GitLogEntry = {
        hash: commit,
        subject: "selected commit",
      };
      options.unshift({
        value: commit,
        label: makeOptionLabel(fallback, true),
        search: `${commit} selected commit`,
      });
    }
    return options;
  }, [visibleLogEntries, commit, reviewedByCommit]);

  useEffect(() => {
    if (!open) {
      activeReviewCommitRef.current = undefined;
      return;
    }
    if (!commit || isHeadCommit(commit)) {
      activeReviewCommitRef.current = undefined;
      return;
    }
    activeReviewCommitRef.current = normalizeCommitSha(commit);
  }, [open, commit]);

  useEffect(() => {
    if (!open || !accountId) return;
    const hashes = Array.from(
      new Set(
        [...visibleLogEntries.map((entry) => entry.hash), commit].filter(
          (hash): hash is string =>
            Boolean(hash) && COMMIT_HASH_RE.test(`${hash ?? ""}`),
        ),
      ),
    );
    if (hashes.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const entries = await Promise.all(
          hashes.map(async (hash) => {
            const rec = await loadReviewRecord({ accountId, commitSha: hash });
            return [hash, Boolean(rec?.reviewed)] as const;
          }),
        );
        if (cancelled) return;
        setReviewedByCommit((prev) => {
          const next = { ...prev };
          for (const [hash, isReviewed] of entries) {
            next[hash] = isReviewed;
          }
          return next;
        });
      } catch {
        // ignore transient dropdown review indicator failures
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, accountId, visibleLogEntries, commit, reviewReloadCounter]);

  useEffect(() => {
    const token = ++reviewLoadTokenRef.current;
    const applyReset = (nextCommit?: string) => {
      const normalizedNext = normalizeCommitSha(nextCommit);
      const draft = normalizedNext
        ? loadReviewDraft(normalizedNext)
        : undefined;
      setReviewLoading(false);
      setReviewError("");
      setReviewed(Boolean(draft?.reviewed));
      const note = `${draft?.note ?? ""}`;
      setReviewNote(note);
      setReviewNoteDraft(note);
      setReviewNoteEditing(false);
      setReviewUpdatedAt(
        typeof draft?.updated_at === "number" ? draft.updated_at : undefined,
      );
      setReviewDirty(false);
      setReviewRecord(undefined);
      setReviewStateCommit(normalizedNext);
      if (normalizedNext) {
        setReviewedByCommit((prev) => ({
          ...prev,
          [normalizedNext]:
            typeof draft?.reviewed === "boolean"
              ? draft.reviewed
              : Boolean(prev[normalizedNext]),
        }));
      }
    };
    if (!open || !accountId || !commit) {
      applyReset();
      return;
    }
    const normalizedCommit = normalizeCommitSha(commit);
    if (isHeadCommit(commit) || !normalizedCommit) {
      applyReset();
      return;
    }
    applyReset(normalizedCommit);
    setReviewLoading(true);
    void (async () => {
      try {
        const rec = await loadReviewRecord({
          accountId,
          commitSha: normalizedCommit,
        });
        if (reviewLoadTokenRef.current !== token) return;
        setReviewRecord(rec);
        setReviewed(Boolean(rec?.reviewed));
        setReviewedByCommit((prev) => ({
          ...prev,
          [normalizedCommit]: Boolean(rec?.reviewed),
        }));
        const note = typeof rec?.note === "string" ? rec.note : "";
        setReviewNote(note);
        setReviewNoteDraft(note);
        setReviewNoteEditing(false);
        setReviewUpdatedAt(
          typeof rec?.updated_at === "number" ? rec.updated_at : undefined,
        );
        setReviewDirty(false);
        setReviewError("");
      } catch (err) {
        if (reviewLoadTokenRef.current !== token) return;
        setReviewError(`${err ?? "Unable to load review state."}`);
        setReviewed(false);
        setReviewNote("");
        setReviewNoteDraft("");
        setReviewNoteEditing(false);
        setReviewUpdatedAt(undefined);
        setReviewDirty(false);
        setReviewRecord(undefined);
      } finally {
        if (reviewLoadTokenRef.current !== token) return;
        setReviewLoading(false);
      }
    })();
  }, [open, accountId, commit, reviewReloadCounter]);

  const exportReviewData = useCallback(async () => {
    if (!accountId) {
      alert_message({
        type: "error",
        message: "Unable to export git reviews without a signed-in account.",
      });
      return;
    }
    setReviewTransferBusy(true);
    try {
      const bundle = await exportReviewBundle({ accountId });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date(bundle.exported_at)
        .toISOString()
        .replace(/[:]/g, "-");
      anchor.href = url;
      anchor.download = `cocalc-git-reviews-${stamp}.json`;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      alert_message({
        type: "success",
        message: `Exported ${bundle.records.length} git review${bundle.records.length === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      alert_message({
        type: "error",
        message: `${err ?? "Unable to export git reviews."}`,
      });
    } finally {
      setReviewTransferBusy(false);
    }
  }, [accountId]);

  const importReviewData = useCallback(
    async (file?: File | null) => {
      if (!file) return;
      if (!accountId) {
        alert_message({
          type: "error",
          message: "Unable to import git reviews without a signed-in account.",
        });
        return;
      }
      setReviewTransferBusy(true);
      try {
        const payload = JSON.parse(await file.text());
        const result = await importReviewBundle({
          accountId,
          payload,
        });
        setReviewReloadCounter((n) => n + 1);
        const skippedSuffix =
          result.skipped > 0
            ? ` Skipped ${result.skipped} older or invalid review${result.skipped === 1 ? "" : "s"}.`
            : "";
        alert_message({
          type: "success",
          message:
            result.total === 0
              ? "Import file contained no git reviews."
              : `Imported ${result.imported} git review${result.imported === 1 ? "" : "s"}.${skippedSuffix}`,
        });
      } catch (err) {
        alert_message({
          type: "error",
          message: `${err ?? "Unable to import git reviews."}`,
        });
      } finally {
        setReviewTransferBusy(false);
      }
    },
    [accountId],
  );

  const deleteAllReviewData = useCallback(async () => {
    if (!accountId) {
      alert_message({
        type: "error",
        message: "Unable to delete git reviews without a signed-in account.",
      });
      return;
    }
    setReviewTransferBusy(true);
    try {
      const result = await deleteAllReviewRecords({ accountId });
      setReviewedByCommit({});
      setReviewReloadCounter((n) => n + 1);
      setReviewDeleteAllOpen(false);
      setReviewDeleteAllConfirmValue("");
      alert_message({
        type: "success",
        message:
          result.deleted === 0
            ? "There were no git reviews to delete."
            : `Deleted ${result.deleted} git review${result.deleted === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      alert_message({
        type: "error",
        message: `${err ?? "Unable to delete git reviews."}`,
      });
    } finally {
      setReviewTransferBusy(false);
    }
  }, [accountId]);

  const reviewMenuItems = useMemo<NonNullable<MenuProps["items"]>>(() => {
    const items: NonNullable<MenuProps["items"]> = [
      {
        key: "export",
        label: "Export reviews",
        disabled: reviewTransferBusy || !accountId,
      },
      {
        key: "import",
        label: "Import reviews",
        disabled: reviewTransferBusy || !accountId,
      },
      {
        key: "delete-all",
        label: "Delete all reviews",
        danger: true,
        disabled: reviewTransferBusy || !accountId,
      },
    ];
    if (onOpenActivityLog) {
      items.push({ type: "divider" });
      items.push({
        key: "activity",
        label: "Open activity",
      });
    }
    return items;
  }, [accountId, onOpenActivityLog, reviewTransferBusy]);

  const handleReviewMenuClick = useCallback<NonNullable<MenuProps["onClick"]>>(
    ({ key }) => {
      if (key === "export") {
        void exportReviewData();
        return;
      }
      if (key === "import") {
        reviewImportInputRef.current?.click();
        return;
      }
      if (key === "delete-all") {
        setReviewDeleteAllConfirmValue("");
        setReviewDeleteAllOpen(true);
        return;
      }
      if (key === "activity") {
        onOpenActivityLog?.();
      }
    },
    [exportReviewData, onOpenActivityLog],
  );

  const saveReview = useCallback(
    async (
      next: Partial<
        Pick<
          GitReviewRecordV2,
          | "reviewed"
          | "note"
          | "comments"
          | "last_submitted_at"
          | "last_submission_turn_id"
        >
      > = {},
    ) => {
      if (!accountId || !commit || isHeadCommit(commit)) return;
      const normalizedCommit = normalizeCommitSha(commit);
      if (!normalizedCommit) return;
      const resolved = resolveGitReviewSaveState({
        next,
        draft: loadReviewDraft(normalizedCommit),
        reviewed,
        reviewNote,
        reviewNoteDraft,
        reviewComments: reviewRecord?.comments,
      });
      const nextReviewed = resolved.reviewed;
      const nextNote = resolved.note;
      const nextComments = resolved.comments;
      const sentState = {
        reviewed: Boolean(nextReviewed),
        note: `${nextNote ?? ""}`,
      };
      const isActiveCommit = activeReviewCommitRef.current === normalizedCommit;
      if (isActiveCommit) {
        setReviewSaving(true);
        setReviewError("");
      }
      try {
        const base =
          reviewRecord ??
          ({
            version: 2,
            account_id: accountId,
            commit_sha: normalizedCommit,
            reviewed: false,
            note: "",
            comments: {},
            created_at: Date.now(),
            updated_at: Date.now(),
            revision: 1,
          } as GitReviewRecordV2);
        const payload = await saveReviewRecord({
          ...base,
          account_id: accountId,
          commit_sha: normalizedCommit,
          reviewed: Boolean(nextReviewed),
          note: `${nextNote ?? ""}`,
          comments: nextComments,
          last_submitted_at:
            typeof next.last_submitted_at === "number"
              ? next.last_submitted_at
              : base.last_submitted_at,
          last_submission_turn_id:
            typeof next.last_submission_turn_id === "string"
              ? next.last_submission_turn_id
              : base.last_submission_turn_id,
        });
        setReviewedByCommit((prev) => ({
          ...prev,
          [normalizedCommit]: payload.reviewed,
        }));
        if (activeReviewCommitRef.current === normalizedCommit) {
          const completion = resolveGitReviewSaveCompletion({
            payload,
            sent: sentState,
            current: {
              reviewed: reviewedRef.current,
              noteDraft: reviewNoteDraftRef.current,
            },
          });
          setReviewed(completion.reviewed);
          setReviewNote(completion.reviewNote);
          setReviewNoteDraft(completion.reviewNoteDraft);
          setReviewRecord(payload);
          setReviewUpdatedAt(payload.updated_at);
          setReviewDirty(completion.reviewDirty);
          setReviewError("");
        }
      } catch (err) {
        if (activeReviewCommitRef.current === normalizedCommit) {
          setReviewError(`${err ?? "Unable to save review state."}`);
        }
      } finally {
        if (activeReviewCommitRef.current === normalizedCommit) {
          setReviewSaving(false);
        }
      }
    },
    [accountId, commit, reviewed, reviewNote, reviewNoteDraft, reviewRecord],
  );

  const allInlineComments = useMemo(
    () => Object.values(reviewRecord?.comments ?? {}),
    [reviewRecord],
  );
  const unresolvedInlineComments = useMemo(
    () => allInlineComments.filter((comment) => comment.status !== "resolved"),
    [allInlineComments],
  );
  const inlineComments = useMemo(
    () => (showResolvedComments ? allInlineComments : unresolvedInlineComments),
    [showResolvedComments, allInlineComments, unresolvedInlineComments],
  );
  const resolvedInlineCount = useMemo(
    () =>
      allInlineComments.filter((comment) => comment.status === "resolved")
        .length,
    [allInlineComments],
  );
  const actionableInlineComments = useMemo(
    () =>
      unresolvedInlineComments.filter(
        (comment) =>
          comment.status === "draft" &&
          (comment.submitted_at == null ||
            (comment.updated_at ?? 0) > (comment.submitted_at ?? 0)),
      ),
    [unresolvedInlineComments],
  );

  const mutateInlineComments = useCallback(
    async (
      mutate: (
        comments: Record<string, GitReviewCommentV2>,
      ) => Record<string, GitReviewCommentV2>,
    ) => {
      if (!accountId || !commit || isHeadCommit(commit)) return;
      const normalizedCommit = normalizeCommitSha(commit);
      if (!normalizedCommit) return;
      const latestDraft = loadReviewDraft(normalizedCommit);
      const resolved = resolveGitReviewSaveState({
        draft: latestDraft,
        reviewed,
        reviewNote,
        reviewNoteDraft,
        reviewComments: reviewRecord?.comments,
      });
      const current = resolved.comments;
      const next = mutate({ ...current });
      saveReviewDraft(normalizedCommit, {
        reviewed: resolved.reviewed,
        note: resolved.note,
        comments: next,
      });
      await saveReview({
        comments: next,
        reviewed: resolved.reviewed,
        note: resolved.note,
      });
    },
    [
      accountId,
      commit,
      reviewRecord?.comments,
      reviewNoteDraft,
      reviewNote,
      reviewed,
      saveReview,
    ],
  );

  const createInlineComment = useCallback(
    async (anchor: CommentAnchor, body: string) => {
      const trimmed = `${body ?? ""}`.trim();
      if (!trimmed) return;
      const now = Date.now();
      await mutateInlineComments((comments) => {
        const id = makeCommentId();
        comments[id] = {
          id,
          file_path: anchor.filePath,
          side: anchor.side,
          line: anchor.line,
          hunk_header: anchor.hunk_header,
          hunk_hash: anchor.hunk_hash,
          snippet: anchor.snippet,
          body_md: trimmed,
          status: "draft",
          created_at: now,
          updated_at: now,
          local_revision: 1,
        };
        return comments;
      });
    },
    [mutateInlineComments],
  );

  const updateInlineComment = useCallback(
    async (id: string, body: string) => {
      const trimmed = `${body ?? ""}`.trim();
      if (!id || !trimmed) return;
      const now = Date.now();
      await mutateInlineComments((comments) => {
        const existing = comments[id];
        if (!existing) return comments;
        comments[id] = {
          ...existing,
          body_md: trimmed,
          status: "draft",
          updated_at: now,
          local_revision: (existing.local_revision ?? 0) + 1,
        };
        return comments;
      });
    },
    [mutateInlineComments],
  );

  const resolveInlineComment = useCallback(
    async (id: string) => {
      if (!id) return;
      const now = Date.now();
      await mutateInlineComments((comments) => {
        const existing = comments[id];
        if (!existing) return comments;
        comments[id] = {
          ...existing,
          status: "resolved",
          updated_at: now,
          local_revision: (existing.local_revision ?? 0) + 1,
        };
        return comments;
      });
    },
    [mutateInlineComments],
  );

  const reopenInlineComment = useCallback(
    async (id: string) => {
      if (!id) return;
      const now = Date.now();
      await mutateInlineComments((comments) => {
        const existing = comments[id];
        if (!existing) return comments;
        comments[id] = {
          ...existing,
          status: "draft",
          submitted_at: undefined,
          submission_turn_id: undefined,
          updated_at: now,
          local_revision: (existing.local_revision ?? 0) + 1,
        };
        return comments;
      });
    },
    [mutateInlineComments],
  );

  const inlineCommentsByFile = useMemo(() => {
    const byFile = new Map<string, GitReviewCommentV2[]>();
    for (const comment of inlineComments) {
      const existing = byFile.get(comment.file_path) ?? [];
      existing.push(comment);
      byFile.set(comment.file_path, existing);
    }
    return byFile;
  }, [inlineComments]);

  const activeDraftAnchorId = useMemo(
    () =>
      activeInlineDraft == null
        ? undefined
        : commentAnchorKey(activeInlineDraft),
    [activeInlineDraft],
  );

  const openInlineDraft = useCallback(
    (anchor: CommentAnchor) => {
      setActiveInlineEditId(undefined);
      setActiveInlineEditBody("");
      setActiveInlineDraft(anchor);
      setActiveInlineDraftBody((current) =>
        activeDraftAnchorId === commentAnchorKey(anchor) ? current : "",
      );
    },
    [activeDraftAnchorId],
  );

  const cancelInlineDraft = useCallback(() => {
    setActiveInlineDraft(undefined);
    setActiveInlineDraftBody("");
  }, []);

  const openInlineEdit = useCallback((comment: GitReviewCommentV2) => {
    setActiveInlineDraft(undefined);
    setActiveInlineDraftBody("");
    setActiveInlineEditId(comment.id);
    setActiveInlineEditBody(comment.body_md);
  }, []);

  const cancelInlineEdit = useCallback(() => {
    setActiveInlineEditId(undefined);
    setActiveInlineEditBody("");
  }, []);

  const submitInlineDraft = useCallback(
    async (anchor: CommentAnchor, value: string) => {
      const trimmed = `${value ?? ""}`.trim();
      if (!trimmed) return;
      const key = `create:${commentAnchorKey(anchor)}`;
      setInlineCommentPendingKey(key);
      try {
        await createInlineComment(anchor, trimmed);
        setActiveInlineDraft(undefined);
        setActiveInlineDraftBody("");
      } finally {
        setInlineCommentPendingKey("");
      }
    },
    [createInlineComment],
  );

  const submitInlineEdit = useCallback(
    async (id: string, value: string) => {
      if (activeInlineEditId !== id) return;
      const trimmed = `${value ?? ""}`.trim();
      if (!trimmed) return;
      setInlineCommentPendingKey(`edit:${id}`);
      try {
        await updateInlineComment(id, trimmed);
        setActiveInlineEditId(undefined);
        setActiveInlineEditBody("");
      } finally {
        setInlineCommentPendingKey("");
      }
    },
    [activeInlineEditId, updateInlineComment],
  );

  const handleResolveInlineComment = useCallback(
    async (id: string) => {
      setInlineCommentPendingKey(`resolve:${id}`);
      try {
        await resolveInlineComment(id);
        if (activeInlineEditId === id) {
          setActiveInlineEditId(undefined);
          setActiveInlineEditBody("");
        }
      } finally {
        setInlineCommentPendingKey("");
      }
    },
    [activeInlineEditId, resolveInlineComment],
  );

  const handleReopenInlineComment = useCallback(
    async (id: string) => {
      setInlineCommentPendingKey(`reopen:${id}`);
      try {
        await reopenInlineComment(id);
        if (activeInlineEditId === id) {
          setActiveInlineEditId(undefined);
          setActiveInlineEditBody("");
        }
      } finally {
        setInlineCommentPendingKey("");
      }
    },
    [activeInlineEditId, reopenInlineComment],
  );

  const scrollToDiffFile = useCallback(
    (index: number, behavior: "auto" | "smooth" = "smooth") => {
      virtuosoRef.current?.scrollToIndex({
        index,
        align: "start",
        behavior,
      });
    },
    [],
  );

  const goToNextDiffFindMatch = useCallback(() => {
    if (diffFindMatches.length === 0) return;
    setActiveDiffFindMatchIndex((current) => {
      if (current < 0) return 0;
      return (current + 1) % diffFindMatches.length;
    });
  }, [diffFindMatches.length]);

  const goToPreviousDiffFindMatch = useCallback(() => {
    if (diffFindMatches.length === 0) return;
    setActiveDiffFindMatchIndex((current) => {
      if (current < 0) return diffFindMatches.length - 1;
      return (current - 1 + diffFindMatches.length) % diffFindMatches.length;
    });
  }, [diffFindMatches.length]);

  useEffect(() => {
    if (!open || !data || !activeDiffFindMatch) return;
    const file = data.files[activeDiffFindMatch.fileIndex];
    if (!file) return;
    if (activeDiffFindVisibleLineLimitUpdate) {
      setVisibleDiffLinesByFile((prev) => {
        if (
          (prev[activeDiffFindVisibleLineLimitUpdate.sectionId] ?? 0) >=
          activeDiffFindVisibleLineLimitUpdate.neededLimit
        ) {
          return prev;
        }
        return {
          ...prev,
          [activeDiffFindVisibleLineLimitUpdate.sectionId]:
            activeDiffFindVisibleLineLimitUpdate.neededLimit,
        };
      });
    }
    scrollToDiffFile(activeDiffFindMatch.fileIndex, "auto");
  }, [
    activeDiffFindMatch,
    activeDiffFindVisibleLineLimitUpdate,
    data,
    open,
    scrollToDiffFile,
  ]);

  useEffect(() => {
    if (!open || !data || !activeDiffFindMatch) return;
    const file = data.files[activeDiffFindMatch.fileIndex];
    if (!file) return;
    let attempts = 0;
    let frame = 0;
    const targetId =
      typeof activeDiffFindMatch.lineIndex === "number"
        ? buildGitReviewLineElementId({
            filePath: file.path,
            fileIndex: activeDiffFindMatch.fileIndex,
            lineIndex: activeDiffFindMatch.lineIndex,
          })
        : buildGitReviewFileSectionId(file.path, activeDiffFindMatch.fileIndex);
    const scrollTargetIntoView = () => {
      const element = document.getElementById(targetId);
      if (element) {
        const node = scrollRef.current;
        if (
          !node ||
          !scrollGitDrawerElementIntoView(node, element, {
            block: activeDiffFindMatch.kind === "file" ? "start" : "center",
            offsetTop: activeDiffFindMatch.kind === "file" ? 16 : 0,
          })
        ) {
          element.scrollIntoView({
            block: activeDiffFindMatch.kind === "file" ? "start" : "center",
          });
        }
        return;
      }
      if (attempts >= 10) return;
      attempts += 1;
      frame = window.requestAnimationFrame(scrollTargetIntoView);
    };
    frame = window.requestAnimationFrame(scrollTargetIntoView);
    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [activeDiffFindMatch, activeDiffFindTargetRendered, data, open]);

  const sendInlineReviewToAgent = async () => {
    if (!onRequestAgentTurn || !commit || isHeadSelected) return;
    const actionable = actionableInlineComments;
    if (actionable.length === 0) return;
    const gitCommand = `git show --no-color -U${contextLines} ${commit}`;
    const payload = {
      target: { git_command: gitCommand },
      comments: actionable.map((comment) => ({
        file_path: comment.file_path,
        side: comment.side,
        line: comment.line,
        hunk_header: comment.hunk_header,
        hunk_hash: comment.hunk_hash,
        snippet: comment.snippet,
        comment: comment.body_md,
        id: comment.id,
      })),
    };
    const prompt = [
      "Please review and address these inline commit comments.",
      `Target diff: ${gitCommand}`,
      "Return what you changed and any follow-up questions.",
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
    ].join("\n");
    setReviewSubmitBusy(true);
    try {
      await onRequestAgentTurn(prompt);
      const now = Date.now();
      const turnId = `git-review-${now}`;
      const nextComments = {
        ...(reviewRecord?.comments ?? {}),
      } as Record<string, GitReviewCommentV2>;
      for (const comment of actionable) {
        const existing = nextComments[comment.id];
        if (!existing) continue;
        nextComments[comment.id] = {
          ...existing,
          status: "submitted",
          submitted_at: now,
          submission_turn_id: turnId,
          updated_at: Math.max(existing.updated_at ?? now, now),
          local_revision: Math.max(1, existing.local_revision ?? 1),
        };
      }
      if (commit) {
        const normalizedCommit = normalizeCommitSha(commit);
        if (normalizedCommit) {
          const resolved = resolveGitReviewSaveState({
            draft: loadReviewDraft(normalizedCommit),
            reviewed,
            reviewNote,
            reviewNoteDraft,
            reviewComments: reviewRecord?.comments,
          });
          saveReviewDraft(normalizedCommit, {
            reviewed: resolved.reviewed,
            note: resolved.note,
            comments: nextComments,
          });
        }
      }
      await saveReview({
        comments: nextComments,
        last_submitted_at: now,
        last_submission_turn_id: turnId,
      });
      onClose();
    } catch (err) {
      setReviewError(`${err ?? "Unable to send review comments to codex."}`);
    } finally {
      setReviewSubmitBusy(false);
    }
  };

  useEffect(() => {
    if (!open || !commit || isHeadCommit(commit)) return;
    const normalizedCommit = normalizeCommitSha(commit);
    if (!normalizedCommit) return;
    if (reviewStateCommit !== normalizedCommit) return;
    if (reviewLoading || reviewSaving) return;
    if (!reviewDirty) return;
    saveReviewDraft(normalizedCommit, {
      reviewed: Boolean(reviewed),
      note: `${reviewNoteDraft ?? ""}`,
      comments: reviewRecord?.comments ?? {},
    });
  }, [
    open,
    commit,
    reviewLoading,
    reviewSaving,
    reviewDirty,
    reviewStateCommit,
    reviewed,
    reviewNoteDraft,
    reviewRecord?.comments,
  ]);

  useEffect(() => {
    if (!open) return;
    if (nonRepoError) {
      setLoading(false);
      setError("");
      setData(undefined);
      return;
    }
    if (!projectId) {
      setError("Invalid commit or missing project.");
      setData(undefined);
      return;
    }
    if (!commit) {
      setLoading(false);
      setError("");
      setData(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(undefined);
    (async () => {
      try {
        const args = buildGitShowArgs({
          isHeadSelected,
          contextLines,
          commit,
        });
        const showResult = await runGitCommand({
          projectId,
          cwd: repoRoot || cwd,
          args,
        });
        if (showResult.exit_code !== 0) {
          throw new Error(
            (
              showResult.stderr ||
              showResult.stdout ||
              (isHeadSelected ? "git diff failed" : "git show failed")
            ).trim(),
          );
        }
        const parsed = parseGitShowOutput(
          showResult.stdout ?? "",
          repoRoot || undefined,
        );
        if (!cancelled) {
          setData(parsed);
          setError("");
        }
      } catch (err) {
        if (cancelled) return;
        const message = `${err ?? "Unable to load commit."}`;
        setError(message);
        setData(undefined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    projectId,
    cwd,
    repoRoot,
    commit,
    contextLines,
    isHeadSelected,
    nonRepoError,
    reloadCounter,
  ]);

  const refreshAll = () => {
    setReloadCounter((n) => n + 1);
    setGitLogReloadCounter((n) => n + 1);
  };

  const initializeGitRepo = async () => {
    if (!projectId) return;
    setRepoBootstrapBusy(true);
    setGitLogError("");
    try {
      let result = await runGitCommand({
        projectId,
        cwd,
        args: ["init", "-b", "main"],
      });
      if (result.exit_code !== 0) {
        result = await runGitCommand({
          projectId,
          cwd,
          args: ["init"],
        });
      }
      if (result.exit_code !== 0) {
        throw new Error(
          (result.stderr || result.stdout || "git init failed").trim(),
        );
      }
      setNonRepoError("");
      setSelectedCommit(HEAD_REF);
      refreshAll();
      alert_message({
        type: "info",
        message: "Initialized a new git repository.",
      });
    } catch (err) {
      setGitLogError(`${err ?? "Unable to initialize git repository."}`);
    } finally {
      setRepoBootstrapBusy(false);
    }
  };

  const requestAgentRepoSetup = async () => {
    if (!onRequestAgentTurn) return;
    setRepoBootstrapBusy(true);
    try {
      const prompt = [
        "Set up this folder as a clean git repository for ongoing agent collaboration.",
        `Working directory: ${cwd}`,
        "Please do all of the following:",
        "1. Initialize git in this directory.",
        "2. Add a sensible .gitignore (exclude generated/build artifacts).",
        "3. Stage appropriate source files.",
        "4. Create an initial commit with a clear message.",
        "5. Summarize exactly what you included/excluded.",
      ].join("\n");
      await onRequestAgentTurn(prompt);
      onClose();
    } catch (err) {
      setGitLogError(`${err ?? "Unable to send setup request to codex."}`);
    } finally {
      setRepoBootstrapBusy(false);
    }
  };

  const addUntrackedFile = async (path: string) => {
    if (!projectId) return;
    setHeadStatusAction(`add:${path}`);
    setHeadCommitError("");
    try {
      const result = await runGitCommand({
        projectId,
        cwd: repoRoot || cwd,
        args: ["add", "--", path],
      });
      if (result.exit_code !== 0) {
        throw new Error(
          (result.stderr || result.stdout || "git add failed").trim(),
        );
      }
      setReloadCounter((n) => n + 1);
    } catch (err) {
      setHeadCommitError(`${err ?? "Unable to add untracked file."}`);
    } finally {
      setHeadStatusAction("");
    }
  };

  const ignoreUntrackedFile = async (path: string) => {
    if (!projectId) return;
    setHeadStatusAction(`ignore:${path}`);
    setHeadCommitError("");
    try {
      const script =
        'touch .gitignore\nif ! grep -Fqx -- "$1" .gitignore; then printf "%s\\n" "$1" >> .gitignore; fi';
      const result = await webapp_client.project_client.exec({
        project_id: projectId,
        path: repoRoot || cwd,
        command: "bash",
        args: ["-lc", script, "cocalc-git-ignore", path],
        err_on_exit: false,
        timeout: 30,
      });
      if (result.exit_code !== 0) {
        throw new Error(
          (
            result.stderr ||
            result.stdout ||
            "unable to update .gitignore"
          ).trim(),
        );
      }
      setReloadCounter((n) => n + 1);
    } catch (err) {
      setHeadCommitError(`${err ?? "Unable to ignore untracked file."}`);
    } finally {
      setHeadStatusAction("");
    }
  };

  const projectActions = projectId
    ? redux.getProjectActions(projectId)
    : undefined;

  const openFile = async (filePath: string) => {
    if (!projectActions) return;
    try {
      await projectActions.open_file({
        path: resolveOpenPath(repoRoot || data?.repoRoot, filePath),
        foreground: true,
        explicit: true,
      });
      onClose();
    } catch (err) {
      alert_message({
        type: "error",
        message: `Unable to open file '${filePath}' (${err})`,
      });
    }
  };

  const handleDrawerScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    if (restoringScrollRef.current) return;
    persistDrawerScrollPosition(scrollStorageId, node.scrollTop);
  };

  const handleDrawerScrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setDrawerScrollParent((current) => (current === node ? current : node));
  }, []);

  const handleDrawerClose = () => {
    const node = scrollRef.current;
    if (node) {
      persistDrawerScrollPosition(scrollStorageId, node.scrollTop);
    }
    onClose();
  };

  const canGoNewer = !isHeadSelected && commitIndex > 0;
  const canGoOlder = isHeadSelected
    ? navigableGitLog.length > 0
    : commitIndex >= 0 && commitIndex < navigableGitLog.length - 1;
  const goNewer = () => {
    if (!canGoNewer) return;
    setSelectedCommit(navigableGitLog[commitIndex - 1]?.hash);
  };
  const goOlder = () => {
    if (!canGoOlder) return;
    if (isHeadSelected) {
      setSelectedCommit(navigableGitLog[0]?.hash);
      return;
    }
    setSelectedCommit(navigableGitLog[commitIndex + 1]?.hash);
  };

  const requestAgentCommit = async ({
    includeSummary,
  }: {
    includeSummary: boolean;
  }) => {
    if (!onRequestAgentTurn) {
      setHeadCommitError("No active codex thread available for this action.");
      return;
    }
    const prompt = buildAgentCommitPrompt({
      message: headCommitMessage,
      includeSummary,
    });
    setHeadCommitBusy(true);
    setHeadCommitError("");
    try {
      await onRequestAgentTurn(prompt);
      onClose();
    } catch (err) {
      setHeadCommitError(`${err ?? "Unable to send commit request to codex."}`);
    } finally {
      setHeadCommitBusy(false);
    }
  };

  const doHeadCommit = async () => {
    if (!projectId) return;
    const trimmed = headCommitMessage.trim();
    if (!trimmed) {
      await requestAgentCommit({ includeSummary: false });
      return;
    }
    setHeadCommitBusy(true);
    setHeadCommitError("");
    try {
      const result = await runGitCommand({
        projectId,
        cwd: repoRoot || cwd,
        args: ["commit", "-a", "-m", headCommitMessage],
      });
      if (result.exit_code !== 0) {
        throw new Error(
          (result.stderr || result.stdout || "git commit failed").trim(),
        );
      }
      let commitHash = "";
      let subject = "";
      try {
        const latest = await runGitCommand({
          projectId,
          cwd: repoRoot || cwd,
          args: ["log", "-1", "--format=%H%x09%s"],
        });
        if (latest.exit_code === 0) {
          const [hash, ...subjectParts] = `${latest.stdout ?? ""}`
            .trim()
            .split("\t");
          commitHash = `${hash ?? ""}`.trim();
          subject = subjectParts.join("\t").trim();
        }
      } catch {
        // ignore metadata lookup errors; commit already succeeded
      }
      if (onDirectCommitLogged && commitHash) {
        try {
          await onDirectCommitLogged({ hash: commitHash, subject });
        } catch (err) {
          alert_message({
            type: "warning",
            message: `Commit created, but chat log append failed (${err})`,
          });
        }
      }
      setHeadCommitMessage("");
      refreshAll();
      alert_message({
        type: "info",
        message: (result.stdout || "Commit created successfully.").trim(),
      });
      onClose();
    } catch (err) {
      setHeadCommitError(`${err ?? "Unable to create commit."}`);
    } finally {
      setHeadCommitBusy(false);
    }
  };
  const bumpContext = (delta: -1 | 1) => {
    const idx = CONTEXT_OPTIONS.findIndex((opt) => opt.value === contextLines);
    const nextIdx = Math.max(
      0,
      Math.min(CONTEXT_OPTIONS.length - 1, idx + delta),
    );
    const next = CONTEXT_OPTIONS[nextIdx]?.value;
    if (next && next !== contextLines) {
      const node = scrollRef.current;
      pendingScrollRestoreRef.current = node?.scrollTop ?? null;
      pendingContextAnchorRef.current = node
        ? (captureGitDiffScrollAnchor(node) ?? null)
        : null;
      setContextLines(next);
    }
  };
  const canFindInChat = typeof onFindInChat === "function";
  const findInChatEnabled = canFindInChat && Boolean(commit) && !isHeadSelected;
  const currentReviewCommit = useMemo(
    () => normalizeCommitSha(commit),
    [commit],
  );
  const hasTrackedHeadChanges = useMemo(
    () => headStatusEntries.some((entry) => entry.tracked),
    [headStatusEntries],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if (
        shouldCaptureGitDrawerFindShortcut({
          key: evt.key,
          altKey: evt.altKey,
          ctrlKey: evt.ctrlKey,
          metaKey: evt.metaKey,
          target: evt.target,
          activeElement: document.activeElement,
        })
      ) {
        evt.preventDefault();
        diffFindInputRef.current?.focus?.();
        return;
      }
      if (
        isEditableEventTarget(evt.target) ||
        isEditableEventTarget(document.activeElement)
      ) {
        return;
      }
      const scrollCommand = matchGitDrawerScrollCommand(evt);
      if (scrollCommand) {
        const node = scrollRef.current;
        if (node && runGitDrawerScrollCommand(node, scrollCommand)) {
          evt.preventDefault();
          persistDrawerScrollPosition(scrollStorageId, node.scrollTop);
        }
        return;
      }
      if (evt.altKey || evt.ctrlKey || evt.metaKey) return;
      if (evt.key === "/") {
        evt.preventDefault();
        diffFindInputRef.current?.focus?.();
        return;
      }
      if (evt.key === "j") {
        evt.preventDefault();
        if (canGoOlder) {
          if (isHeadSelected) {
            setSelectedCommit(navigableGitLog[0]?.hash);
          } else {
            setSelectedCommit(navigableGitLog[commitIndex + 1]?.hash);
          }
        }
        return;
      }
      if (evt.key === "k") {
        evt.preventDefault();
        if (canGoNewer) {
          setSelectedCommit(navigableGitLog[commitIndex - 1]?.hash);
        }
        return;
      }
      if (evt.key === "[") {
        evt.preventDefault();
        bumpContext(-1);
        return;
      }
      if (evt.key === "]") {
        evt.preventDefault();
        bumpContext(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    open,
    canGoOlder,
    canGoNewer,
    commitIndex,
    diffFindInputRef,
    navigableGitLog,
    contextLines,
    isHeadSelected,
    scrollStorageId,
  ]);

  return (
    <Drawer
      title={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            flexWrap: "wrap",
          }}
        >
          {!nonRepoError ? (
            <>
              <Select
                showSearch
                size="small"
                value={commit}
                searchValue={commitSearch}
                options={logOptions}
                onChange={handleCommitChange}
                onSearch={handleCommitSearch}
                placeholder="git log"
                style={{ minWidth: 280, flex: "1 1 360px", maxWidth: 620 }}
                optionFilterProp="search"
              />
              <Checkbox
                checked={showOnlyUnreviewedCommits}
                onChange={(evt) =>
                  setShowOnlyUnreviewedCommits(evt.target.checked)
                }
                style={{ whiteSpace: "nowrap" }}
              >
                Only unreviewed
              </Checkbox>
              <Space.Compact size="small">
                <Input
                  ref={diffFindInputRef}
                  size="small"
                  allowClear
                  value={diffFindQuery}
                  placeholder="Find in diff"
                  style={{ width: 220 }}
                  onChange={(evt) => setDiffFindQuery(evt.target.value)}
                  onPressEnter={(evt) => {
                    if ((evt as any)?.shiftKey) {
                      goToPreviousDiffFindMatch();
                    } else {
                      goToNextDiffFindMatch();
                    }
                  }}
                />
                <Button
                  size="small"
                  disabled={diffFindMatches.length === 0}
                  onClick={goToPreviousDiffFindMatch}
                >
                  Prev
                </Button>
                <Button
                  size="small"
                  disabled={diffFindMatches.length === 0}
                  onClick={goToNextDiffFindMatch}
                >
                  Next
                </Button>
              </Space.Compact>
              {diffFindQuery.trim() ? (
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, whiteSpace: "nowrap" }}
                >
                  {diffFindMatches.length === 0
                    ? "0 matches"
                    : `${activeDiffFindMatchIndex + 1} / ${diffFindMatches.length}`}
                </Typography.Text>
              ) : null}
              <Space.Compact size="small">
                <Tooltip title="Newer commit (shortcut: k)">
                  <span style={{ display: "inline-flex" }}>
                    <Button
                      size="small"
                      onClick={goNewer}
                      disabled={!canGoNewer}
                    >
                      Newer
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="Older commit (shortcut: j)">
                  <span style={{ display: "inline-flex" }}>
                    <Button
                      size="small"
                      onClick={goOlder}
                      disabled={!canGoOlder}
                    >
                      Older
                    </Button>
                  </span>
                </Tooltip>
              </Space.Compact>
              {canFindInChat ? (
                <Button
                  size="small"
                  disabled={!findInChatEnabled}
                  onClick={() => {
                    if (!commit || !onFindInChat) return;
                    void onFindInChat(commit);
                  }}
                >
                  Find in chat
                </Button>
              ) : null}
            </>
          ) : (
            <Typography.Text strong style={{ marginRight: "auto" }}>
              Git browser
            </Typography.Text>
          )}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginLeft: "auto",
            }}
          >
            <Tooltip title="Context lines around changes. Shortcuts: [ decrease, ] increase">
              <Select
                size="small"
                value={contextLines}
                options={CONTEXT_OPTIONS}
                onChange={(value) => {
                  const node = scrollRef.current;
                  pendingScrollRestoreRef.current = node?.scrollTop ?? null;
                  pendingContextAnchorRef.current = node
                    ? (captureGitDiffScrollAnchor(node) ?? null)
                    : null;
                  setContextLines(value);
                }}
                style={{ width: 120 }}
              />
            </Tooltip>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: reviewMenuItems,
                onClick: handleReviewMenuClick,
              }}
            >
              <Button
                size="small"
                loading={reviewTransferBusy}
                icon={<Icon name="ellipsis" />}
                aria-label="Review actions"
              />
            </Dropdown>
          </div>
        </div>
      }
      placement="right"
      size={drawerSize}
      resizable={{
        onResize: (value) => {
          const next = clampDrawerSize(value);
          setDrawerSize(next);
          persistDrawerSize(next);
        },
      }}
      open={open}
      onClose={handleDrawerClose}
      destroyOnHidden
      styles={{ body: { padding: 0, overflow: "hidden" } }}
    >
      <Modal
        open={reviewDeleteAllOpen}
        title="Delete all git reviews?"
        destroyOnHidden
        okText="Delete all reviews"
        okButtonProps={{
          danger: true,
          disabled:
            reviewTransferBusy ||
            reviewDeleteAllConfirmValue.trim().toLowerCase() !==
              DELETE_ALL_REVIEWS_CONFIRM_TEXT,
        }}
        cancelButtonProps={{ disabled: reviewTransferBusy }}
        confirmLoading={reviewTransferBusy}
        onCancel={() => {
          if (reviewTransferBusy) return;
          setReviewDeleteAllOpen(false);
          setReviewDeleteAllConfirmValue("");
        }}
        onOk={() => {
          void deleteAllReviewData();
        }}
      >
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text>
            This will permanently delete all of your saved git review notes,
            review status, and inline review comments on this CoCalc server.
          </Typography.Text>
          <Typography.Text type="secondary">
            Type <code>{DELETE_ALL_REVIEWS_CONFIRM_TEXT}</code> to confirm.
          </Typography.Text>
          <Input
            value={reviewDeleteAllConfirmValue}
            autoFocus
            placeholder={DELETE_ALL_REVIEWS_CONFIRM_TEXT}
            onChange={(evt) => setReviewDeleteAllConfirmValue(evt.target.value)}
            onPressEnter={() => {
              if (
                reviewTransferBusy ||
                reviewDeleteAllConfirmValue.trim().toLowerCase() !==
                  DELETE_ALL_REVIEWS_CONFIRM_TEXT
              ) {
                return;
              }
              void deleteAllReviewData();
            }}
          />
        </Space>
      </Modal>
      <input
        ref={reviewImportInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(evt) => {
          const file = evt.currentTarget.files?.[0] ?? null;
          evt.currentTarget.value = "";
          void importReviewData(file);
        }}
      />
      <div
        ref={handleDrawerScrollRef}
        onScroll={handleDrawerScroll}
        style={{
          height: "100%",
          overflowY: "auto",
          padding: "16px 16px 20px 16px",
        }}
      >
        {gitLogError ? (
          <Alert
            type="warning"
            title={gitLogError}
            showIcon
            style={{ marginBottom: 10 }}
          />
        ) : null}
        {nonRepoError ? (
          <div
            style={{
              border: `1px solid ${CARD_BORDER_COLOR}`,
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
              background: "#fff",
              boxShadow: CARD_SHADOW,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <Typography.Text strong>
              This folder is not a git repository.
            </Typography.Text>
            <Typography.Text
              type="secondary"
              style={{ whiteSpace: "pre-wrap" }}
            >
              {nonRepoError}
            </Typography.Text>
            <Typography.Text type="secondary">
              Path: <code>{cwd}</code>
            </Typography.Text>
            <Space wrap>
              <Button
                type="primary"
                onClick={() => void initializeGitRepo()}
                loading={repoBootstrapBusy}
              >
                Initialize Git Repo
              </Button>
              <Button
                onClick={() => void requestAgentRepoSetup()}
                disabled={!onRequestAgentTurn}
                loading={repoBootstrapBusy}
              >
                Ask Agent to Set Up Repo
              </Button>
            </Space>
          </div>
        ) : isHeadSelected ? (
          <div
            style={{
              border: `1px solid ${CARD_BORDER_COLOR}`,
              borderRadius: 8,
              borderLeft: `4px solid ${COLORS.BLUE}`,
              padding: 12,
              marginBottom: 12,
              background: "#fff",
              boxShadow: CARD_SHADOW,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ fontWeight: 600 }}>Commit changes</div>
            <Input.TextArea
              value={headCommitMessage}
              disabled={headCommitBusy}
              placeholder="or leave blank to let the agent write the message"
              autoSize={{ minRows: 2, maxRows: 6 }}
              onChange={(e) => setHeadCommitMessage(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                size="small"
                type="primary"
                onClick={() =>
                  void requestAgentCommit({ includeSummary: true })
                }
                disabled={headCommitBusy || !hasTrackedHeadChanges}
              >
                Commit with AI Summary
              </Button>
              <Button
                size="small"
                onClick={() => void doHeadCommit()}
                disabled={!hasTrackedHeadChanges}
              >
                Commit
              </Button>
              <Button
                size="small"
                onClick={() => setHeadCommitMessage("")}
                disabled={headCommitBusy || headCommitMessage.length === 0}
              >
                Clear
              </Button>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Commit uses all tracked changes only (`git commit -a`). Untracked
              files are excluded.
            </Typography.Text>
            {!hasTrackedHeadChanges ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                No tracked changes are currently available for one-click commit.
              </Typography.Text>
            ) : null}
            {headCommitError ? (
              <Alert type="error" showIcon title={headCommitError} />
            ) : null}

            <div style={{ fontWeight: 600 }}>Uncommitted files</div>
            {headStatusError ? (
              <Alert type="warning" showIcon title={headStatusError} />
            ) : null}
            {headStatusLoading ? (
              <div style={{ padding: "12px 0", textAlign: "center" }}>
                <Spin size="small" />
              </div>
            ) : null}
            {!headStatusLoading && headStatusEntries.length === 0 ? (
              <Typography.Text type="secondary">
                No uncommitted changes.
              </Typography.Text>
            ) : null}
            {!headStatusLoading && headStatusEntries.length > 0
              ? headStatusEntries.map((entry) => {
                  return (
                    <div
                      key={`${entry.statusCode}:${entry.path}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        border: `1px solid ${COLORS.GRAY_LL}`,
                        borderRadius: 6,
                        padding: "6px 8px",
                      }}
                    >
                      <div
                        style={{
                          minWidth: 0,
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <Button
                          type="link"
                          size="small"
                          style={{ padding: 0, fontFamily: "monospace" }}
                          onClick={() => void openFile(entry.path)}
                        >
                          {entry.displayPath}
                        </Button>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 11 }}
                        >
                          {entry.statusLabel}
                          {!entry.tracked ? " (not included by Commit)" : ""}
                        </Typography.Text>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <Typography.Text code style={{ marginBottom: 0 }}>
                          {entry.statusCode}
                        </Typography.Text>
                        {!entry.tracked ? (
                          <Space.Compact size="small">
                            <Button
                              size="small"
                              onClick={() => void addUntrackedFile(entry.path)}
                              loading={headStatusAction === `add:${entry.path}`}
                              disabled={Boolean(headStatusAction)}
                            >
                              Add
                            </Button>
                            <Button
                              size="small"
                              onClick={() =>
                                void ignoreUntrackedFile(entry.path)
                              }
                              loading={
                                headStatusAction === `ignore:${entry.path}`
                              }
                              disabled={Boolean(headStatusAction)}
                            >
                              Ignore
                            </Button>
                          </Space.Compact>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              : null}
          </div>
        ) : (
          <div
            style={{
              border: `1px solid ${CARD_BORDER_COLOR}`,
              borderRadius: 8,
              borderLeft: `4px solid ${COLORS.BLUE}`,
              padding: 12,
              marginBottom: 12,
              background: "#fff",
              boxShadow: CARD_SHADOW,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 10,
                marginBottom: 8,
                flexWrap: "wrap",
                overflow: "visible",
              }}
            >
              <Checkbox
                checked={reviewed}
                disabled={
                  reviewLoading || reviewSaving || !commit || isHeadSelected
                }
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  alignSelf: "flex-start",
                  minHeight: 22,
                  lineHeight: "20px",
                }}
                onChange={(e) => {
                  const next = e.target.checked;
                  setReviewed(next);
                  setReviewDirty(true);
                  void saveReview({ reviewed: next });
                }}
              >
                <span style={{ fontWeight: 600 }}>Reviewed</span>
              </Checkbox>
              <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
                <Space size={8} align="center">
                  {resolvedInlineCount > 0 ? (
                    <>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12 }}
                      >
                        Show resolved
                      </Typography.Text>
                      <Switch
                        size="small"
                        checked={showResolvedComments}
                        onChange={setShowResolvedComments}
                      />
                    </>
                  ) : null}
                  <span>
                    {reviewSaving ? "Saving..." : null}
                    {!reviewSaving && reviewUpdatedAt ? (
                      <>
                        Updated <TimeAgo date={new Date(reviewUpdatedAt)} />
                      </>
                    ) : null}
                  </span>
                </Space>
              </div>
            </div>
            {reviewNoteEditing ? (
              <ReviewNoteEditor
                historyId={`git-review-note:${reviewStateCommit ?? currentReviewCommit ?? "none"}`}
                key={`git-review-note-edit:${reviewStateCommit ?? currentReviewCommit ?? "none"}`}
                value={reviewNoteDraft}
                committedValue={reviewNote}
                fontSize={fontSize}
                saving={reviewSaving}
                disabled={
                  reviewLoading || isHeadSelected || !currentReviewCommit
                }
                onPersistDraft={(value) => {
                  if (reviewLoading || isHeadSelected || !currentReviewCommit)
                    return;
                  if (activeReviewCommitRef.current !== currentReviewCommit)
                    return;
                  setReviewNoteDraft(value);
                  setReviewDirty(true);
                  saveReviewDraft(currentReviewCommit, {
                    reviewed: Boolean(reviewed),
                    note: `${value ?? ""}`,
                    comments: reviewRecord?.comments ?? {},
                  });
                }}
                onCancel={() => {
                  setReviewNoteDraft(reviewNote);
                  setReviewNoteEditing(false);
                }}
                onSave={(nextNote) => {
                  if (!currentReviewCommit) return;
                  setReviewNote(nextNote);
                  setReviewNoteDraft(nextNote);
                  setReviewDirty(true);
                  setReviewNoteEditing(false);
                  void saveReview({ note: nextNote, reviewed });
                }}
              />
            ) : (
              <div
                style={{
                  border: `1px solid ${COLORS.GRAY_LL}`,
                  borderRadius: 6,
                  padding: "8px 10px",
                  background: "#fff",
                  minHeight: 40,
                }}
              >
                {reviewNote?.trim() ? (
                  <StaticMarkdown
                    value={reviewNote}
                    style={{ fontSize: Math.max(13, fontSize) }}
                    editorTheme={editorTheme}
                  />
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    No private review note yet.
                  </Typography.Text>
                )}
              </div>
            )}
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, marginTop: 6 }}
            >
              This note and the Reviewed checkbox are private state only. They
              are not sent to the agent.
            </Typography.Text>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
                {reviewError ||
                  (reviewLoading ? "Loading review state..." : "")}
                {!reviewError && !reviewLoading && inlineComments.length > 0
                  ? ` · ${inlineComments.length} inline comments`
                  : ""}
              </div>
              {!reviewNoteEditing ? (
                <Button
                  size="small"
                  disabled={
                    reviewSaving || !currentReviewCommit || isHeadSelected
                  }
                  onClick={() => {
                    setReviewNoteDraft(reviewNote);
                    setReviewNoteEditing(true);
                  }}
                >
                  Edit
                </Button>
              ) : null}
            </div>
            <div
              style={{
                marginTop: 8,
                border: `1px solid ${COLORS.GRAY_LL}`,
                borderRadius: 6,
                background: "#fff",
                padding: "8px 10px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Send only draft inline diff comments (created with the{" "}
                <code>+</code> buttons in the patch below).
              </Typography.Text>
              <Space.Compact size="small">
                <Button
                  size="small"
                  type="primary"
                  disabled={
                    actionableInlineComments.length === 0 ||
                    reviewSubmitBusy ||
                    reviewSaving ||
                    !onRequestAgentTurn
                  }
                  loading={reviewSubmitBusy}
                  onClick={() => void sendInlineReviewToAgent()}
                >
                  {`Send inline comments to agent${
                    actionableInlineComments.length > 0
                      ? ` (${actionableInlineComments.length})`
                      : ""
                  }`}
                </Button>
              </Space.Compact>
            </div>
          </div>
        )}
        {loading ? (
          <div style={{ padding: "32px 0", textAlign: "center" }}>
            <Spin />
          </div>
        ) : null}
        {!loading && error ? (
          <Alert
            type="error"
            title={error}
            showIcon
            style={{ marginBottom: 12 }}
          />
        ) : null}
        {!loading && !error && data ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {data.summaryLines.length
              ? (() => {
                  const summary = data.summary;
                  const rows: Array<{
                    label: string;
                    value?: string;
                    asDate?: boolean;
                    monospace?: boolean;
                  }> = [
                    {
                      label: "Commit",
                      value:
                        summary.commit ??
                        (isHeadSelected ? HEAD_REF : (commit ?? "")),
                      monospace: true,
                    },
                    { label: "Author", value: summary.author },
                    {
                      label: "Author Date",
                      value: summary.authorDate,
                      asDate: true,
                    },
                    { label: "Committer", value: summary.committer },
                    {
                      label: "Commit Date",
                      value: summary.commitDate,
                      asDate: true,
                    },
                  ].filter((row) => Boolean(`${row.value ?? ""}`.trim()));
                  const commitMessage = splitCommitMessage(summary.message);
                  return (
                    <div
                      style={{
                        border: `1px solid ${CARD_BORDER_COLOR}`,
                        borderRadius: 8,
                        borderLeft: `4px solid ${COLORS.BLUE}`,
                        padding: "10px 12px",
                        background: "#fff",
                        boxShadow: CARD_SHADOW,
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      <Typography.Text strong style={{ fontSize: 13 }}>
                        Commit details
                      </Typography.Text>
                      {rows.length ? (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "120px 1fr",
                            columnGap: 12,
                            rowGap: 6,
                          }}
                        >
                          {rows.map((row) => (
                            <div
                              key={`${row.label}:${row.value ?? ""}`}
                              style={{ display: "contents" }}
                            >
                              <Typography.Text
                                type="secondary"
                                style={{ fontSize: 12 }}
                              >
                                {row.label}
                              </Typography.Text>
                              <Typography.Text
                                style={{
                                  fontSize: 12,
                                  fontFamily: row.monospace
                                    ? "monospace"
                                    : undefined,
                                  overflowWrap: "anywhere",
                                }}
                              >
                                {row.asDate
                                  ? (() => {
                                      const parsed = parseDateSafe(row.value);
                                      return parsed ? (
                                        <TimeAgo date={parsed} />
                                      ) : (
                                        row.value
                                      );
                                    })()
                                  : row.value}
                              </Typography.Text>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {summary.message ? (
                        <div
                          style={{
                            borderTop: `1px solid ${COLORS.GRAY_LL}`,
                            paddingTop: 10,
                            display: "flex",
                            flexDirection: "column",
                            gap: commitMessage.body ? 8 : 0,
                          }}
                        >
                          {commitMessage.subject ? (
                            <Typography.Text
                              strong
                              style={{
                                fontSize: Math.max(13, fontSize),
                                lineHeight: 1.55,
                                overflowWrap: "anywhere",
                              }}
                            >
                              {commitMessage.subject}
                            </Typography.Text>
                          ) : null}
                          {commitMessage.body ? (
                            <StaticMarkdown
                              value={
                                isMergeCommitSummary(summary)
                                  ? (formatMergeCommitBodyMarkdown(
                                      commitMessage.body,
                                    ) ?? commitMessage.body)
                                  : commitMessage.body
                              }
                              style={{
                                fontSize: Math.max(13, fontSize),
                                lineHeight: 1.55,
                              }}
                              editorTheme={editorTheme}
                            />
                          ) : null}
                        </div>
                      ) : summary.extraHeaderLines.length ? (
                        <Typography.Paragraph
                          style={{
                            marginBottom: 0,
                            fontFamily: "monospace",
                            whiteSpace: "pre-wrap",
                            fontSize: Math.max(11, fontSize - 1),
                          }}
                        >
                          {summary.extraHeaderLines.join("\n")}
                        </Typography.Paragraph>
                      ) : null}
                    </div>
                  );
                })()
              : null}
            {data.files.length === 0 ? (
              <Empty description="No file changes in this commit." />
            ) : (
              <>
                <div
                  style={{
                    marginBottom: 18,
                    padding: "10px 12px",
                    border: `1px solid ${CARD_BORDER_COLOR}`,
                    borderRadius: 10,
                    background: "white",
                    boxShadow: CARD_SHADOW,
                  }}
                >
                  <Typography.Text
                    strong
                    style={{ display: "block", marginBottom: 10 }}
                  >
                    Changed files
                  </Typography.Text>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    {data.files.map((file, idx) => {
                      const sectionId = buildGitReviewFileSectionId(
                        file.path,
                        idx,
                      );
                      const fileComments =
                        inlineCommentsByFile.get(file.path) ??
                        EMPTY_GIT_REVIEW_COMMENTS;
                      return (
                        <Button
                          key={`file-index-${sectionId}`}
                          size="small"
                          style={{
                            fontFamily: "monospace",
                            maxWidth: "100%",
                          }}
                          onClick={() => scrollToDiffFile(idx)}
                        >
                          {file.path}
                          {fileComments.length > 0
                            ? ` (${fileComments.length})`
                            : ""}
                        </Button>
                      );
                    })}
                  </div>
                </div>
                <Virtuoso
                  ref={virtuosoRef}
                  customScrollParent={drawerScrollParent ?? undefined}
                  data={data.files}
                  computeItemKey={(idx, file) =>
                    buildGitReviewFileSectionId(file.path, idx)
                  }
                  increaseViewportBy={1200}
                  itemContent={(idx, file) => {
                    const sectionId = buildGitReviewFileSectionId(
                      file.path,
                      idx,
                    );
                    const fileComments =
                      inlineCommentsByFile.get(file.path) ??
                      EMPTY_GIT_REVIEW_COMMENTS;
                    return (
                      <DiffFileSection
                        file={file}
                        index={idx}
                        fontSize={fontSize}
                        editorTheme={editorTheme}
                        fileComments={fileComments}
                        showResolvedComments={showResolvedComments}
                        isHeadSelected={isHeadSelected}
                        visibleLineLimit={getRenderedDiffLineLimit(
                          visibleDiffLinesByFile[sectionId],
                        )}
                        onOpenFile={openFile}
                        onShowMoreLines={(nextSectionId) => {
                          setVisibleDiffLinesByFile((prev) => ({
                            ...prev,
                            [nextSectionId]: getNextRenderedDiffLineLimit(
                              prev[nextSectionId],
                            ),
                          }));
                        }}
                        activeDraftAnchorId={activeDraftAnchorId}
                        activeDraftBody={activeInlineDraftBody}
                        activeEditingId={activeInlineEditId}
                        activeEditingBody={activeInlineEditBody}
                        pendingKey={inlineCommentPendingKey}
                        onOpenDraft={openInlineDraft}
                        onDraftBodyChange={setActiveInlineDraftBody}
                        onCancelDraft={cancelInlineDraft}
                        onOpenEdit={openInlineEdit}
                        onEditingBodyChange={setActiveInlineEditBody}
                        onCancelEdit={cancelInlineEdit}
                        onCreateComment={submitInlineDraft}
                        onUpdateComment={submitInlineEdit}
                        onResolveComment={handleResolveInlineComment}
                        onReopenComment={handleReopenInlineComment}
                        matchedFindCount={diffFindMeta.counts.get(idx) ?? 0}
                        matchedLineIndexes={diffFindMeta.matchedLineIndexes.get(
                          idx,
                        )}
                        activeFindMatchKind={
                          activeDiffFindMatch?.fileIndex === idx
                            ? activeDiffFindMatch.kind
                            : undefined
                        }
                        activeFindLineIndex={
                          activeDiffFindMatch?.fileIndex === idx
                            ? activeDiffFindMatch.lineIndex
                            : undefined
                        }
                      />
                    );
                  }}
                />
              </>
            )}
            {data.linesTruncated ? (
              <Alert
                type="warning"
                showIcon
                title={`Showing first ${MAX_GIT_SHOW_LINES.toLocaleString()} lines (${data.shownLineCount.toLocaleString()} loaded of ${data.originalLineCount.toLocaleString()}).`}
                description={
                  <span>
                    Output was truncated for UI performance. Use terminal for
                    full output, e.g.{" "}
                    <code>
                      {isHeadSelected
                        ? `git diff --no-color -U${contextLines} HEAD | less`
                        : `git show --no-color -U${contextLines} ${commit} | less`}
                    </code>
                    .
                  </span>
                }
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
