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

const MAX_GIT_SHOW_LINES = 10_000;
const MAX_GIT_SHOW_OUTPUT_BYTES = 4_000_000;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const DEFAULT_CONTEXT_LINES = 3;
const GIT_LOG_FETCH_COUNT = 600;
const GIT_LOG_WINDOW_SIZE = 100;
const REVIEW_STORE_NAME = "cocalc-commit-review-v1";
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

type CommitReviewRecord = {
  version: 1;
  reviewed: boolean;
  note?: string;
  updated_at: number;
  account_id: string;
  commit: string;
};

interface GitCommitDrawerProps {
  projectId?: string;
  sourcePath?: string;
  commitHash?: string;
  open: boolean;
  onClose: () => void;
  fontSize?: number;
}

function parseCommitHash(commitHash?: string): string | undefined {
  const trimmed = `${commitHash ?? ""}`.trim();
  if (!COMMIT_HASH_RE.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
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
  commitHash,
  open,
  onClose,
  fontSize = 14,
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
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [reviewedByCommit, setReviewedByCommit] = useState<Record<string, boolean>>(
    {},
  );
  const incomingCommit = useMemo(() => parseCommitHash(commitHash), [commitHash]);
  const [selectedCommit, setSelectedCommit] = useState<string | undefined>(
    incomingCommit,
  );
  const commit = selectedCommit;

  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewUpdatedAt, setReviewUpdatedAt] = useState<number | undefined>(
    undefined,
  );
  const [reviewDirty, setReviewDirty] = useState(false);

  const cwd = useMemo(() => containingPath(sourcePath ?? ".") || ".", [sourcePath]);

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
  }, [open, projectId, cwd]);

  const commitIndex = useMemo(() => {
    if (!commit) return -1;
    return gitLog.findIndex((entry) => entry.hash === commit);
  }, [gitLog, commit]);

  useEffect(() => {
    if (!open || !commit || gitLog.length === 0 || commitIndex >= 0) return;
    const prefixMatches = gitLog.filter((entry) => entry.hash.startsWith(commit));
    if (prefixMatches.length === 1) {
      setSelectedCommit(prefixMatches[0].hash);
    }
  }, [open, commit, gitLog, commitIndex]);

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
    const options = filteredLogEntries.map((entry) => ({
      value: entry.hash,
      label: makeOptionLabel(entry),
      search: `${entry.hash} ${entry.subject}`.trim(),
    }));
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
        ].filter((hash): hash is string => Boolean(hash)),
      ),
    );
    if (hashes.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const cn = webapp_client.conat_client.conat();
        const kv = cn.sync.akv<CommitReviewRecord>({
          account_id: accountId,
          name: REVIEW_STORE_NAME,
        });
        const entries = await Promise.all(
          hashes.map(async (hash) => {
            const rec = await kv.get(hash);
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
    setReviewLoading(true);
    setReviewError("");
    try {
      const cn = webapp_client.conat_client.conat();
      const kv = cn.sync.akv<CommitReviewRecord>({
        account_id: accountId,
        name: REVIEW_STORE_NAME,
      });
      const rec = await kv.get(commit);
      setReviewed(Boolean(rec?.reviewed));
      setReviewedByCommit((prev) => ({
        ...prev,
        [commit]: Boolean(rec?.reviewed),
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
    } finally {
      setReviewLoading(false);
    }
  };

  useEffect(() => {
    void loadReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId, commit]);

  const saveReview = async (
    next: Partial<Pick<CommitReviewRecord, "reviewed" | "note">> = {},
  ) => {
    if (!accountId || !commit) return;
    const nextReviewed = next.reviewed ?? reviewed;
    const nextNote = next.note ?? reviewNote;
    setReviewSaving(true);
    setReviewError("");
    try {
      const cn = webapp_client.conat_client.conat();
      const kv = cn.sync.akv<CommitReviewRecord>({
        account_id: accountId,
        name: REVIEW_STORE_NAME,
      });
      const now = Date.now();
      const payload: CommitReviewRecord = {
        version: 1,
        reviewed: Boolean(nextReviewed),
        note: `${nextNote ?? ""}`,
        updated_at: now,
        account_id: accountId,
        commit,
      };
      await kv.set(commit, payload);
      setReviewUpdatedAt(now);
      setReviewedByCommit((prev) => ({ ...prev, [commit]: payload.reviewed }));
      setReviewDirty(false);
      setReviewError("");
    } catch (err) {
      setReviewError(`${err ?? "Unable to save review state."}`);
    } finally {
      setReviewSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (!projectId || !commit) {
      setError("Invalid commit or missing project.");
      setData(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(undefined);
    (async () => {
      try {
        const showResult = await runGitCommand({
          projectId,
          cwd: repoRoot || cwd,
          args: [
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
          ],
        });
        if (showResult.exit_code !== 0) {
          throw new Error(
            (showResult.stderr || showResult.stdout || "git show failed").trim(),
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
  }, [open, projectId, cwd, repoRoot, commit, contextLines]);

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

  const canGoNewer = commitIndex > 0;
  const canGoOlder = commitIndex >= 0 && commitIndex < gitLog.length - 1;
  const goNewer = () => {
    if (!canGoNewer) return;
    setSelectedCommit(gitLog[commitIndex - 1]?.hash);
  };
  const goOlder = () => {
    if (!canGoOlder) return;
    setSelectedCommit(gitLog[commitIndex + 1]?.hash);
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
          setSelectedCommit(gitLog[commitIndex + 1]?.hash);
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
  }, [open, canGoOlder, canGoNewer, commitIndex, gitLog, contextLines]);

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
            <span style={{ color: COLORS.GRAY_D, fontSize: 12 }}>Context</span>
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
          <Segmented
            size="small"
            value={reviewFilter}
            options={REVIEW_FILTER_OPTIONS}
            onChange={(value) => setReviewFilter(value as ReviewFilter)}
            style={{ margin: 0 }}
          />
          <Space.Compact size="small">
            <Button size="small" onClick={goNewer} disabled={!canGoNewer}>
              Newer
            </Button>
            <Button size="small" onClick={goOlder} disabled={!canGoOlder}>
              Older
            </Button>
          </Space.Compact>
        </div>
      </div>
      {gitLogError ? (
        <Alert type="warning" message={gitLogError} showIcon style={{ marginBottom: 10 }} />
      ) : null}
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
            disabled={reviewLoading || reviewSaving || !commit}
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
          disabled={reviewLoading || !commit}
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
            disabled={!reviewDirty || reviewSaving || !commit}
            onClick={() => void saveReview({ note: reviewNote, reviewed })}
          >
            Save note
          </Button>
        </div>
      </div>
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
                  <code>{`git show --no-color -U${contextLines} ${commit} | less`}</code>.
                </span>
              }
            />
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
