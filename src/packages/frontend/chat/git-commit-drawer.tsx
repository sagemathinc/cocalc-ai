/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Segmented,
  Select,
  Space,
  Spin,
  Tooltip,
  Typography,
} from "antd";
import {
  useEffect,
  useMemo,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import { redux } from "@cocalc/frontend/app-framework";
import { TimeAgo } from "@cocalc/frontend/components";
import { filenameMode } from "@cocalc/frontend/file-associations";
import { highlightCodeHtml } from "@cocalc/frontend/editors/slate/elements/code-block/prism";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { containingPath } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import {
  loadReviewRecord,
  normalizeCommitSha,
  saveReviewDraft,
  saveReviewRecord,
  type GitReviewRecordV2,
} from "./git-review-store";

const MAX_GIT_SHOW_LINES = 10_000;
const MAX_GIT_SHOW_OUTPUT_BYTES = 4_000_000;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const HEAD_REF = "HEAD";
const DEFAULT_CONTEXT_LINES = 3;
const GIT_LOG_FETCH_COUNT = 600;
const GIT_LOG_WINDOW_SIZE = 100;
const DRAWER_SIZE_STORAGE_KEY = "cocalc:chat:gitCommitDrawerSize";
const DEFAULT_DRAWER_SIZE = 920;
const MIN_DRAWER_SIZE = 520;
const MAX_DRAWER_SIZE = 1800;
const CONTEXT_OPTIONS = [3, 10, 30].map((value) => ({
  value,
  label: `Context ${value}`,
}));
const REVIEW_FILTER_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Reviewed", value: "reviewed" },
  { label: "Unreviewed", value: "unreviewed" },
];

type GitShowFile = {
  path: string;
  lines: string[];
};

type GitShowParsed = {
  summaryLines: string[];
  files: GitShowFile[];
  repoRoot?: string;
  linesTruncated: boolean;
  originalLineCount: number;
  shownLineCount: number;
};

type GitLogEntry = {
  hash: string;
  subject: string;
};

type ReviewFilter = "all" | "reviewed" | "unreviewed";

interface GitCommitDrawerProps {
  projectId?: string;
  sourcePath?: string;
  cwdOverride?: string;
  commitHash?: string;
  open: boolean;
  onClose: () => void;
  fontSize?: number;
  onRequestAgentTurn?: (prompt: string) => void | Promise<void>;
}

type HeadStatusEntry = {
  path: string;
  displayPath: string;
  statusCode: string;
  statusLabel: string;
  tracked: boolean;
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

function parseGitShowOutput(stdout: string, repoRoot?: string): GitShowParsed {
  const allLines = `${stdout ?? ""}`.split(/\r?\n/);
  const linesTruncated = allLines.length > MAX_GIT_SHOW_LINES;
  const lines = linesTruncated ? allLines.slice(0, MAX_GIT_SHOW_LINES) : allLines;
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
    files,
    repoRoot,
    linesTruncated,
    originalLineCount: allLines.length,
    shownLineCount: lines.length,
  };
}

function parseGitLogOutput(stdout: string): GitLogEntry[] {
  const lines = `${stdout ?? ""}`.split(/\r?\n/).filter((line) => line.trim().length);
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
  const lines = `${stdout ?? ""}`.split(/\r?\n/).filter((line) => line.trim().length);
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
    entries.push({ path: displayPath, displayPath, statusCode, statusLabel, tracked });
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
    localStorage.setItem(DRAWER_SIZE_STORAGE_KEY, String(clampDrawerSize(size)));
  } catch {
    // ignore
  }
}

function resolveOpenPath(repoRoot: string | undefined, filePath: string): string {
  if (!filePath) return filePath;
  if (filePath.startsWith("/")) return filePath;
  if (!repoRoot) return filePath;
  const prefix = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  return `${prefix}/${filePath}`.replace(/\/+/g, "/");
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isDiffContentLine(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return false;
  const prefix = line[0];
  return prefix === "+" || prefix === "-" || prefix === " ";
}

function languageHintFromPath(path: string): string {
  const base = `${path ?? ""}`.trim().toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop() ?? "" : "";
  if (!ext) return "text";
  return ext;
}

function splitLinesPreserve(text: string): string[] {
  return text.split(/\n/);
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(target.closest('[contenteditable="true"], .slate-editor'));
}

function DiffBlock({
  lines,
  languageHint,
  fontSize,
}: {
  lines: string[];
  languageHint: string;
  fontSize: number;
}) {
  const codeFontSize = Math.max(11, fontSize - 1);
  const lineMetas = useMemo(
    () =>
      lines.map((line) => {
        const isCode = isDiffContentLine(line);
        const prefix = isCode ? line[0] : "";
        const body = isCode ? line.slice(1) : line;
        return { raw: line, isCode, prefix, body };
      }),
    [lines],
  );
  const highlightedByLine = useMemo(() => {
    const codeBodies = lineMetas.filter((x) => x.isCode).map((x) => x.body);
    if (codeBodies.length === 0) return [] as string[];
    const highlighted = highlightCodeHtml(codeBodies.join("\n"), languageHint);
    return splitLinesPreserve(highlighted);
  }, [lineMetas, languageHint]);
  let highlightedIdx = -1;
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
        const html = (() => {
          if (!meta.isCode) {
            return escapeText(meta.raw);
          }
          highlightedIdx += 1;
          const highlightedLine = highlightedByLine[highlightedIdx] ?? escapeText(meta.body);
          return `${escapeText(meta.prefix)}${highlightedLine}`;
        })();
        return (
          <div
            key={idx}
            style={{
              background,
              padding: "2px 8px",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      })}
    </div>
  );
}

export function GitCommitDrawer({
  projectId,
  sourcePath,
  cwdOverride,
  commitHash,
  open,
  onClose,
  fontSize = 14,
  onRequestAgentTurn,
}: GitCommitDrawerProps) {
  const accountId = useTypedRedux("account", "account_id");
  const [drawerSize, setDrawerSize] = useState<number>(readDrawerSize);
  const [contextLines, setContextLines] = useState<number>(DEFAULT_CONTEXT_LINES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<GitShowParsed | undefined>(undefined);
  const [repoRoot, setRepoRoot] = useState<string>("");
  const [gitLog, setGitLog] = useState<GitLogEntry[]>([]);
  const [gitLogError, setGitLogError] = useState<string>("");
  const [gitLogReloadCounter, setGitLogReloadCounter] = useState(0);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [headStatusLoading, setHeadStatusLoading] = useState(false);
  const [headStatusError, setHeadStatusError] = useState("");
  const [headStatusEntries, setHeadStatusEntries] = useState<HeadStatusEntry[]>([]);
  const [headStatusAction, setHeadStatusAction] = useState<string>("");
  const [headCommitBusy, setHeadCommitBusy] = useState(false);
  const [headCommitMessage, setHeadCommitMessage] = useState("");
  const [headCommitError, setHeadCommitError] = useState("");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [reviewedByCommit, setReviewedByCommit] = useState<Record<string, boolean>>(
    {},
  );
  const incomingCommit = useMemo(() => parseCommitHash(commitHash), [commitHash]);
  const [selectedCommit, setSelectedCommit] = useState<string | undefined>(
    incomingCommit,
  );
  const commit = selectedCommit;
  const isHeadSelected = isHeadCommit(commit);

  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewUpdatedAt, setReviewUpdatedAt] = useState<number | undefined>(
    undefined,
  );
  const [reviewDirty, setReviewDirty] = useState(false);
  const [reviewRecord, setReviewRecord] = useState<GitReviewRecordV2 | undefined>(
    undefined,
  );

  const cwd = useMemo(() => {
    const override = `${cwdOverride ?? ""}`.trim();
    if (override) return override;
    return containingPath(sourcePath ?? ".") || ".";
  }, [sourcePath, cwdOverride]);

  useEffect(() => {
    if (!open) return;
    setSelectedCommit(incomingCommit);
  }, [incomingCommit, open]);

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
            (rootResult.stderr || rootResult.stdout || "not a git repository").trim(),
          );
        }
        const root = `${rootResult.stdout ?? ""}`.trim();
        if (!cancelled) {
          setRepoRoot(root);
          setGitLogError("");
        }
        const logResult = await runGitCommand({
          projectId,
          cwd: root || cwd,
          args: [
            "log",
            `-n${GIT_LOG_FETCH_COUNT}`,
            "--format=%H%x09%s",
            "--date-order",
          ],
        });
        if (logResult.exit_code !== 0) {
          throw new Error((logResult.stderr || logResult.stdout || "git log failed").trim());
        }
        const entries = parseGitLogOutput(logResult.stdout ?? "");
        if (!cancelled) {
          setGitLog(entries);
          setGitLogError("");
        }
      } catch (err) {
        if (cancelled) return;
        setRepoRoot("");
        setGitLog([]);
        setGitLogError(`${err ?? "Unable to load git log."}`);
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
            (statusResult.stderr || statusResult.stdout || "git status failed").trim(),
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

  const commitIndex = useMemo(() => {
    if (!commit) return -1;
    return gitLog.findIndex((entry) => entry.hash === commit);
  }, [gitLog, commit]);

  useEffect(() => {
    if (!open || !commit || isHeadSelected || gitLog.length === 0 || commitIndex >= 0) return;
    const prefixMatches = gitLog.filter((entry) => entry.hash.startsWith(commit));
    if (prefixMatches.length === 1) {
      setSelectedCommit(prefixMatches[0].hash);
    }
  }, [open, commit, isHeadSelected, gitLog, commitIndex]);

  const visibleLogEntries = useMemo(() => {
    if (gitLog.length === 0) return [] as GitLogEntry[];
    if (commitIndex < 0) {
      return gitLog.slice(0, GIT_LOG_WINDOW_SIZE);
    }
    const half = Math.floor(GIT_LOG_WINDOW_SIZE / 2);
    let start = Math.max(0, commitIndex - half);
    let end = Math.min(gitLog.length, start + GIT_LOG_WINDOW_SIZE);
    start = Math.max(0, end - GIT_LOG_WINDOW_SIZE);
    return gitLog.slice(start, end);
  }, [gitLog, commitIndex]);

  const filteredLogEntries = useMemo(() => {
    if (reviewFilter === "all") return visibleLogEntries;
    return visibleLogEntries.filter((entry) => {
      const isReviewed = Boolean(reviewedByCommit[entry.hash]);
      return reviewFilter === "reviewed" ? isReviewed : !isReviewed;
    });
  }, [visibleLogEntries, reviewFilter, reviewedByCommit]);

  const logOptions = useMemo(() => {
    const makeOptionLabel = (entry: GitLogEntry, fallback = false) => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
          width: "100%",
        }}
      >
        <Checkbox
          checked={Boolean(reviewedByCommit[entry.hash])}
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
    const options = [
      {
        value: HEAD_REF,
        label: makeOptionLabel({
          hash: HEAD_REF,
          subject: "Uncommitted changes (git diff HEAD)",
        }),
        search: "HEAD uncommitted changes git diff",
      },
      ...filteredLogEntries.map((entry) => ({
        value: entry.hash,
        label: makeOptionLabel(entry),
        search: `${entry.hash} ${entry.subject}`.trim(),
      })),
    ];
    if (commit && !options.some((opt) => opt.value === commit)) {
      const fallback: GitLogEntry = { hash: commit, subject: "selected commit" };
      options.unshift({
        value: commit,
        label: makeOptionLabel(fallback, true),
        search: `${commit} selected commit`,
      });
    }
    return options;
  }, [filteredLogEntries, commit, reviewedByCommit]);

  useEffect(() => {
    if (!open || !accountId) return;
    const hashes = Array.from(
      new Set(
        [
          ...visibleLogEntries.map((entry) => entry.hash),
          commit,
        ].filter(
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
  }, [open, accountId, visibleLogEntries, commit]);

  const loadReview = async () => {
    if (!open || !accountId || !commit) return;
    const normalizedCommit = normalizeCommitSha(commit);
    if (isHeadCommit(commit) || !normalizedCommit) {
      setReviewLoading(false);
      setReviewError("");
      setReviewed(false);
      setReviewNote("");
      setReviewUpdatedAt(undefined);
      setReviewDirty(false);
      setReviewRecord(undefined);
      return;
    }
    setReviewLoading(true);
    setReviewError("");
    try {
      const rec = await loadReviewRecord({
        accountId,
        commitSha: normalizedCommit,
      });
      setReviewRecord(rec);
      setReviewed(Boolean(rec?.reviewed));
      setReviewedByCommit((prev) => ({
        ...prev,
        [normalizedCommit]: Boolean(rec?.reviewed),
      }));
      setReviewNote(typeof rec?.note === "string" ? rec.note : "");
      setReviewUpdatedAt(
        typeof rec?.updated_at === "number" ? rec.updated_at : undefined,
      );
      setReviewDirty(false);
      setReviewError("");
    } catch (err) {
      setReviewError(`${err ?? "Unable to load review state."}`);
      setReviewed(false);
      setReviewNote("");
      setReviewUpdatedAt(undefined);
      setReviewDirty(false);
      setReviewRecord(undefined);
    } finally {
      setReviewLoading(false);
    }
  };

  useEffect(() => {
    void loadReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId, commit]);

  const saveReview = async (
    next: Partial<Pick<GitReviewRecordV2, "reviewed" | "note">> = {},
  ) => {
    if (!accountId || !commit || isHeadCommit(commit)) return;
    const normalizedCommit = normalizeCommitSha(commit);
    if (!normalizedCommit) return;
    const nextReviewed = next.reviewed ?? reviewed;
    const nextNote = next.note ?? reviewNote;
    setReviewSaving(true);
    setReviewError("");
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
      });
      setReviewRecord(payload);
      setReviewUpdatedAt(payload.updated_at);
      setReviewedByCommit((prev) => ({
        ...prev,
        [normalizedCommit]: payload.reviewed,
      }));
      setReviewDirty(false);
      setReviewError("");
    } catch (err) {
      setReviewError(`${err ?? "Unable to save review state."}`);
    } finally {
      setReviewSaving(false);
    }
  };

  useEffect(() => {
    if (!open || !commit || isHeadCommit(commit)) return;
    const normalizedCommit = normalizeCommitSha(commit);
    if (!normalizedCommit) return;
    if (reviewLoading || reviewSaving) return;
    if (!reviewDirty) return;
    saveReviewDraft(normalizedCommit, {
      reviewed: Boolean(reviewed),
      note: `${reviewNote ?? ""}`,
    });
  }, [
    open,
    commit,
    reviewLoading,
    reviewSaving,
    reviewDirty,
    reviewed,
    reviewNote,
  ]);

  useEffect(() => {
    if (!open) return;
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
        const args = isHeadSelected
          ? [
              "-c",
              "core.pager=cat",
              "diff",
              "--no-color",
              "--patch",
              "--find-renames",
              "--find-copies",
              `-U${contextLines}`,
              "HEAD",
            ]
          : [
              "-c",
              "core.pager=cat",
              "show",
              "--no-color",
              "--patch",
              "--find-renames",
              "--find-copies",
              `-U${contextLines}`,
              "--format=fuller",
              commit,
            ];
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
        const parsed = parseGitShowOutput(showResult.stdout ?? "", repoRoot || undefined);
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
    reloadCounter,
  ]);

  const refreshAll = () => {
    setReloadCounter((n) => n + 1);
    setGitLogReloadCounter((n) => n + 1);
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
        throw new Error((result.stderr || result.stdout || "git add failed").trim());
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
          (result.stderr || result.stdout || "unable to update .gitignore").trim(),
        );
      }
      setReloadCounter((n) => n + 1);
    } catch (err) {
      setHeadCommitError(`${err ?? "Unable to ignore untracked file."}`);
    } finally {
      setHeadStatusAction("");
    }
  };

  const projectActions = projectId ? redux.getProjectActions(projectId) : undefined;

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

  const canGoNewer = !isHeadSelected && commitIndex > 0;
  const canGoOlder = isHeadSelected
    ? gitLog.length > 0
    : commitIndex >= 0 && commitIndex < gitLog.length - 1;
  const goNewer = () => {
    if (!canGoNewer) return;
    setSelectedCommit(gitLog[commitIndex - 1]?.hash);
  };
  const goOlder = () => {
    if (!canGoOlder) return;
    if (isHeadSelected) {
      setSelectedCommit(gitLog[0]?.hash);
      return;
    }
    setSelectedCommit(gitLog[commitIndex + 1]?.hash);
  };

  const requestAgentCommit = async ({
    includeSummary,
  }: {
    includeSummary: boolean;
  }) => {
    const trimmed = headCommitMessage.trim();
    if (!onRequestAgentTurn) {
      setHeadCommitError("No active codex thread available for this action.");
      return;
    }
    let prompt = "";
    if (includeSummary) {
      prompt = trimmed
        ? [
            "Please commit all tracked changes in the current repository.",
            "Do not include untracked files.",
            `Use this exact first line for the commit message: "${trimmed}"`,
            "Then include a detailed explanatory body.",
          ].join("\n")
        : "Please commit all tracked changes with a concise first line and a detailed explanatory body. Do not include untracked files.";
    } else {
      prompt = trimmed
        ? `Please commit all tracked changes with this exact commit message:\n${trimmed}\nDo not include untracked files.`
        : "Please commit all tracked changes. Do not include untracked files.";
    }
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
        throw new Error((result.stderr || result.stdout || "git commit failed").trim());
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
    if (next && next !== contextLines) setContextLines(next);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.altKey || evt.ctrlKey || evt.metaKey) return;
      if (isEditableEventTarget(evt.target)) return;
      if (evt.key === "j") {
        evt.preventDefault();
        if (canGoOlder) {
          if (isHeadSelected) {
            setSelectedCommit(gitLog[0]?.hash);
          } else {
            setSelectedCommit(gitLog[commitIndex + 1]?.hash);
          }
        }
        return;
      }
      if (evt.key === "k") {
        evt.preventDefault();
        if (canGoNewer) {
          setSelectedCommit(gitLog[commitIndex - 1]?.hash);
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
  }, [open, canGoOlder, canGoNewer, commitIndex, gitLog, contextLines, isHeadSelected]);

  return (
    <Drawer
      title={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            width: "100%",
          }}
        >
          <span>{`Commit ${commit ?? ""}`}</span>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Tooltip title="Context lines around changes. Shortcuts: [ decrease, ] increase">
              <span
                style={{
                  color: COLORS.GRAY_D,
                  fontSize: 12,
                  cursor: "help",
                }}
              >
                Context
              </span>
            </Tooltip>
            <Select
              size="small"
              value={contextLines}
              options={CONTEXT_OPTIONS}
              onChange={(value) => setContextLines(value)}
              style={{ width: 120 }}
            />
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
      onClose={onClose}
      destroyOnHidden
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <Select
          showSearch
          size="small"
          value={commit}
          options={logOptions}
          onChange={(value) => setSelectedCommit(value)}
          placeholder="git log"
          style={{ minWidth: 360, flex: "1 1 360px" }}
          optionFilterProp="search"
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", height: 24 }}>
            <Segmented
              size="small"
              value={reviewFilter}
              options={REVIEW_FILTER_OPTIONS}
              onChange={(value) => setReviewFilter(value as ReviewFilter)}
              style={{
                margin: 0,
                display: "inline-flex",
                alignItems: "center",
                lineHeight: "24px",
              }}
            />
          </div>
          <Space.Compact size="small">
            <Tooltip title="Newer commit (shortcut: k)">
              <span style={{ display: "inline-flex" }}>
                <Button size="small" onClick={goNewer} disabled={!canGoNewer}>
                  Newer
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Older commit (shortcut: j)">
              <span style={{ display: "inline-flex" }}>
                <Button size="small" onClick={goOlder} disabled={!canGoOlder}>
                  Older
                </Button>
              </span>
            </Tooltip>
          </Space.Compact>
        </div>
      </div>
      {gitLogError ? (
        <Alert type="warning" message={gitLogError} showIcon style={{ marginBottom: 10 }} />
      ) : null}
      {isHeadSelected ? (
        <div
          style={{
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
            background: "#fafafa",
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
              onClick={() => void requestAgentCommit({ includeSummary: true })}
              disabled={headCommitBusy}
            >
              Commit with AI Summary
            </Button>
            <Button size="small" onClick={() => void doHeadCommit()}>
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
            Commit uses all tracked changes only (`git commit -a`). Untracked files are excluded.
          </Typography.Text>
          {headCommitError ? (
            <Alert type="error" showIcon message={headCommitError} />
          ) : null}

          <div style={{ fontWeight: 600 }}>Uncommitted files</div>
          {headStatusError ? (
            <Alert type="warning" showIcon message={headStatusError} />
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
                    <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                      <Button
                        type="link"
                        size="small"
                        style={{ padding: 0, fontFamily: "monospace" }}
                        onClick={() => void openFile(entry.path)}
                      >
                        {entry.displayPath}
                      </Button>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {entry.statusLabel}
                        {!entry.tracked ? " (not included by Commit)" : ""}
                      </Typography.Text>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                            onClick={() => void ignoreUntrackedFile(entry.path)}
                            loading={headStatusAction === `ignore:${entry.path}`}
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
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 8,
            padding: 10,
            marginBottom: 12,
            background: "#fafafa",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            <Checkbox
              checked={reviewed}
              disabled={reviewLoading || reviewSaving || !commit || isHeadSelected}
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
              {reviewSaving ? "Saving..." : null}
              {!reviewSaving && reviewUpdatedAt ? (
                <>
                  Updated <TimeAgo date={new Date(reviewUpdatedAt)} />
                </>
              ) : null}
            </div>
          </div>
          <Input.TextArea
            value={reviewNote}
            disabled={reviewLoading || !commit || isHeadSelected}
            placeholder="Review note (your private commit review note)"
            autoSize={{ minRows: 2, maxRows: 6 }}
            onChange={(e) => {
              setReviewNote(e.target.value);
              setReviewDirty(true);
            }}
            onBlur={() => {
              if (reviewDirty) {
                void saveReview({ note: reviewNote });
              }
            }}
          />
          <div
            style={{
              marginTop: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
              {reviewError || (reviewLoading ? "Loading review state..." : "")}
            </div>
            <Button
              size="small"
              disabled={!reviewDirty || reviewSaving || !commit || isHeadSelected}
              onClick={() => void saveReview({ note: reviewNote, reviewed })}
            >
              Save note
            </Button>
          </div>
        </div>
      )}
      {loading ? (
        <div style={{ padding: "32px 0", textAlign: "center" }}>
          <Spin />
        </div>
      ) : null}
      {!loading && error ? (
        <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />
      ) : null}
      {!loading && !error && data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {data.summaryLines.length ? (
            <Typography.Paragraph
              style={{
                marginBottom: 0,
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                fontSize: Math.max(11, fontSize - 1),
              }}
            >
              {data.summaryLines.join("\n")}
            </Typography.Paragraph>
          ) : null}
          {data.files.length === 0 ? (
            <Empty description="No file changes in this commit." />
          ) : (
            data.files.map((file, idx) => {
              const languageHint = languageHintFromPath(file.path);
              return (
                <div key={`${file.path}-${idx}`}>
                  <div
                    style={{
                      marginBottom: 6,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, fontFamily: "monospace" }}
                      onClick={() => void openFile(file.path)}
                    >
                      {file.path}
                    </Button>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {filenameMode(file.path, "text")}
                    </Typography.Text>
                  </div>
                  <DiffBlock
                    lines={file.lines}
                    languageHint={languageHint}
                    fontSize={fontSize}
                  />
                </div>
              );
            })
          )}
          {data.linesTruncated ? (
            <Alert
              type="warning"
              showIcon
              message={`Showing first ${MAX_GIT_SHOW_LINES.toLocaleString()} lines (${data.shownLineCount.toLocaleString()} loaded of ${data.originalLineCount.toLocaleString()}).`}
              description={
                <span>
                  Output was truncated for UI performance. Use terminal for full output, e.g.{" "}
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
    </Drawer>
  );
}
