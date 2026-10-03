/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Text file tools for subscription-mode Claude. Each runs short scripts
// through the same scoped project executor as project_exec, so they grant no
// access beyond what project_exec already has.

import { createHash, randomBytes } from "node:crypto";
import type { ProjectJobExecutor } from "./claude-project-jobs";

export const MAX_FILE_TOOL_BYTES = 1_000_000;
const MAX_READ_RETURN_BYTES = 256 * 1024;
const DEFAULT_READ_LINES = 2000;
// One shell argument must stay under the kernel's 128 KiB per-string limit.
const WRITE_CHUNK_BASE64 = 96 * 1024;
const STEP_TIMEOUT_MS = 30_000;

type ToolError = { error: string };

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function runCaptured(
  execute: ProjectJobExecutor,
  script: string,
  signal: AbortSignal,
  maxStdout: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let overflow = false;
  const result = await execute(script, undefined, signal, {
    timeoutMs: STEP_TIMEOUT_MS,
    onOutput: (stream, data) => {
      if (stream === "stdout") {
        if (stdout.length + data.length > maxStdout) overflow = true;
        else stdout += data;
      } else if (stderr.length < 4096) stderr += data;
    },
    onCleanupConfirmed: () => {},
  });
  if (!stdout && result.stdout) {
    if (result.stdout.length > maxStdout) overflow = true;
    else stdout = result.stdout;
  }
  if (!stderr && result.stderr) stderr = result.stderr.slice(0, 4096);
  if (overflow) return { code: 1, stdout: "", stderr: "output too large" };
  return { code: result.code, stdout, stderr };
}

export function validPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.trim().length > 0 &&
    path.length <= 4096 &&
    !path.includes("\0")
  );
}

const PATH_ERROR = { error: "path must be a non-empty file path" };

function base64Size(bytes: number): number {
  return Math.ceil(bytes / 3) * 4 + 64;
}

// Reads a whole regular file (resolving symlinks) with its real path.
async function readWholeFile(
  execute: ProjectJobExecutor,
  path: string,
  signal: AbortSignal,
): Promise<{ realPath: string; bytes: Buffer } | ToolError> {
  const limit = MAX_FILE_TOOL_BYTES;
  const script = [
    `p=${shellQuote(path)}`,
    `[ -f "$p" ] || { echo "not a readable file: $p" >&2; exit 2; }`,
    `r=$(realpath -- "$p") || exit 2`,
    `s=$(stat -L -c %s -- "$p") || exit 2`,
    `[ "$s" -le ${limit} ] || { echo "file is $s bytes; the limit is ${limit} bytes. Use project_read_file with offset/limit, or project_exec." >&2; exit 3; }`,
    `printf '%s\\n' "$r"`,
    `base64 -w0 -- "$p"`,
  ].join("\n");
  const out = await runCaptured(
    execute,
    script,
    signal,
    base64Size(limit) + 8192,
  );
  if (out.code !== 0)
    return { error: out.stderr.trim() || `could not read ${path}` };
  const newline = out.stdout.indexOf("\n");
  return {
    realPath: out.stdout.slice(0, newline),
    bytes: Buffer.from(out.stdout.slice(newline + 1).trim(), "base64"),
  };
}

function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

export async function readProjectFile(
  execute: ProjectJobExecutor,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<
  | {
      path: string;
      total_lines: number;
      start_line: number;
      end_line: number;
      truncated: boolean;
      content: string;
    }
  | ToolError
> {
  const { path } = args;
  if (!validPath(path)) return PATH_ERROR;
  const offset = args.offset ?? 1;
  const limit = args.limit ?? DEFAULT_READ_LINES;
  if (!Number.isInteger(offset) || (offset as number) < 1)
    return { error: "offset must be a positive line number" };
  if (!Number.isInteger(limit) || (limit as number) < 1)
    return { error: "limit must be a positive number of lines" };
  const start = offset as number;
  const end = start + (limit as number) - 1;
  const script = [
    `p=${shellQuote(path)}`,
    `[ -f "$p" ] || { echo "not a readable file: $p" >&2; exit 2; }`,
    `wc -l < "$p" || exit 2`,
    `sed -n '${start},${end}p;${end}q' -- "$p" | head -c ${MAX_READ_RETURN_BYTES + 1} | base64 -w0`,
  ].join("\n");
  const out = await runCaptured(
    execute,
    script,
    signal,
    base64Size(MAX_READ_RETURN_BYTES + 1) + 64,
  );
  if (out.code !== 0)
    return { error: out.stderr.trim() || `could not read ${path}` };
  const newline = out.stdout.indexOf("\n");
  let totalLines = Number(out.stdout.slice(0, newline).trim());
  let bytes = Buffer.from(out.stdout.slice(newline + 1).trim(), "base64");
  if (isBinary(bytes))
    return {
      error: `${path} looks binary. Use project_read_image for images, or project_exec.`,
    };
  const truncated = bytes.length > MAX_READ_RETURN_BYTES;
  if (truncated) bytes = bytes.subarray(0, MAX_READ_RETURN_BYTES);
  let text = bytes.toString("utf8");
  // wc -l counts newlines; a final line without one still counts.
  if (!Number.isFinite(totalLines)) totalLines = 0;
  const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
  if (truncated && lines.length > 1) lines.pop();
  if (start === 1 && lines.length > totalLines) totalLines = lines.length;
  const content = lines
    .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
    .join("\n");
  return {
    path,
    total_lines: Math.max(totalLines, start + lines.length - 1),
    start_line: start,
    end_line: start + lines.length - 1,
    truncated,
    content,
  };
}

// Writes bytes to realPath through a temporary file in the same directory and
// an atomic rename. expectSha guards read-modify-write against other writers.
async function writeAtomically(
  execute: ProjectJobExecutor,
  realPath: string,
  bytes: Buffer,
  signal: AbortSignal,
  options: { expectSha?: string; createDirs?: boolean },
): Promise<ToolError | undefined> {
  const q = shellQuote(realPath);
  const tmp = shellQuote(
    `${realPath}.cocalc-write-${randomBytes(6).toString("hex")}`,
  );
  const encoded = bytes.toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += WRITE_CHUNK_BASE64)
    chunks.push(encoded.slice(i, i + WRITE_CHUNK_BASE64));
  if (chunks.length === 0) chunks.push("");
  const cleanup = () =>
    runCaptured(execute, `rm -f -- ${tmp}`, signal, 1024).catch(() => {});
  for (let i = 0; i < chunks.length; i++) {
    const prepare =
      i === 0
        ? [
            options.createDirs
              ? `mkdir -p -- "$(dirname -- ${q})" || exit 2`
              : `[ -d "$(dirname -- ${q})" ] || { echo "directory does not exist: $(dirname -- ${q}); pass create_dirs: true" >&2; exit 2; }`,
          ]
        : [];
    const script = [
      ...prepare,
      `printf '%s' '${chunks[i]}' | base64 -d ${i === 0 ? ">" : ">>"} ${tmp} || exit 2`,
    ].join("\n");
    const out = await runCaptured(execute, script, signal, 1024);
    if (out.code !== 0) {
      await cleanup();
      return { error: out.stderr.trim() || `could not write ${realPath}` };
    }
  }
  const finish = [
    options.expectSha
      ? `[ "$(sha256sum < ${q} | cut -c1-64)" = "${options.expectSha}" ] || { rm -f -- ${tmp}; echo "file changed since it was read; read it again and retry" >&2; exit 4; }`
      : "",
    `[ -e ${q} ] && chmod --reference=${q} -- ${tmp} 2>/dev/null`,
    `mv -f -- ${tmp} ${q} || { rm -f -- ${tmp}; exit 2; }`,
  ]
    .filter(Boolean)
    .join("\n");
  const out = await runCaptured(execute, finish, signal, 1024);
  if (out.code !== 0) {
    await cleanup();
    return { error: out.stderr.trim() || `could not write ${realPath}` };
  }
}

export async function writeProjectFile(
  execute: ProjectJobExecutor,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ path: string; bytes: number } | ToolError> {
  const { path, content } = args;
  if (!validPath(path)) return PATH_ERROR;
  if (typeof content !== "string") return { error: "content must be a string" };
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_FILE_TOOL_BYTES)
    return {
      error: `content is ${bytes.length} bytes; the limit is ${MAX_FILE_TOOL_BYTES}`,
    };
  const resolved = await runCaptured(
    execute,
    `realpath -m -- ${shellQuote(path)}`,
    signal,
    8192,
  );
  if (resolved.code !== 0)
    return { error: resolved.stderr.trim() || `could not resolve ${path}` };
  const failed = await writeAtomically(
    execute,
    resolved.stdout.trim(),
    bytes,
    signal,
    { createDirs: args.create_dirs === true },
  );
  return failed ?? { path, bytes: bytes.length };
}

export async function editProjectFile(
  execute: ProjectJobExecutor,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ path: string; replacements: number } | ToolError> {
  const { path, old_string, new_string } = args;
  if (!validPath(path)) return PATH_ERROR;
  if (typeof old_string !== "string" || old_string.length === 0)
    return { error: "old_string must be a non-empty string" };
  if (typeof new_string !== "string")
    return { error: "new_string must be a string" };
  if (old_string === new_string)
    return { error: "old_string and new_string are identical" };
  const file = await readWholeFile(execute, path, signal);
  if ("error" in file) return file;
  if (isBinary(file.bytes))
    return { error: `${path} looks binary; it cannot be edited as text` };
  const text = file.bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(file.bytes) !== 0)
    return { error: `${path} is not valid UTF-8 text` };
  const count = text.split(old_string).length - 1;
  if (count === 0)
    return {
      error:
        "old_string was not found. It must match the file exactly, including whitespace, without the line-number prefixes from project_read_file.",
    };
  if (count > 1 && args.replace_all !== true)
    return {
      error: `old_string occurs ${count} times. Include more surrounding text to make it unique, or pass replace_all: true.`,
    };
  const updated = Buffer.from(text.split(old_string).join(new_string), "utf8");
  if (updated.length > MAX_FILE_TOOL_BYTES)
    return {
      error: `the edited file would exceed ${MAX_FILE_TOOL_BYTES} bytes`,
    };
  const failed = await writeAtomically(
    execute,
    file.realPath,
    updated,
    signal,
    { expectSha: createHash("sha256").update(file.bytes).digest("hex") },
  );
  return failed ?? { path, replacements: count };
}
