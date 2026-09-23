/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { opendir } from "node:fs/promises";
import type { Dir } from "node:fs";
import { join, resolve } from "node:path";

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  ".cache",
  ".pnpm",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "__pycache__",
  "dist",
  "build",
]);

/** Incremental standalone-Lite backfill. No walk is triggered by a browser read. */
export class LiteArtifactDiscovery {
  private stack: { path: string; directory?: Dir }[] = [];
  private stopped = false;

  constructor(
    private readonly root: string,
    private readonly privateDirectory: string,
  ) {}

  /** At most 100 directory entries per call, with at most 32 open directories. */
  async page(): Promise<string[]> {
    if (this.stopped) return [];
    if (!this.stack.length) this.stack.push({ path: resolve(this.root) });
    const paths: string[] = [];
    for (
      let examined = 0;
      examined < 100 && this.stack.length && !this.stopped;
      examined++
    ) {
      const frame = this.stack[this.stack.length - 1];
      if (!frame.directory) {
        try {
          frame.directory = await opendir(frame.path);
        } catch (err) {
          this.stack.pop();
          if (
            ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(
              (err as NodeJS.ErrnoException).code ?? "",
            )
          )
            continue;
          throw err;
        }
      }
      const entry = await frame.directory.read();
      if (!entry) {
        await frame.directory.close();
        this.stack.pop();
        continue;
      }
      const path = join(frame.path, entry.name);
      if (path === resolve(this.privateDirectory)) continue;
      // Never follow symlinks or recurse into dependency/VCS/cache trees.
      if (
        entry.isDirectory() &&
        this.stack.length < 32 &&
        !SKIP_DIRECTORIES.has(entry.name)
      ) {
        this.stack.push({ path });
      } else if (entry.isFile() && entry.name.endsWith(".chat")) {
        paths.push(path);
      }
    }
    return paths;
  }

  /** Call only after the service's in-flight discovery has drained. */
  async close(): Promise<void> {
    this.stopped = true;
    for (const frame of this.stack) await frame.directory?.close();
    this.stack = [];
  }
}
