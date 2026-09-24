/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

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

/** Restore only into a fresh private directory not mounted into a project. */
export async function restoreClaudeSubscriptionHome(
  home: string,
  payload: string,
): Promise<void> {
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
  const root = resolve(home);
  const seen = new Set<string>();
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
      seen.has(entry.path)
    )
      throw Error("Invalid Claude auth bundle entry");
    seen.add(entry.path);
    const bytes = Buffer.from(entry.content, "base64");
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_BYTES)
      throw Error("Claude auth bundle is too large");
    const target = resolve(root, entry.path);
    if (!target.startsWith(root + sep)) throw Error("Invalid Claude auth path");
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
}
