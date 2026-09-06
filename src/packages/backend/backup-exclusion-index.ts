/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  backupExclusionObjectKey,
  withBackupEvidenceAbort,
  withVerifiedBackupExclusionFile,
} from "./backup-exclusion-store";
import type { BackupExclusionStoreOptions } from "./backup-exclusion-store";
import {
  backupReportHeaderSha256,
  verifyBackupExclusionReport,
} from "./backup-exclusion-report";
import type {
  BackupExclusionSample,
  VerifiedBackupExclusionInventory,
} from "./backup-exclusion-report";
import type {
  BackupExclusionBinding,
  BackupExclusionReadLimits,
} from "@cocalc/util/types/backup-evidence";

const PAGE_SIZE = 50;
const SQLITE_PAGE_BYTES = 4096;

export interface BackupExclusionPage {
  files: BackupExclusionSample[];
  next_cursor: string | null;
  excluded_files: string;
}

export interface BackupExclusionIndex {
  readonly bytes: number;
  readonly inventory: VerifiedBackupExclusionInventory;
  // Read-only access. Cursor is a position, NOT project/account authorization.
  page(cursor?: string | null): BackupExclusionPage;
  has(entry: BackupExclusionSample): boolean;
}

// Authorization and a protected owning-bay binding are required before entry.
// Data is fetched directly from the object store, not proxied through a hub.
export async function readIndexedBackupExclusionReport<T>(
  options: BackupExclusionStoreOptions & { max_index_bytes: number },
  consume: (index: BackupExclusionIndex) => Promise<T>,
): Promise<T> {
  const { max_index_bytes, timeout_ms } = options;
  const limits = { ...options.limits };
  return await withVerifiedBackupExclusionFile(
    options,
    async (report, path, signal) =>
      await withBackupExclusionIndex(
        {
          path,
          binding: report.binding,
          limits,
          max_index_bytes,
          timeout_ms,
          signal,
        },
        consume,
      ),
  );
}

function invalid(): never {
  throw new Error("Invalid backup exclusion index request or limits");
}

/**
 * Build a private, bounded index and lend a read-only handle only after full
 * report verification. The consumer owns its authorized request/session lifetime;
 * the index is removed after the consumer settles, including on failure. Do not
 * rebuild per page: keep this handle for the bounded browsing session/cache lease.
 * Durable NDJSON remains the source of truth and survives this disposable index.
 *
 * The input is an already staged private regular file, not a project path. It is
 * read with a deadline and hashed again while indexing. No report-sized arrays or
 * OFFSET scans are used. SQLite page count bounds physical index expansion, and
 * raw-byte unique paths prevent duplicate report rows from inflating coverage.
 */
export async function withBackupExclusionIndex<T>(
  options: {
    path: string;
    binding: BackupExclusionBinding;
    limits: BackupExclusionReadLimits;
    max_index_bytes: number;
    timeout_ms: number;
    signal?: AbortSignal;
  },
  consume: (index: BackupExclusionIndex) => Promise<T>,
): Promise<T> {
  // Validate and capture before yielding; never derive a filesystem path from a
  // request cursor. The binding is also the cross-backup cursor fence.
  backupExclusionObjectKey(options.binding);
  const binding: BackupExclusionBinding = structuredClone(options.binding);
  const limits = { ...options.limits };
  const { max_index_bytes, timeout_ms, path } = options;
  if (
    !Number.isSafeInteger(max_index_bytes) ||
    max_index_bytes < SQLITE_PAGE_BYTES ||
    max_index_bytes > SQLITE_PAGE_BYTES * 0xfffffffe ||
    !Number.isSafeInteger(timeout_ms) ||
    timeout_ms <= 0 ||
    timeout_ms > 0x7fffffff
  )
    invalid();
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout_ms)])
    : AbortSignal.timeout(timeout_ms);
  signal.throwIfAborted();
  const identity = backupReportHeaderSha256(binding);
  const dir = await mkdtemp(join(tmpdir(), "cocalc-exclusion-index-"));
  let db: DatabaseSync | undefined;
  let active = false;
  try {
    const indexPath = join(dir, "index.sqlite");
    const file = await open(indexPath, "wx", 0o600);
    await file.close();
    db = new DatabaseSync(indexPath);
    db.exec(`
      PRAGMA page_size=${SQLITE_PAGE_BYTES};
      PRAGMA max_page_count=${Math.floor(max_index_bytes / SQLITE_PAGE_BYTES)};
      PRAGMA journal_mode=OFF;
      PRAGMA synchronous=OFF;
      PRAGMA cache_size=-1024;
      PRAGMA mmap_size=0;
      PRAGMA temp_store=FILE;
      PRAGMA trusted_schema=OFF;
      CREATE TABLE excluded (
        ordinal INTEGER PRIMARY KEY,
        path BLOB NOT NULL UNIQUE,
        apparent_bytes TEXT NOT NULL,
        acknowledgement_key TEXT
      );
      BEGIN;
    `);
    const insert = db.prepare(
      "INSERT INTO excluded (ordinal, path, apparent_bytes, acknowledgement_key) VALUES (?, ?, ?, ?)",
    );
    let ordinal = 0;
    const chunks = createReadStream(path, { signal });
    let inventory: VerifiedBackupExclusionInventory;
    try {
      inventory = await verifyBackupExclusionReport({
        ...limits,
        chunks,
        sha256: binding.report.sha256,
        header_sha256: binding.report.header_sha256,
        policy_sha256: binding.policy_sha256,
        stage_entry: (entry) => {
          signal.throwIfAborted();
          insert.run(
            ++ordinal,
            Buffer.from(entry.path_hex, "hex"),
            entry.apparent_bytes,
            entry.acknowledgement_key,
          );
        },
      });
    } finally {
      chunks.destroy();
    }
    if (inventory.bytes !== binding.report.bytes) invalid();
    signal.throwIfAborted();
    db.exec("COMMIT; PRAGMA query_only=ON;");
    const bytes = (await stat(indexPath)).size;
    if (bytes > max_index_bytes) invalid();
    const select = db.prepare(
      "SELECT ordinal, path, apparent_bytes, acknowledgement_key FROM excluded WHERE ordinal > ? ORDER BY ordinal LIMIT ?",
    );
    const find = db.prepare(
      "SELECT apparent_bytes, acknowledgement_key FROM excluded WHERE path = ?",
    );
    const usable = () => {
      if (!active) throw new Error("Backup exclusion index lease has ended");
      signal.throwIfAborted();
    };
    active = true;
    return await withBackupEvidenceAbort(signal, () =>
      consume({
        bytes,
        inventory: structuredClone(inventory),
        page(cursor) {
          usable();
          let after = 0;
          if (cursor != null) {
            if (typeof cursor !== "string" || cursor.length > 100) invalid();
            const match = /^([0-9a-f]{64}):([1-9][0-9]{0,15})$/.exec(cursor);
            if (!match || match[1] !== identity) invalid();
            after = Number(match[2]);
            if (!Number.isSafeInteger(after) || after >= ordinal) invalid();
          }
          const rows = select.all(after, PAGE_SIZE + 1);
          const more = rows.length > PAGE_SIZE;
          if (more) rows.pop();
          return {
            files: rows.map((row) => ({
              path_hex: Buffer.from(row.path as Uint8Array).toString("hex"),
              apparent_bytes: row.apparent_bytes as string,
              acknowledgement_key: row.acknowledgement_key as string | null,
            })),
            next_cursor: more
              ? `${identity}:${rows[rows.length - 1].ordinal}`
              : null,
            excluded_files: inventory.excluded_files,
          };
        },
        has(entry) {
          usable();
          if (
            !entry ||
            typeof entry.path_hex !== "string" ||
            !/^(?:[0-9a-f]{2}){1,4096}$/.test(entry.path_hex)
          )
            invalid();
          const row = find.get(Buffer.from(entry.path_hex, "hex"));
          return (
            row != null &&
            row.apparent_bytes === entry.apparent_bytes &&
            row.acknowledgement_key === entry.acknowledgement_key
          );
        },
      }),
    );
  } finally {
    active = false;
    try {
      db?.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
