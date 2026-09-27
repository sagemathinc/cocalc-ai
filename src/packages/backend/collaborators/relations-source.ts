/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { createHash } from "node:crypto";
import { readChatRelationArchive } from "@cocalc/backend/chat-store/sqlite-offload";
import type { CollaborationRelation } from "@cocalc/util/collaboration-relations";
import { projectChatIdentityRows } from "@cocalc/util/collaboration-chat-identity";
import {
  chatIdentityKey,
  chatIdentityStorageKey,
} from "@cocalc/util/collaboration-chat-identity-markers";
import {
  collaborationCopySourceFingerprint,
  readCollaborationSource,
} from "./filesystem";
import { withCollaborationCopyLock } from "./copy-locks";
import type {
  CollaborationJournal,
  CollaborationRead,
  CollaborationScan,
} from "./journal";
import { collectCollaborationRelationDraft } from "./relations";

interface Options {
  fs: SandboxedFilesystem;
  source: CollaborationScan;
  journal: CollaborationJournal;
  extract(rows: readonly unknown[]): CollaborationRead;
  edges(
    rows: readonly unknown[],
    read: CollaborationRead,
  ): Iterable<CollaborationRelation>;
  /** Same supported archive locator used by ordinary chat-store operations. */
  db_path?: string;
}

/** Archive rows are oldest row_id first; a hydrated head edit is authoritative. */
export function mergeCollaborationRelationHistory(
  head: readonly unknown[],
  archive: readonly unknown[],
): unknown[] {
  const messages = new Map<string, Record<string, any>>();
  const metadata: unknown[] = [];
  const heads = new Set<string>();
  for (const [rows, isHead] of [
    [archive, false],
    [head, true],
  ] as const) {
    for (const value of rows) {
      if (!value || typeof value !== "object")
        throw Error("invalid collaboration history row");
      const row = value as Record<string, any>;
      if (row.event !== "chat") {
        metadata.push(row);
        continue;
      }
      const key =
        typeof row.message_id === "string" && row.message_id.trim()
          ? `native:${row.message_id}`
          : `legacy:${chatIdentityKey(chatIdentityStorageKey(row))}`;
      const previous = messages.get(key);
      if (
        previous &&
        (previous.thread_id !== row.thread_id ||
          previous.sender_id !== row.sender_id)
      )
        throw Error("conflicting archived collaboration message identity");
      if (isHead && heads.has(key))
        throw Error("duplicate collaboration head message identity");
      if (isHead) heads.add(key);
      messages.set(key, row);
    }
  }
  return [...metadata, ...messages.values()];
}

/** One known source, never a directory scan, live SyncDB open, or compute start. */
export async function readCollaborationRelationSource(
  options: Options,
): Promise<CollaborationRead> {
  const { fs, source, journal } = options;
  return withCollaborationCopyLock([source], async () => {
    if (!(await journal.isEnabled()))
      throw Error("collaboration source reader is disabled");
    journal.assertSourceReady(source);
    if (journal.currentScan(source)?.generation !== source.generation)
      throw Error(
        "collaboration source generation changed before relation extraction",
      );
    const exists = async () => {
      try {
        if (!(await fs.lstat(source.chat_path)).isFile())
          throw Error("relation source is not a regular file");
        return true;
      } catch (error) {
        if (
          ["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          return false;
        throw error;
      }
    };
    const present = await exists();
    const head = present
      ? await readCollaborationSource(fs, source.chat_path)
      : [];
    const archivePath = present
      ? await fs.safeAbsPath(source.chat_path)
      : undefined;
    const archive = () =>
      archivePath
        ? readChatRelationArchive({
            chat_path: archivePath,
            db_path: options.db_path,
          })
        : { registered: false, rows: [] };
    const history = archive();
    if (
      !history.registered &&
      head.some(
        (row: any) =>
          row?.event === "chat-thread-config" &&
          Number(row.archived_chat_rows) > 0,
      )
    )
      throw Error(
        "relation archive is unavailable; complete source indexing deferred",
      );
    if (head.length + history.rows.length > 100_000)
      throw Error("complete collaboration source exceeds row capacity");
    const rows = mergeCollaborationRelationHistory(head, history.rows);
    const headHash = collaborationCopySourceFingerprint(head);
    const hashArchive = (rows: unknown[]) =>
      createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    const archiveHash = hashArchive(history.rows);
    const read = options.extract(rows);
    const assertStable = async () => {
      if (!(await journal.isEnabled()))
        throw Error("collaboration source reader is disabled");
      journal.assertSourceReady(source);
      if (
        (await exists()) !== present ||
        collaborationCopySourceFingerprint(
          present ? await readCollaborationSource(fs, source.chat_path) : [],
        ) !== headHash
      )
        throw Error("collaboration head changed during relation extraction");
      const current = archive();
      if (
        current.registered !== history.registered ||
        hashArchive(current.rows) !== archiveHash
      )
        throw Error("collaboration archive changed during relation extraction");
      const scan = journal.currentScan(source);
      if (!scan || scan.generation !== source.generation)
        throw Error(
          "collaboration source generation changed during relation extraction",
        );
    };
    try {
      const relation_draft = await collectCollaborationRelationDraft(
        journal.relations,
        source,
        options.edges(projectChatIdentityRows(rows), read),
        async () => {
          await assertStable();
          return true;
        },
      );
      return { ...read, relation_draft };
    } catch (error) {
      // Incomplete relation facts never replace the last complete set. Metadata
      // may still advance only after the entire resource source proves stable.
      await assertStable();
      return {
        ...read,
        coverage: "partial",
        coverage_message:
          `Complete participant/reference indexing deferred: ${String(error)}`.slice(
            0,
            512,
          ),
      };
    }
  });
}
