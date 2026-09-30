/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const MAX_FILES = 128;
// Base64 plus JSON must stay below the account registry's 2 MB payload limit.
const MAX_BYTES = 1_400_000;
const MAX_FILE_BYTES = 1024 * 1024;

type Entry = { path: string; content: string };
type Bundle = { version: 1; files: Entry[] };

function safeRelativePath(path: string): boolean {
  return (
    !!path &&
    path.length <= 1024 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

/** Store an opaque, bounded snapshot; never interpret provider credential files. */
export async function packClaudeSubscriptionHome(
  home: string,
  allowedPaths?: ReadonlySet<string>,
): Promise<string> {
  const root = resolve(home);
  const files: Entry[] = [];
  let totalBytes = 0;
  async function include(fullPath: string): Promise<void> {
    const path = relative(root, fullPath).split(sep).join("/");
    if (!safeRelativePath(path)) throw Error("Invalid Claude auth path");
    let parent = root;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      if (!(await lstat(parent)).isDirectory())
        throw Error("Claude auth home contains an unsupported entry");
    }
    if (!(await lstat(fullPath)).isFile())
      throw Error("Claude auth home contains an unsupported entry");
    if (files.length >= MAX_FILES)
      throw Error("Claude auth home has too many files");
    const bytes = await readFile(fullPath);
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_BYTES)
      throw Error("Claude auth home is too large");
    files.push({ path, content: bytes.toString("base64") });
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      await include(fullPath);
    }
  }
  if (allowedPaths) {
    for (const path of allowedPaths) {
      if (!safeRelativePath(path)) throw Error("Invalid Claude auth path");
      await include(resolve(root, path));
    }
  } else {
    await visit(root);
  }
  if (allowedPaths && files.length !== allowedPaths.size)
    throw Error("Claude auth files changed unexpectedly");
  return JSON.stringify({ version: 1, files } satisfies Bundle);
}

export function claudeSubscriptionBundlePaths(
  payload: string,
): ReadonlySet<string> {
  const bundle = JSON.parse(payload) as Bundle;
  if (bundle?.version !== 1 || !Array.isArray(bundle.files))
    throw Error("Invalid Claude auth bundle");
  return new Set(bundle.files.map(({ path }) => path));
}

/** Validate a bundle and return its files by relative path; never writes. */
export function claudeSubscriptionBundleFiles(
  payload: string,
): Map<string, Buffer> {
  if (Buffer.byteLength(payload) > MAX_BYTES * 2)
    throw Error("Claude auth bundle is too large");
  let bundle: Bundle;
  try {
    bundle = JSON.parse(payload);
  } catch {
    throw Error("Invalid Claude auth bundle");
  }
  if (
    bundle?.version !== 1 ||
    !Array.isArray(bundle.files) ||
    bundle.files.length > MAX_FILES
  )
    throw Error("Invalid Claude auth bundle");
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const entry of bundle.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !safeRelativePath(entry.path) ||
      typeof entry.content !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        entry.content,
      ) ||
      files.has(entry.path)
    )
      throw Error("Invalid Claude auth bundle entry");
    const bytes = Buffer.from(entry.content, "base64");
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_BYTES)
      throw Error("Claude auth bundle is too large");
    files.set(entry.path, bytes);
  }
  return files;
}

/** Pack validated files (e.g. a merge of two bundles) into a bundle. */
export function packClaudeSubscriptionBundle(
  files: ReadonlyMap<string, Buffer>,
): string {
  if (files.size > MAX_FILES)
    throw Error("Claude auth home has too many files");
  let totalBytes = 0;
  const entries: Entry[] = [];
  for (const [path, bytes] of files) {
    if (!safeRelativePath(path)) throw Error("Invalid Claude auth path");
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_BYTES)
      throw Error("Claude auth home is too large");
    entries.push({ path, content: bytes.toString("base64") });
  }
  return JSON.stringify({ version: 1, files: entries } satisfies Bundle);
}

/**
 * Files that differ between two snapshots of the same bundle. Contents are
 * compared as opaque bytes; provider credential files are never interpreted.
 */
export function changedClaudeSubscriptionFiles(
  baseline: ReadonlyMap<string, Buffer>,
  current: ReadonlyMap<string, Buffer>,
): Map<string, Buffer> {
  const changed = new Map<string, Buffer>();
  for (const [path, bytes] of current) {
    const before = baseline.get(path);
    if (!before || !before.equals(bytes)) changed.set(path, bytes);
  }
  return changed;
}

/** Restore only into a fresh private directory not mounted into a project. */
export async function restoreClaudeSubscriptionHome(
  home: string,
  payload: string,
): Promise<void> {
  const files = claudeSubscriptionBundleFiles(payload);
  const root = resolve(home);
  for (const [path, bytes] of files) {
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw Error("Invalid Claude auth path");
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
}

const READER_TIMEOUT_MS = 10_000;

// Runs in a short-lived child process: a controller can still write its home,
// so reads must not follow a swapped-in symlink (openat2 resolves every
// component beneath the home without symlinks) nor hang the project host on a
// swapped-in FIFO or device (the parent kills the child on timeout).
const HOME_READER = `
const [addon, home, maxFileRaw, maxTotalRaw, ...paths] = process.argv.slice(1);
const { SandboxRoot } = require(addon);
const fs = require("node:fs");
const maxFile = Number(maxFileRaw);
const maxTotal = Number(maxTotalRaw);
const root = new SandboxRoot(home);
const files = [];
let total = 0;
for (const path of paths) {
  if ((root.stat(path).mode & 0o170000) !== 0o100000)
    throw new Error("unsupported entry");
  const fd = root.openRead(path);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("unsupported entry");
    const buffer = Buffer.alloc(maxFile + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (read === 0) break;
      size += read;
    }
    total += size;
    if (size > maxFile || total > maxTotal) throw new Error("too large");
    files.push([path, buffer.subarray(0, size).toString("base64")]);
  } finally {
    fs.closeSync(fd);
  }
}
process.stdout.write(JSON.stringify(files));
`;

/**
 * Read exactly `paths` (relative, pre-authorized) from a Claude home that its
 * controller may still be modifying. Bounded in size and time; any symlink,
 * non-regular file or oversized file fails the whole read.
 */
export async function readClaudeSubscriptionHomeFiles(
  home: string,
  paths: Iterable<string>,
  { timeoutMs = READER_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<Map<string, Buffer>> {
  const wanted = [...paths];
  for (const path of wanted)
    if (!safeRelativePath(path)) throw Error("Invalid Claude auth path");
  if (wanted.length > MAX_FILES)
    throw Error("Claude auth home has too many files");
  const maxOutput = Math.ceil((MAX_BYTES * 4) / 3) + 64 * (wanted.length + 1);
  const child = spawn(
    process.execPath,
    [
      "-e",
      HOME_READER,
      require.resolve("@cocalc/openat2"),
      resolve(home),
      `${MAX_FILE_BYTES}`,
      `${MAX_BYTES}`,
      ...wanted,
    ],
    { stdio: ["ignore", "pipe", "ignore"], env: {} },
  );
  const output = await new Promise<string>((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const stop = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      fail(error);
    };
    const timer = setTimeout(
      () => stop(Error("Claude auth home read timed out")),
      timeoutMs,
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutput) stop(Error("Claude auth home is too large"));
      else chunks.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      stop(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0)
        return stop(Error("Claude auth home contains an unsupported entry"));
      done(Buffer.concat(chunks).toString("utf8"));
    });
  });
  let entries: unknown;
  try {
    entries = JSON.parse(output);
  } catch {
    throw Error("Claude auth home read failed");
  }
  if (
    !Array.isArray(entries) ||
    entries.length !== wanted.length ||
    entries.some(
      (entry, index) =>
        !Array.isArray(entry) ||
        entry[0] !== wanted[index] ||
        typeof entry[1] !== "string",
    )
  )
    throw Error("Claude auth home read failed");
  return claudeSubscriptionBundleFiles(
    JSON.stringify({
      version: 1,
      files: (entries as [string, string][]).map(([path, content]) => ({
        path,
        content,
      })),
    }),
  );
}
