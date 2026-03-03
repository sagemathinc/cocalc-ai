/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Drawer,
  Empty,
  Select,
  Spin,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import { redux } from "@cocalc/frontend/app-framework";
import { filenameMode } from "@cocalc/frontend/file-associations";
import { highlightCodeHtml } from "@cocalc/frontend/editors/slate/elements/code-block/prism";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { containingPath } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

const MAX_GIT_SHOW_LINES = 10_000;
const MAX_GIT_SHOW_OUTPUT_BYTES = 4_000_000;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const DEFAULT_CONTEXT_LINES = 10;
const CONTEXT_OPTIONS = [3, 10, 30].map((value) => ({
  value,
  label: `Context ${value}`,
}));

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

function renderLineHtml(line: string, mode: string): string {
  if (!isDiffContentLine(line)) {
    return escapeText(line);
  }
  const prefix = line[0];
  const body = line.slice(1);
  const highlighted = highlightCodeHtml(body, mode);
  return `${escapeText(prefix)}${highlighted}`;
}

function DiffBlock({
  lines,
  mode,
  fontSize,
}: {
  lines: string[];
  mode: string;
  fontSize: number;
}) {
  const codeFontSize = Math.max(11, fontSize - 1);
  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_L}`,
        borderRadius: 6,
        overflow: "hidden",
        fontFamily: "monospace",
        fontSize: codeFontSize,
      }}
    >
      {lines.map((line, idx) => {
        const prefix = line[0];
        const background =
          prefix === "+" && !line.startsWith("+++ ")
            ? "#e6ffed"
            : prefix === "-" && !line.startsWith("--- ")
              ? "#ffeef0"
              : "transparent";
        const html = renderLineHtml(line, mode);
        return (
          <div
            key={idx}
            style={{
              background,
              borderBottom:
                idx === lines.length - 1 ? "none" : `1px solid ${COLORS.GRAY_LL}`,
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
  const [contextLines, setContextLines] = useState<number>(DEFAULT_CONTEXT_LINES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [data, setData] = useState<GitShowParsed | undefined>(undefined);
  const commit = useMemo(() => parseCommitHash(commitHash), [commitHash]);

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
        const cwd = containingPath(sourcePath ?? ".") || ".";
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
        const repoRoot = `${rootResult.stdout ?? ""}`.trim();
        const showResult = await runGitCommand({
          projectId,
          cwd,
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
        const parsed = parseGitShowOutput(showResult.stdout ?? "", repoRoot);
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
  }, [open, projectId, sourcePath, commit, contextLines]);

  const projectActions = projectId ? redux.getProjectActions(projectId) : undefined;

  const openFile = async (filePath: string) => {
    if (!projectActions) return;
    try {
      await projectActions.open_file({
        path: resolveOpenPath(data?.repoRoot, filePath),
        foreground: true,
        explicit: true,
      });
    } catch (err) {
      alert_message({
        type: "error",
        message: `Unable to open file '${filePath}' (${err})`,
      });
    }
  };

  return (
    <Drawer
      title={`Commit ${commit ?? ""}`}
      placement="right"
      width="70vw"
      open={open}
      onClose={onClose}
      destroyOnHidden
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ color: COLORS.GRAY_D }}>Context:</span>
        <Select
          size="small"
          value={contextLines}
          options={CONTEXT_OPTIONS}
          onChange={(value) => setContextLines(value)}
          style={{ width: 130 }}
        />
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
              const mode = filenameMode(file.path, "text");
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
                    <Typography.Text code>{file.path}</Typography.Text>
                    <Button size="small" onClick={() => void openFile(file.path)}>
                      Open file
                    </Button>
                  </div>
                  <DiffBlock lines={file.lines} mode={mode} fontSize={fontSize} />
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
