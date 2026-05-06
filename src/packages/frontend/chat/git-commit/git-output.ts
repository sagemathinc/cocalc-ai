/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  GitLogEntry,
  GitShowFile,
  GitShowParsed,
  GitShowSummary,
  HeadStatusEntry,
} from "./types";

export const MAX_GIT_SHOW_LINES = 20_000;
const GIT_LOG_FETCH_COUNT = 750;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

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

export function parseGitShowOutput(
  stdout: string,
  repoRoot?: string,
): GitShowParsed {
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

export function parseGitLogOutput(stdout: string): GitLogEntry[] {
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

export function parseGitStatusOutput(stdout: string): HeadStatusEntry[] {
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
