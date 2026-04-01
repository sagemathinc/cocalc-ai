/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import path from "node:path";

function truncateTextToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const normalized = `${text ?? ""}`;
  if (!normalized) {
    return { text: "", truncated: false };
  }
  const buffer = Buffer.from(normalized, "utf8");
  if (buffer.length <= maxBytes) {
    return { text: normalized, truncated: false };
  }
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

export function resolveAutomationCommandCwd({
  chatPath,
  commandCwd,
}: {
  chatPath: string;
  commandCwd?: string | null;
}): string {
  const explicit = `${commandCwd ?? ""}`.trim();
  if (explicit) return explicit;
  const dir = path.posix.dirname(`${chatPath || ""}`.trim() || ".");
  return dir && dir !== "." ? dir : "/";
}

export function captureCommandAutomationOutput({
  stdout,
  stderr,
  maxOutputBytes,
  preferStderr = false,
}: {
  stdout: string;
  stderr: string;
  maxOutputBytes: number;
  preferStderr?: boolean;
}): {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  truncated: boolean;
} {
  const safeBudget = Math.max(1, Math.floor(maxOutputBytes || 0));
  const hasStdout = !!stdout;
  const hasStderr = !!stderr;
  let stdoutBudget = safeBudget;
  let stderrBudget = safeBudget;
  if (hasStdout && hasStderr) {
    if (preferStderr) {
      stderrBudget = Math.ceil((2 * safeBudget) / 3);
      stdoutBudget = Math.max(0, safeBudget - stderrBudget);
    } else {
      stderrBudget = Math.ceil(safeBudget / 2);
      stdoutBudget = Math.max(0, safeBudget - stderrBudget);
    }
  }
  const stdoutResult = truncateTextToBytes(stdout, stdoutBudget);
  const stderrResult = truncateTextToBytes(stderr, stderrBudget);
  return {
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    stdoutTruncated: stdoutResult.truncated,
    stderrTruncated: stderrResult.truncated,
    truncated: stdoutResult.truncated || stderrResult.truncated,
  };
}

export function formatCommandAutomationMarkdown({
  command,
  cwd,
  timeoutMs,
  exitCode,
  signal,
  stdout,
  stderr,
  truncated,
  maxOutputBytes,
}: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  exitCode?: number | null;
  signal?: string;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  maxOutputBytes: number;
}): string {
  const lines = [
    "**Command**",
    "```bash",
    command,
    "```",
    "",
    `**Working directory:** \`${cwd}\``,
  ];
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
    lines.push(`**Timeout:** ${Math.max(1, Math.round(timeoutMs / 1000))} sec`);
  }
  if (typeof exitCode === "number") {
    lines.push(`**Exit code:** ${exitCode}`);
  } else if (signal) {
    lines.push(`**Signal:** ${signal}`);
  }
  if (stdout) {
    lines.push("", "**stdout**", "```text", stdout, "```");
  }
  if (stderr) {
    lines.push("", "**stderr**", "```text", stderr, "```");
  }
  if (!stdout && !stderr) {
    lines.push("", "_Command completed with no captured output._");
  }
  if (truncated) {
    lines.push(
      "",
      `_Captured output was truncated at ${Math.max(
        1,
        Math.round(maxOutputBytes / 1024),
      )} KB._`,
    );
  }
  return lines.join("\n");
}
