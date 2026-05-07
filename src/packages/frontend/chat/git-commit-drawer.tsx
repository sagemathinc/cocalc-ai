/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Checkbox, Drawer, Spin, Alert, type MenuProps } from "antd";
import { useEffectiveEditorThemeForPath } from "@cocalc/frontend/project/workspaces/use-effective-editor-theme";
import type {
  CommentAnchor,
  GitDiffScrollAnchor,
  GitLogEntry,
  GitShowParsed,
  HeadStatusEntry,
} from "./git-commit/types";
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
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { containingPath } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import {
  deleteAllReviewRecords,
  exportReviewBundle,
  importReviewBundle,
  loadReviewRecord,
  loadReviewDraft,
  mergeRecordWithDraft,
  type GitReviewCommentV2,
  normalizeCommitSha,
  saveReviewDraft,
  saveReviewRecord,
  type GitReviewRecordV2,
} from "./git-review-store";
import { buildAgentCommitPrompt } from "./git-commit-prompt";
import {
  buildGitLogArgs,
  buildGitShowArgs,
  MAX_GIT_SHOW_LINES,
  parseGitLogOutput,
  parseGitShowOutput,
  parseGitStatusOutput,
} from "./git-commit/git-output";
import {
  filterGitReviewLogEntries,
  isHeadCommit,
  parseCommitHash,
  resolveGitCommitSearchChange,
} from "./git-commit/commit-selection";
import {
  buildGitDiffFindMatches,
  getGitDiffFindVisibleLineLimitUpdate,
  getNextRenderedDiffLineLimit,
  getRenderedDiffLineLimit,
  isGitDiffFindTargetRendered,
} from "./git-commit/diff-find";
import { DiffBlock } from "./git-commit/diff-components";
import {
  commentAnchorKey,
  diffLineNumberColumnWidth,
  makeCommentId,
} from "./git-commit/diff-lines";
import {
  clampDrawerSize,
  persistDrawerScrollPosition,
  persistDrawerSize,
  readDrawerScrollPosition,
  readDrawerSize,
} from "./git-commit/drawer-storage";
import {
  buildGitReviewFileSectionId,
  buildGitReviewLineElementId,
  hashGitCommitValue,
} from "./git-commit/ids";
import {
  applySubmittedGitReviewComments,
  resolveGitReviewLoadFailure,
  resolveGitReviewSaveCompletion,
  resolveGitReviewSaveState,
  shouldClearGitInlinePendingKey,
  shouldClearGitReviewSavingOnScopeChange,
  shouldClearGitReviewSubmitOnScopeChange,
} from "./git-commit/review-state";
import {
  buildGitInlineDraftEditorId,
  buildGitInlineEditEditorId,
  buildGitReviewEditorScope,
  buildGitReviewNoteEditorId,
  MarkdownHistoryInput,
  ReviewNoteEditor,
} from "./git-commit/review-editors";
import {
  GIT_DIFF_LIST_FOOTER_SPACER_HEIGHT,
  DeleteAllReviewsModal,
  GitChangedFilesPanel,
  GitCommitDetailsPanel,
  GitCommitDrawerTitle,
  GitDiffFilesPanel,
  GitDiffListFooterSpacer,
  GitEmptyCommitDiff,
  GitHeadCommitPanel,
  GitRepoBootstrapPanel,
  GitReviewPanel,
} from "./git-commit/drawer-sections";
import {
  captureGitDiffScrollAnchor,
  matchGitDrawerScrollCommand,
  restoreGitDiffScrollAnchor,
  runGitDrawerScrollCommand,
  scrollGitDrawerElementIntoView,
} from "./git-commit/drawer-scroll";
import {
  formatMergeCommitBodyMarkdown,
  getCommitReviewIndicatorState,
  isEditableEventTarget,
  isMergeCommitSummary,
  isNotGitRepoError,
  resolveOpenPath,
  shouldApplyGitFileOpenScopedResult,
  shouldApplyGitRepoBootstrapScopedResult,
  shouldDisableGitReviewSubmission,
  shouldClearGitHeadCommitBusyOnScopeChange,
  shouldClearGitHeadStatusActionOnScopeChange,
  shouldClearGitRepoBootstrapBusyOnScopeChange,
  shouldFinalizeGitFileOpenAction,
  shouldFinalizeGitRepoBootstrapAction,
  shouldCaptureGitDrawerFindShortcut,
} from "./git-commit/utils";
import "./git-commit-drawer.css";
import type { ReactNode } from "react";
import type { VirtuosoHandle } from "react-virtuoso";

export { buildGitLogArgs, buildGitShowArgs };
export {
  buildGitDiffFindMatches,
  buildGitReviewFileSectionId,
  buildGitReviewLineElementId,
  captureGitDiffScrollAnchor,
  commentAnchorKey,
  diffLineNumberColumnWidth,
  DiffBlock,
  getGitDiffFindVisibleLineLimitUpdate,
  getNextRenderedDiffLineLimit,
  getRenderedDiffLineLimit,
  isGitDiffFindTargetRendered,
  MarkdownHistoryInput,
  matchGitDrawerScrollCommand,
  ReviewNoteEditor,
  restoreGitDiffScrollAnchor,
  runGitDrawerScrollCommand,
  scrollGitDrawerElementIntoView,
};
export { filterGitReviewLogEntries, resolveGitCommitSearchChange };
export {
  applySubmittedGitReviewComments,
  resolveGitReviewLoadFailure,
  resolveGitReviewSaveCompletion,
  resolveGitReviewSaveState,
  shouldClearGitInlinePendingKey,
  shouldClearGitReviewSavingOnScopeChange,
  shouldClearGitReviewSubmitOnScopeChange,
};
export {
  buildGitInlineDraftEditorId,
  buildGitInlineEditEditorId,
  buildGitReviewEditorScope,
  buildGitReviewNoteEditorId,
  GIT_DIFF_LIST_FOOTER_SPACER_HEIGHT,
  formatMergeCommitBodyMarkdown,
  GitDiffFilesPanel,
  GitDiffListFooterSpacer,
  getCommitReviewIndicatorState,
  isMergeCommitSummary,
  shouldApplyGitFileOpenScopedResult,
  shouldApplyGitRepoBootstrapScopedResult,
  shouldDisableGitReviewSubmission,
  shouldClearGitHeadCommitBusyOnScopeChange,
  shouldClearGitHeadStatusActionOnScopeChange,
  shouldClearGitRepoBootstrapBusyOnScopeChange,
  shouldFinalizeGitFileOpenAction,
  shouldFinalizeGitRepoBootstrapAction,
  shouldCaptureGitDrawerFindShortcut,
};

export function shouldRefreshGitReviewStateOnReconnect(opts: {
  open: boolean;
  accountId?: string | null;
  commit?: string;
  reviewLoading: boolean;
  reviewSaving: boolean;
}): boolean {
  if (!opts.open || opts.reviewLoading || opts.reviewSaving) {
    return false;
  }
  if (!opts.accountId) {
    return false;
  }
  if (isHeadCommit(opts.commit)) {
    return false;
  }
  return normalizeCommitSha(opts.commit) != null;
}

const MAX_GIT_SHOW_OUTPUT_BYTES = 4_000_000;
const HEAD_REF = "HEAD";
const DEFAULT_CONTEXT_LINES = 3;
const GIT_LOG_WINDOW_SIZE = 250;
const CONTEXT_OPTIONS = [3, 10, 30].map((value) => ({
  value,
  label: `Context ${value}`,
}));
const DELETE_ALL_REVIEWS_CONFIRM_TEXT = "delete all";

interface GitCommitDrawerProps {
  projectId?: string;
  sourcePath?: string;
  cwdOverride?: string;
  commitHash?: string;
  commitSelectionRequestToken?: number;
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
  reviewSubmissionHelpText?: ReactNode;
}

export function resolveIncomingGitCommitSelection({
  open,
  currentSelectedCommit,
  incomingCommit,
  requestTokenChanged,
}: {
  open: boolean;
  currentSelectedCommit?: string;
  incomingCommit?: string;
  requestTokenChanged: boolean;
}): string | undefined {
  if (!open) {
    return currentSelectedCommit;
  }
  if (!requestTokenChanged && incomingCommit === currentSelectedCommit) {
    return currentSelectedCommit;
  }
  return incomingCommit;
}

export function applyGitReviewedByCommitEntries({
  previous,
  entries,
}: {
  previous: Record<string, boolean>;
  entries: readonly (readonly [
    string,
    Pick<GitReviewRecordV2, "reviewed"> | undefined,
  ])[];
}): Record<string, boolean> {
  const next = { ...previous };
  for (const [hash, record] of entries) {
    if (record == null) {
      delete next[hash];
      continue;
    }
    next[hash] = Boolean(record.reviewed);
  }
  return next;
}

export function applyGitReviewedByCommitResetEntry({
  previous,
  commitSha,
  draftReviewed,
}: {
  previous: Record<string, boolean>;
  commitSha: string;
  draftReviewed?: boolean;
}): Record<string, boolean> {
  if (typeof draftReviewed !== "boolean") {
    return previous;
  }
  if (
    Object.prototype.hasOwnProperty.call(previous, commitSha) &&
    previous[commitSha] === draftReviewed
  ) {
    return previous;
  }
  return {
    ...previous,
    [commitSha]: draftReviewed,
  };
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

export function GitCommitDrawer({
  projectId,
  sourcePath,
  cwdOverride,
  commitHash,
  commitSelectionRequestToken = 0,
  open,
  onClose,
  fontSize = 14,
  onRequestAgentTurn,
  onDirectCommitLogged,
  onFindInChat,
  onOpenActivityLog,
  reviewSubmissionHelpText,
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
  const commitSelectionRequestTokenRef = useRef(commitSelectionRequestToken);
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
  const reviewScopeRef = useRef<string | undefined>(undefined);
  const reviewSubmitTokenRef = useRef(0);
  const reviewSubmitScopeRef = useRef<string | undefined>(undefined);
  const headScopeRef = useRef<string | undefined>(undefined);
  const headCommitActionTokenRef = useRef(0);
  const headCommitActionScopeRef = useRef<string | undefined>(undefined);
  const headStatusActionTokenRef = useRef(0);
  const headStatusActionScopeRef = useRef<string | undefined>(undefined);
  const repoBootstrapScopeRef = useRef<string | undefined>(undefined);
  const repoBootstrapActionTokenRef = useRef(0);
  const repoBootstrapActionScopeRef = useRef<string | undefined>(undefined);
  const reviewNoteDraftRef = useRef(reviewNoteDraft);
  const reviewedRef = useRef(reviewed);
  const preserveCommitSearchOnAutoClearRef = useRef(false);
  const reviewImportInputRef = useRef<HTMLInputElement | null>(null);
  const diffFindInputRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const drawerViewSessionEpochRef = useRef(0);
  const drawerViewWasOpenRef = useRef(false);
  const drawerViewScopeRef = useRef<string | undefined>(undefined);
  const openFileActionTokenRef = useRef(0);
  const openFileActionScopeRef = useRef<string | undefined>(undefined);
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
  const inlineCommentPendingKeyRef = useRef(inlineCommentPendingKey);

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

  useEffect(() => {
    inlineCommentPendingKeyRef.current = inlineCommentPendingKey;
  }, [inlineCommentPendingKey]);
  const scrollStorageId = useMemo(() => {
    const commitKey = `${commit ?? HEAD_REF}`.toLowerCase();
    const raw = `${projectId ?? "no-project"}|${sourcePath ?? ""}|${cwd}|${commitKey}`;
    return hashGitCommitValue(raw);
  }, [projectId, sourcePath, cwd, commit]);

  useEffect(() => {
    if (open && !drawerViewWasOpenRef.current) {
      drawerViewSessionEpochRef.current += 1;
    }
    drawerViewWasOpenRef.current = open;
    drawerViewScopeRef.current = open
      ? `${drawerViewSessionEpochRef.current}:${scrollStorageId}`
      : undefined;
  }, [open, scrollStorageId]);

  useEffect(() => {
    const requestTokenChanged =
      commitSelectionRequestToken !== commitSelectionRequestTokenRef.current;
    commitSelectionRequestTokenRef.current = commitSelectionRequestToken;
    setSelectedCommit((currentSelectedCommit) =>
      resolveIncomingGitCommitSelection({
        open,
        currentSelectedCommit,
        incomingCommit,
        requestTokenChanged,
      }),
    );
  }, [incomingCommit, open, commitSelectionRequestToken]);

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
    const nextScope =
      open && accountId && commit && !isHeadCommit(commit)
        ? normalizeCommitSha(commit)
        : undefined;
    const previousScope = reviewScopeRef.current;
    reviewScopeRef.current = nextScope;
    activeReviewCommitRef.current = nextScope;
    if (
      shouldClearGitReviewSavingOnScopeChange({
        reviewSaving,
        previousScope,
        nextScope,
      })
    ) {
      setReviewSaving(false);
    }
    if (
      shouldClearGitReviewSubmitOnScopeChange({
        reviewSubmitBusy,
        previousScope,
        nextScope,
      })
    ) {
      reviewSubmitTokenRef.current += 1;
      reviewSubmitScopeRef.current = undefined;
      setReviewSubmitBusy(false);
    }
  }, [open, accountId, commit, reviewSaving, reviewSubmitBusy]);

  useEffect(() => {
    const nextScope = open && isHeadSelected ? HEAD_REF : undefined;
    const previousScope = headScopeRef.current;
    headScopeRef.current = nextScope;
    if (
      shouldClearGitHeadCommitBusyOnScopeChange({
        headCommitBusy,
        previousScope,
        nextScope,
      })
    ) {
      headCommitActionTokenRef.current += 1;
      headCommitActionScopeRef.current = undefined;
      setHeadCommitBusy(false);
    }
    if (
      shouldClearGitHeadStatusActionOnScopeChange({
        headStatusAction,
        previousScope,
        nextScope,
      })
    ) {
      headStatusActionTokenRef.current += 1;
      headStatusActionScopeRef.current = undefined;
      setHeadStatusAction("");
    }
  }, [open, isHeadSelected, headCommitBusy, headStatusAction]);

  useEffect(() => {
    const nextScope = open && Boolean(nonRepoError) ? "non-repo" : undefined;
    const previousScope = repoBootstrapScopeRef.current;
    repoBootstrapScopeRef.current = nextScope;
    if (
      shouldClearGitRepoBootstrapBusyOnScopeChange({
        repoBootstrapBusy,
        previousScope,
        nextScope,
      })
    ) {
      repoBootstrapActionTokenRef.current += 1;
      repoBootstrapActionScopeRef.current = undefined;
      setRepoBootstrapBusy(false);
    }
  }, [open, nonRepoError, repoBootstrapBusy]);

  useEffect(() => {
    if (!open || !accountId) return;
    const hashes = Array.from(
      new Set(
        [...visibleLogEntries.map((entry) => entry.hash), commit].filter(
          (hash): hash is string =>
            Boolean(hash) &&
            parseCommitHash(hash) != null &&
            !isHeadCommit(hash),
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
            return [hash, rec] as const;
          }),
        );
        if (cancelled) return;
        setReviewedByCommit((prev) =>
          applyGitReviewedByCommitEntries({
            previous: prev,
            entries,
          }),
        );
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
        ? loadReviewDraft(normalizedNext, accountId)
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
        setReviewedByCommit((prev) =>
          applyGitReviewedByCommitResetEntry({
            previous: prev,
            commitSha: normalizedNext,
            draftReviewed: draft?.reviewed,
          }),
        );
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
        setReviewedByCommit((prev) =>
          applyGitReviewedByCommitEntries({
            previous: prev,
            entries: [[normalizedCommit, rec]],
          }),
        );
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
        const fallback = resolveGitReviewLoadFailure({
          draft: loadReviewDraft(normalizedCommit, accountId),
          error: err,
          accountId,
          commitSha: normalizedCommit,
        });
        setReviewError(fallback.reviewError);
        setReviewed(fallback.reviewed);
        setReviewNote(fallback.reviewNote);
        setReviewNoteDraft(fallback.reviewNoteDraft);
        setReviewNoteEditing(false);
        setReviewUpdatedAt(fallback.reviewUpdatedAt);
        setReviewDirty(false);
        setReviewRecord(fallback.reviewRecord);
      } finally {
        if (reviewLoadTokenRef.current !== token) return;
        setReviewLoading(false);
      }
    })();
  }, [open, accountId, commit, reviewReloadCounter]);

  useEffect(() => {
    if (
      !shouldRefreshGitReviewStateOnReconnect({
        open,
        accountId,
        commit,
        reviewLoading,
        reviewSaving,
      })
    ) {
      return;
    }
    const refreshReviewState = () => {
      setReviewReloadCounter((n) => n + 1);
    };
    webapp_client.conat_client.on?.("connected", refreshReviewState);
    webapp_client.on?.("signed_in", refreshReviewState);
    return () => {
      webapp_client.conat_client.removeListener?.(
        "connected",
        refreshReviewState,
      );
      webapp_client.removeListener?.("signed_in", refreshReviewState);
    };
  }, [open, accountId, commit, reviewLoading, reviewSaving]);

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
      const latestDraft = loadReviewDraft(normalizedCommit, accountId);
      const resolved = resolveGitReviewSaveState({
        next,
        draft: latestDraft,
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
        const payload = await saveReviewRecord(
          {
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
          },
          {
            clearDraftThroughRevision: latestDraft?.revision,
          },
        );
        setReviewedByCommit((prev) => ({
          ...prev,
          [normalizedCommit]: payload.reviewed,
        }));
        if (activeReviewCommitRef.current === normalizedCommit) {
          const mergedPayload =
            mergeRecordWithDraft(
              payload,
              loadReviewDraft(normalizedCommit, accountId),
            ) ?? payload;
          const completion = resolveGitReviewSaveCompletion({
            payload: mergedPayload,
            sent: sentState,
            current: {
              reviewed: reviewedRef.current,
              noteDraft: reviewNoteDraftRef.current,
            },
          });
          setReviewed(completion.reviewed);
          setReviewNote(completion.reviewNote);
          setReviewNoteDraft(completion.reviewNoteDraft);
          setReviewRecord(mergedPayload);
          setReviewUpdatedAt(mergedPayload.updated_at);
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
      const latestDraft = loadReviewDraft(normalizedCommit, accountId);
      const resolved = resolveGitReviewSaveState({
        draft: latestDraft,
        reviewed,
        reviewNote,
        reviewNoteDraft,
        reviewComments: reviewRecord?.comments,
      });
      const current = resolved.comments;
      const next = mutate({ ...current });
      saveReviewDraft(
        normalizedCommit,
        {
          reviewed: resolved.reviewed,
          note: resolved.note,
          comments: next,
        },
        accountId,
      );
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
        if (
          shouldClearGitInlinePendingKey({
            currentPendingKey: inlineCommentPendingKeyRef.current,
            actionPendingKey: key,
          })
        ) {
          setInlineCommentPendingKey("");
        }
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
      const pendingKey = `edit:${id}`;
      try {
        await updateInlineComment(id, trimmed);
        setActiveInlineEditId(undefined);
        setActiveInlineEditBody("");
      } finally {
        if (
          shouldClearGitInlinePendingKey({
            currentPendingKey: inlineCommentPendingKeyRef.current,
            actionPendingKey: pendingKey,
          })
        ) {
          setInlineCommentPendingKey("");
        }
      }
    },
    [activeInlineEditId, updateInlineComment],
  );

  const handleResolveInlineComment = useCallback(
    async (id: string) => {
      const pendingKey = `resolve:${id}`;
      setInlineCommentPendingKey(pendingKey);
      try {
        await resolveInlineComment(id);
        if (activeInlineEditId === id) {
          setActiveInlineEditId(undefined);
          setActiveInlineEditBody("");
        }
      } finally {
        if (
          shouldClearGitInlinePendingKey({
            currentPendingKey: inlineCommentPendingKeyRef.current,
            actionPendingKey: pendingKey,
          })
        ) {
          setInlineCommentPendingKey("");
        }
      }
    },
    [activeInlineEditId, resolveInlineComment],
  );

  const handleReopenInlineComment = useCallback(
    async (id: string) => {
      const pendingKey = `reopen:${id}`;
      setInlineCommentPendingKey(pendingKey);
      try {
        await reopenInlineComment(id);
        if (activeInlineEditId === id) {
          setActiveInlineEditId(undefined);
          setActiveInlineEditBody("");
        }
      } finally {
        if (
          shouldClearGitInlinePendingKey({
            currentPendingKey: inlineCommentPendingKeyRef.current,
            actionPendingKey: pendingKey,
          })
        ) {
          setInlineCommentPendingKey("");
        }
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
    const startedScope = normalizeCommitSha(commit);
    if (!startedScope) return;
    const actionable = actionableInlineComments;
    if (actionable.length === 0) return;
    const submitToken = reviewSubmitTokenRef.current + 1;
    reviewSubmitTokenRef.current = submitToken;
    reviewSubmitScopeRef.current = startedScope;
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
      const normalizedCommit = normalizeCommitSha(commit);
      const latestDraft = normalizedCommit
        ? loadReviewDraft(normalizedCommit, accountId)
        : undefined;
      const resolved = resolveGitReviewSaveState({
        draft: latestDraft,
        reviewed,
        reviewNote,
        reviewNoteDraft,
        reviewComments: reviewRecord?.comments,
      });
      const nextComments = applySubmittedGitReviewComments({
        sentComments: actionable,
        currentComments: resolved.comments,
        submittedAt: now,
        submissionTurnId: turnId,
      });
      if (commit) {
        if (normalizedCommit) {
          saveReviewDraft(
            normalizedCommit,
            {
              reviewed: resolved.reviewed,
              note: resolved.note,
              comments: nextComments,
            },
            accountId,
          );
        }
      }
      await saveReview({
        comments: nextComments,
        reviewed: resolved.reviewed,
        note: resolved.note,
        last_submitted_at: now,
        last_submission_turn_id: turnId,
      });
      if (
        reviewSubmitTokenRef.current === submitToken &&
        reviewSubmitScopeRef.current === startedScope &&
        activeReviewCommitRef.current === startedScope
      ) {
        onClose();
      }
    } catch (err) {
      if (
        reviewSubmitTokenRef.current === submitToken &&
        reviewSubmitScopeRef.current === startedScope &&
        activeReviewCommitRef.current === startedScope
      ) {
        setReviewError(`${err ?? "Unable to send review comments to codex."}`);
      }
    } finally {
      if (
        reviewSubmitTokenRef.current === submitToken &&
        reviewSubmitScopeRef.current === startedScope
      ) {
        reviewSubmitScopeRef.current = undefined;
        setReviewSubmitBusy(false);
      }
    }
  };

  useEffect(() => {
    if (!open || !accountId || !commit || isHeadCommit(commit)) return;
    const normalizedCommit = normalizeCommitSha(commit);
    if (!normalizedCommit) return;
    if (reviewStateCommit !== normalizedCommit) return;
    if (reviewLoading || reviewSaving) return;
    if (!reviewDirty) return;
    saveReviewDraft(
      normalizedCommit,
      {
        reviewed: Boolean(reviewed),
        note: `${reviewNoteDraft ?? ""}`,
        comments: reviewRecord?.comments ?? {},
      },
      accountId,
    );
  }, [
    open,
    accountId,
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
    const startedScope = repoBootstrapScopeRef.current;
    if (!startedScope) return;
    const actionToken = repoBootstrapActionTokenRef.current + 1;
    repoBootstrapActionTokenRef.current = actionToken;
    repoBootstrapActionScopeRef.current = startedScope;
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
      if (
        shouldApplyGitRepoBootstrapScopedResult({
          actionToken,
          currentActionToken: repoBootstrapActionTokenRef.current,
          startedScope,
          currentActionScope: repoBootstrapActionScopeRef.current,
          activeScope: repoBootstrapScopeRef.current,
        })
      ) {
        setNonRepoError("");
        setSelectedCommit(HEAD_REF);
        refreshAll();
        alert_message({
          type: "info",
          message: "Initialized a new git repository.",
        });
      }
    } catch (err) {
      if (
        shouldApplyGitRepoBootstrapScopedResult({
          actionToken,
          currentActionToken: repoBootstrapActionTokenRef.current,
          startedScope,
          currentActionScope: repoBootstrapActionScopeRef.current,
          activeScope: repoBootstrapScopeRef.current,
        })
      ) {
        setGitLogError(`${err ?? "Unable to initialize git repository."}`);
      }
    } finally {
      if (
        shouldFinalizeGitRepoBootstrapAction({
          actionToken,
          currentActionToken: repoBootstrapActionTokenRef.current,
          startedScope,
          currentActionScope: repoBootstrapActionScopeRef.current,
        })
      ) {
        repoBootstrapActionScopeRef.current = undefined;
        setRepoBootstrapBusy(false);
      }
    }
  };

  const requestAgentRepoSetup = async () => {
    if (!onRequestAgentTurn) return;
    const startedScope = repoBootstrapScopeRef.current;
    if (!startedScope) return;
    const actionToken = repoBootstrapActionTokenRef.current + 1;
    repoBootstrapActionTokenRef.current = actionToken;
    repoBootstrapActionScopeRef.current = startedScope;
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
      if (
        shouldApplyGitRepoBootstrapScopedResult({
          actionToken,
          currentActionToken: repoBootstrapActionTokenRef.current,
          startedScope,
          currentActionScope: repoBootstrapActionScopeRef.current,
          activeScope: repoBootstrapScopeRef.current,
        })
      ) {
        onClose();
      }
    } catch (err) {
      if (
        shouldApplyGitRepoBootstrapScopedResult({
          actionToken,
          currentActionToken: repoBootstrapActionTokenRef.current,
          startedScope,
          currentActionScope: repoBootstrapActionScopeRef.current,
          activeScope: repoBootstrapScopeRef.current,
        })
      ) {
        setGitLogError(`${err ?? "Unable to send setup request to codex."}`);
      }
    } finally {
      if (
        shouldFinalizeGitRepoBootstrapAction({
          actionToken,
          currentActionToken: repoBootstrapActionTokenRef.current,
          startedScope,
          currentActionScope: repoBootstrapActionScopeRef.current,
        })
      ) {
        repoBootstrapActionScopeRef.current = undefined;
        setRepoBootstrapBusy(false);
      }
    }
  };

  const addUntrackedFile = async (path: string) => {
    if (!projectId) return;
    const startedScope = headScopeRef.current;
    if (!startedScope) return;
    const actionToken = headStatusActionTokenRef.current + 1;
    headStatusActionTokenRef.current = actionToken;
    headStatusActionScopeRef.current = startedScope;
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
      if (
        headStatusActionTokenRef.current === actionToken &&
        headStatusActionScopeRef.current === startedScope &&
        headScopeRef.current === startedScope
      ) {
        setHeadCommitError(`${err ?? "Unable to add untracked file."}`);
      }
    } finally {
      if (
        headStatusActionTokenRef.current === actionToken &&
        headStatusActionScopeRef.current === startedScope
      ) {
        headStatusActionScopeRef.current = undefined;
        setHeadStatusAction("");
      }
    }
  };

  const ignoreUntrackedFile = async (path: string) => {
    if (!projectId) return;
    const startedScope = headScopeRef.current;
    if (!startedScope) return;
    const actionToken = headStatusActionTokenRef.current + 1;
    headStatusActionTokenRef.current = actionToken;
    headStatusActionScopeRef.current = startedScope;
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
      if (
        headStatusActionTokenRef.current === actionToken &&
        headStatusActionScopeRef.current === startedScope &&
        headScopeRef.current === startedScope
      ) {
        setHeadCommitError(`${err ?? "Unable to ignore untracked file."}`);
      }
    } finally {
      if (
        headStatusActionTokenRef.current === actionToken &&
        headStatusActionScopeRef.current === startedScope
      ) {
        headStatusActionScopeRef.current = undefined;
        setHeadStatusAction("");
      }
    }
  };

  const projectActions = projectId
    ? redux.getProjectActions(projectId)
    : undefined;

  const openFile = async (filePath: string) => {
    if (!projectActions) return;
    const startedScope = drawerViewScopeRef.current;
    if (!startedScope) return;
    const actionToken = openFileActionTokenRef.current + 1;
    openFileActionTokenRef.current = actionToken;
    openFileActionScopeRef.current = startedScope;
    try {
      await projectActions.open_file({
        path: resolveOpenPath(repoRoot || data?.repoRoot, filePath),
        foreground: true,
        explicit: true,
      });
      if (
        shouldApplyGitFileOpenScopedResult({
          actionToken,
          currentActionToken: openFileActionTokenRef.current,
          startedScope,
          currentActionScope: openFileActionScopeRef.current,
          activeScope: drawerViewScopeRef.current,
        })
      ) {
        onClose();
      }
    } catch (err) {
      if (
        shouldApplyGitFileOpenScopedResult({
          actionToken,
          currentActionToken: openFileActionTokenRef.current,
          startedScope,
          currentActionScope: openFileActionScopeRef.current,
          activeScope: drawerViewScopeRef.current,
        })
      ) {
        alert_message({
          type: "error",
          message: `Unable to open file '${filePath}' (${err})`,
        });
      }
    } finally {
      if (
        shouldFinalizeGitFileOpenAction({
          actionToken,
          currentActionToken: openFileActionTokenRef.current,
          startedScope,
          currentActionScope: openFileActionScopeRef.current,
        })
      ) {
        openFileActionScopeRef.current = undefined;
      }
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
    const startedScope = headScopeRef.current;
    if (!startedScope) return;
    const actionToken = headCommitActionTokenRef.current + 1;
    headCommitActionTokenRef.current = actionToken;
    headCommitActionScopeRef.current = startedScope;
    setHeadCommitBusy(true);
    setHeadCommitError("");
    try {
      await onRequestAgentTurn(prompt);
      if (
        headCommitActionTokenRef.current === actionToken &&
        headCommitActionScopeRef.current === startedScope &&
        headScopeRef.current === startedScope
      ) {
        onClose();
      }
    } catch (err) {
      if (
        headCommitActionTokenRef.current === actionToken &&
        headCommitActionScopeRef.current === startedScope &&
        headScopeRef.current === startedScope
      ) {
        setHeadCommitError(
          `${err ?? "Unable to send commit request to codex."}`,
        );
      }
    } finally {
      if (
        headCommitActionTokenRef.current === actionToken &&
        headCommitActionScopeRef.current === startedScope
      ) {
        headCommitActionScopeRef.current = undefined;
        setHeadCommitBusy(false);
      }
    }
  };

  const doHeadCommit = async () => {
    if (!projectId) return;
    const trimmed = headCommitMessage.trim();
    if (!trimmed) {
      await requestAgentCommit({ includeSummary: false });
      return;
    }
    const startedScope = headScopeRef.current;
    if (!startedScope) return;
    const actionToken = headCommitActionTokenRef.current + 1;
    headCommitActionTokenRef.current = actionToken;
    headCommitActionScopeRef.current = startedScope;
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
      if (
        headCommitActionTokenRef.current === actionToken &&
        headCommitActionScopeRef.current === startedScope &&
        headScopeRef.current === startedScope
      ) {
        onClose();
      }
    } catch (err) {
      if (
        headCommitActionTokenRef.current === actionToken &&
        headCommitActionScopeRef.current === startedScope &&
        headScopeRef.current === startedScope
      ) {
        setHeadCommitError(`${err ?? "Unable to create commit."}`);
      }
    } finally {
      if (
        headCommitActionTokenRef.current === actionToken &&
        headCommitActionScopeRef.current === startedScope
      ) {
        headCommitActionScopeRef.current = undefined;
        setHeadCommitBusy(false);
      }
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
  const reviewEditorScope = useMemo(
    () =>
      buildGitReviewEditorScope({
        accountId,
        commitSha: reviewStateCommit ?? currentReviewCommit,
      }),
    [accountId, reviewStateCommit, currentReviewCommit],
  );
  const reviewNoteHistoryId = useMemo(
    () => buildGitReviewNoteEditorId(reviewEditorScope),
    [reviewEditorScope],
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
        <GitCommitDrawerTitle
          nonRepoError={nonRepoError}
          commit={commit}
          commitSearch={commitSearch}
          logOptions={logOptions}
          onCommitChange={handleCommitChange}
          onCommitSearch={handleCommitSearch}
          showOnlyUnreviewedCommits={showOnlyUnreviewedCommits}
          onToggleShowOnlyUnreviewed={setShowOnlyUnreviewedCommits}
          diffFindInputRef={diffFindInputRef}
          diffFindQuery={diffFindQuery}
          onDiffFindQueryChange={setDiffFindQuery}
          onNextDiffFindMatch={goToNextDiffFindMatch}
          onPreviousDiffFindMatch={goToPreviousDiffFindMatch}
          diffFindMatchesLength={diffFindMatches.length}
          activeDiffFindMatchIndex={activeDiffFindMatchIndex}
          canGoNewer={canGoNewer}
          canGoOlder={canGoOlder}
          onGoNewer={goNewer}
          onGoOlder={goOlder}
          canFindInChat={canFindInChat}
          findInChatEnabled={findInChatEnabled}
          onFindInChat={
            !commit || !onFindInChat
              ? undefined
              : () => {
                  void onFindInChat(commit);
                }
          }
          contextLines={contextLines}
          contextOptions={CONTEXT_OPTIONS}
          onContextChange={(value) => {
            const node = scrollRef.current;
            pendingScrollRestoreRef.current = node?.scrollTop ?? null;
            pendingContextAnchorRef.current = node
              ? (captureGitDiffScrollAnchor(node) ?? null)
              : null;
            setContextLines(value);
          }}
          reviewMenuItems={reviewMenuItems}
          onReviewMenuClick={handleReviewMenuClick}
          reviewTransferBusy={reviewTransferBusy}
        />
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
      <DeleteAllReviewsModal
        open={reviewDeleteAllOpen}
        busy={reviewTransferBusy}
        confirmText={DELETE_ALL_REVIEWS_CONFIRM_TEXT}
        confirmValue={reviewDeleteAllConfirmValue}
        onConfirmValueChange={setReviewDeleteAllConfirmValue}
        onCancel={() => {
          if (reviewTransferBusy) return;
          setReviewDeleteAllOpen(false);
          setReviewDeleteAllConfirmValue("");
        }}
        onDelete={() => {
          void deleteAllReviewData();
        }}
      />
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
          <GitRepoBootstrapPanel
            cwd={cwd}
            error={nonRepoError}
            busy={repoBootstrapBusy}
            canAskAgent={Boolean(onRequestAgentTurn)}
            onInitialize={() => {
              void initializeGitRepo();
            }}
            onAskAgent={() => {
              void requestAgentRepoSetup();
            }}
          />
        ) : isHeadSelected ? (
          <GitHeadCommitPanel
            message={headCommitMessage}
            busy={headCommitBusy}
            error={headCommitError}
            hasTrackedChanges={hasTrackedHeadChanges}
            headStatusError={headStatusError}
            headStatusLoading={headStatusLoading}
            headStatusEntries={headStatusEntries}
            headStatusAction={headStatusAction}
            onMessageChange={setHeadCommitMessage}
            onCommitWithSummary={() => {
              void requestAgentCommit({ includeSummary: true });
            }}
            onCommit={() => {
              void doHeadCommit();
            }}
            onClearMessage={() => setHeadCommitMessage("")}
            onOpenFile={(path) => {
              void openFile(path);
            }}
            onAddUntrackedFile={(path) => {
              void addUntrackedFile(path);
            }}
            onIgnoreUntrackedFile={(path) => {
              void ignoreUntrackedFile(path);
            }}
          />
        ) : (
          <GitReviewPanel
            reviewed={reviewed}
            reviewLoading={reviewLoading}
            reviewSaving={reviewSaving}
            reviewUpdatedAt={reviewUpdatedAt}
            accountId={accountId}
            currentReviewCommit={currentReviewCommit}
            isHeadSelected={isHeadSelected}
            reviewNoteEditing={reviewNoteEditing}
            reviewNote={reviewNote}
            reviewNoteDraft={reviewNoteDraft}
            reviewNoteHistoryId={reviewNoteHistoryId}
            fontSize={fontSize}
            editorTheme={editorTheme}
            reviewError={reviewError}
            inlineCommentCount={inlineComments.length}
            resolvedInlineCount={resolvedInlineCount}
            showResolvedComments={showResolvedComments}
            onToggleReviewed={(next) => {
              setReviewed(next);
              setReviewDirty(true);
              void saveReview({ reviewed: next });
            }}
            onToggleShowResolvedComments={setShowResolvedComments}
            onPersistReviewNoteDraft={(value) => {
              if (
                reviewLoading ||
                !accountId ||
                isHeadSelected ||
                !currentReviewCommit
              ) {
                return;
              }
              if (activeReviewCommitRef.current !== currentReviewCommit) {
                return;
              }
              setReviewNoteDraft(value);
              setReviewDirty(true);
              saveReviewDraft(
                currentReviewCommit,
                {
                  reviewed: Boolean(reviewed),
                  note: `${value ?? ""}`,
                  comments: reviewRecord?.comments ?? {},
                },
                accountId,
              );
            }}
            onStartEditingReviewNote={() => {
              setReviewNoteDraft(reviewNote);
              setReviewNoteEditing(true);
            }}
            onCancelReviewNote={() => {
              setReviewNoteDraft(reviewNote);
              setReviewNoteEditing(false);
            }}
            onSaveReviewNote={(nextNote) => {
              if (!currentReviewCommit) return;
              setReviewNote(nextNote);
              setReviewNoteDraft(nextNote);
              setReviewDirty(true);
              setReviewNoteEditing(false);
              void saveReview({ note: nextNote, reviewed });
            }}
            actionableInlineCommentCount={actionableInlineComments.length}
            reviewSubmitBusy={reviewSubmitBusy}
            canRequestAgentTurn={Boolean(onRequestAgentTurn)}
            reviewSubmissionHelpText={reviewSubmissionHelpText}
            onSendInlineReviewToAgent={() => {
              void sendInlineReviewToAgent();
            }}
          />
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
            {data.summaryLines.length ? (
              <GitCommitDetailsPanel
                summary={data.summary}
                commit={commit}
                isHeadSelected={isHeadSelected}
                fontSize={fontSize}
                editorTheme={editorTheme}
                headRefLabel={HEAD_REF}
              />
            ) : null}
            {data.files.length === 0 ? (
              <GitEmptyCommitDiff />
            ) : (
              <>
                <GitChangedFilesPanel
                  files={data.files}
                  inlineCommentsByFile={inlineCommentsByFile}
                  onOpenFileDiff={scrollToDiffFile}
                />
                <GitDiffFilesPanel
                  files={data.files}
                  drawerScrollParent={drawerScrollParent}
                  virtuosoRef={virtuosoRef}
                  fontSize={fontSize}
                  editorTheme={editorTheme}
                  reviewEditorScope={reviewEditorScope}
                  inlineCommentsByFile={inlineCommentsByFile}
                  showResolvedComments={showResolvedComments}
                  isHeadSelected={isHeadSelected}
                  visibleDiffLinesByFile={visibleDiffLinesByFile}
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
                  diffFindMatchCounts={diffFindMeta.counts}
                  diffFindMatchedLineIndexes={diffFindMeta.matchedLineIndexes}
                  activeDiffFindMatch={activeDiffFindMatch}
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
