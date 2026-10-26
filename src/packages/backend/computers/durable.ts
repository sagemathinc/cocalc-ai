/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Small files the connector must not lose or half-write: written to a temporary
// file, fsynced, renamed over the target, and the directory fsynced. A crash
// leaves either the old or the new content, never a mix.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Create a directory only this user can read (0700). */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writeDurable(path: string, content: string): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}

export function writeDurableJson(path: string, value: unknown): void {
  writeDurable(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text) as T;
}

export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms can't fsync a directory; the rename is still atomic.
  } finally {
    if (fd != null) closeSync(fd);
  }
}
