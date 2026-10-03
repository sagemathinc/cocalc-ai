/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { PersistMaintenanceConfig } from "./config";
import { PersistMaintenanceCatalog } from "./catalog";
import { fileIdentity, PersistMaintenancePathSafety } from "./path-safety";

interface ScanCursor {
  startedAt: number;
  roots: string[];
  rootIndex: number;
  stack: string[];
  current?: {
    path: string;
    index: number;
    after?: string;
    template?: { namePrefix: string; nameSuffix: string; pathSuffix: string };
  };
  files: number;
  entries: number;
  bytes: number;
}

export interface PersistMaintenanceScanResult {
  complete: boolean;
  startedAt: number;
  completedAt?: number;
  files: number;
  entries: number;
  bytes: number;
  errors: string[];
}

const PLACEHOLDER = /\[[a-zA-Z0-9_]+\]/;

function rootCursor(template: string): NonNullable<ScanCursor["current"]> {
  const absolute = resolve(template);
  const match = absolute.match(PLACEHOLDER);
  if (!match || match.index == null) return { path: absolute, index: 0 };
  const before = absolute.slice(0, match.index);
  const after = absolute.slice(match.index + match[0].length);
  const parent = dirname(before);
  const namePrefix = basename(before);
  const slash = after.indexOf("/");
  const nameSuffix = slash < 0 ? after : after.slice(0, slash);
  const pathSuffix = slash < 0 ? "" : after.slice(slash + 1);
  return {
    path: parent,
    index: 0,
    template: { namePrefix, nameSuffix, pathSuffix },
  };
}

export class PersistMaintenanceScanner {
  constructor(
    private readonly catalog: PersistMaintenanceCatalog,
    private readonly safety: PersistMaintenancePathSafety,
    private readonly config: PersistMaintenanceConfig,
  ) {}

  private loadCursor(): ScanCursor | undefined {
    const raw = this.catalog.getState("scan_cursor");
    if (!raw) return;
    try {
      return JSON.parse(raw) as ScanCursor;
    } catch {
      return;
    }
  }

  private saveCursor(cursor?: ScanCursor): void {
    this.catalog.setState("scan_cursor", cursor ? JSON.stringify(cursor) : "");
  }

  async scanBatch(): Promise<PersistMaintenanceScanResult> {
    const deadline = Date.now() + this.config.scanTimeLimitMs;
    let cursor = this.loadCursor();
    if (!cursor) {
      cursor = {
        startedAt: Date.now(),
        roots: [...new Set(this.config.rootTemplates)],
        rootIndex: 0,
        stack: [],
        files: 0,
        entries: 0,
        bytes: 0,
      };
      this.catalog.setState("scan_started_at", `${cursor.startedAt}`);
    }
    const startEntries = cursor.entries;
    const startBytes = cursor.bytes;
    const errors: string[] = [];
    let entries: Dirent[] | undefined;

    while (
      cursor.entries - startEntries < this.config.scanEntryLimit &&
      cursor.bytes - startBytes < this.config.scanByteLimit &&
      Date.now() < deadline
    ) {
      if (!cursor.current) {
        const next = cursor.stack.pop();
        if (next) cursor.current = { path: next, index: 0 };
        else {
          const root = cursor.roots[cursor.rootIndex++];
          if (!root) break;
          cursor.current = rootCursor(root);
        }
      }
      if (!entries) {
        try {
          entries = await readdir(cursor.current.path, { withFileTypes: true });
          entries.sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          );
          // Names survive directory insertions/deletions between batches. Old
          // positional cursors restart this directory rather than skip entries.
          cursor.current.index =
            cursor.current.after == null
              ? 0
              : entries.findIndex(
                  (entry) => entry.name > cursor.current!.after!,
                );
          if (cursor.current.index < 0) cursor.current.index = entries.length;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            errors.push(`${cursor.current.path}: ${err}`);
          }
          cursor.current = undefined;
          continue;
        }
      }
      if (cursor.current.index >= entries.length) {
        cursor.current = undefined;
        entries = undefined;
        continue;
      }
      const entry = entries[cursor.current.index++];
      cursor.current.after = entry.name;
      cursor.entries += 1;
      const path = join(cursor.current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      // Template discovery shares the persisted cursor and budgets with file
      // discovery, instead of expanding every host project before the deadline.
      if (cursor.current.template) {
        const { namePrefix, nameSuffix, pathSuffix } = cursor.current.template;
        if (
          entry.isDirectory() &&
          entry.name.startsWith(namePrefix) &&
          entry.name.endsWith(nameSuffix) &&
          entry.name.length > namePrefix.length + nameSuffix.length
        ) {
          cursor.stack.push(join(path, pathSuffix));
        }
        continue;
      }
      if (entry.isDirectory()) {
        cursor.stack.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
      if (
        entry.name.includes(".compact-") ||
        entry.name.includes(".rollback-") ||
        entry.name.endsWith("-wal") ||
        entry.name.endsWith("-shm")
      ) {
        continue;
      }
      try {
        const checked = this.safety.assertExistingRegularFile(path);
        let walSize = 0;
        try {
          walSize = (await lstat(`${checked.path}-wal`)).size;
        } catch {}
        const identity = fileIdentity(checked.stat, walSize);
        this.catalog.observeFile(checked.path, identity);
        cursor.files += 1;
        cursor.bytes += identity.sizeBytes;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push(`${path}: ${err}`);
        }
      }
    }

    const complete =
      !cursor.current &&
      cursor.stack.length === 0 &&
      cursor.rootIndex >= cursor.roots.length;
    if (!complete) {
      this.saveCursor(cursor);
      return {
        complete: false,
        startedAt: cursor.startedAt,
        files: cursor.files,
        entries: cursor.entries,
        bytes: cursor.bytes,
        errors,
      };
    }

    for (const path of this.catalog.listStalePresent(cursor.startedAt)) {
      try {
        this.safety.assertExistingRegularFile(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.catalog.markMissing(path);
        }
      }
    }
    const completedAt = Date.now();
    this.catalog.setState("scan_completed_at", `${completedAt}`);
    this.catalog.setState("scan_files", `${cursor.files}`);
    this.saveCursor(undefined);
    return {
      complete: true,
      startedAt: cursor.startedAt,
      completedAt,
      files: cursor.files,
      entries: cursor.entries,
      bytes: cursor.bytes,
      errors,
    };
  }
}
