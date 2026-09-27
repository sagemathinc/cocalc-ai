/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { once } from "node:events";
import type { Client } from "@cocalc/conat/core/client";
import type { ImmerDB } from "@cocalc/conat/sync-doc/immer-db";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import {
  withChatIdentityArchive,
  readChatRelationArchive,
} from "@cocalc/backend/chat-store/sqlite-offload";
import { assertCanonicalRoomHistoryBound } from "./flush-history";
import { boundNetworkSave, ROOM_SAVE_TIMEOUT_MS } from "./flush";
import {
  collaborationCopySourceFingerprint,
  readCollaborationSource,
} from "./filesystem";
import { migrateLegacyChatIdentities } from "./legacy-identity";
import {
  CHAT_IDENTITY_EVENT,
  planChatIdentityMigration,
} from "@cocalc/util/collaboration-chat-identity";

/** Caller owns source/copy/volume locks; no project startup or raw file writes. */
export async function migrateLegacyChatSource({
  source,
  fs,
  client,
  createSyncDB,
  assertCurrent,
}: {
  source: { project_id: string; chat_path: string };
  fs: SandboxedFilesystem;
  client: Client;
  createSyncDB(options: {
    client: Client;
    project_id: string;
    path: string;
    fs: SandboxedFilesystem;
    noBackendFsWatch: boolean;
  }): ImmerDB;
  assertCurrent(): Promise<void>;
}): Promise<void> {
  await assertCurrent();
  try {
    if (!(await fs.lstat(source.chat_path)).isFile())
      throw Error("legacy chat source is not a regular file");
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return;
    throw error;
  }
  const head = await readCollaborationSource(fs, source.chat_path);
  const chat_path = await fs.safeAbsPath(source.chat_path);
  const native = (row: any) =>
    row?.event !== "chat" ||
    (row.schema_version >= 2 &&
      typeof row.message_id === "string" &&
      !!row.message_id.trim() &&
      typeof row.thread_id === "string" &&
      !!row.thread_id.trim());
  // Native-v2 history needs no marker/parent migration. In particular, do not
  // reject normal archive deletions or hydrated edits using stale row counters.
  if (
    !head.some((row: any) => row?.event === CHAT_IDENTITY_EVENT) &&
    head.every(native)
  ) {
    const archive = readChatRelationArchive({ chat_path });
    if (
      archive.rows.every(native) &&
      (archive.registered ||
        !head.some(
          (row: any) =>
            row?.event === "chat-thread-config" &&
            Number(row.archived_chat_rows) > 0,
        ))
    ) {
      await assertCurrent();
      return;
    }
  }
  await withChatIdentityArchive({ chat_path }, async (archive) => {
    const declared = head.reduce<number>(
      (sum, row: any) =>
        sum +
        (row.event === "chat-thread-config"
          ? Math.max(0, Number(row.archived_chat_rows) || 0)
          : 0),
      0,
    );
    if (declared > archive.rows.length)
      throw Error("legacy chat archive evidence is incomplete");
    const planned = planChatIdentityMigration([...head, ...archive.rows], {
      migration_id: archive.migration_id,
      history_complete: true,
    });
    const savedHead = [
      ...head.filter(
        (row: any) =>
          row.event !== CHAT_IDENTITY_EVENT ||
          row.migration_id !== archive.migration_id,
      ),
      ...planned,
    ];
    if (
      planned.length &&
      (savedHead.length > 100_000 ||
        Buffer.byteLength(
          savedHead.map((row) => JSON.stringify(row)).join("\n"),
        ) >
          16 * 1024 * 1024)
    )
      throw Error("legacy identity markers exceed source capacity");
    if (!planned.length) {
      await archive.project(
        head.filter((row: any) => row.event === CHAT_IDENTITY_EVENT) as any,
      );
      await assertCurrent();
      return;
    }
    const path = await fs.canonicalSyncIdentityPath(source.chat_path);
    const history = { client, project_id: source.project_id, path };
    await assertCanonicalRoomHistoryBound(history);
    await assertCurrent();
    const db = createSyncDB({
      client,
      project_id: source.project_id,
      path: source.chat_path,
      fs,
      noBackendFsWatch: true,
    });
    try {
      boundNetworkSave(db, ROOM_SAVE_TIMEOUT_MS);
      if (!db.isReady())
        await once(db, "ready", { signal: AbortSignal.timeout(30_000) });
      await assertCanonicalRoomHistoryBound(history);
      const messagesOnly = (rows: readonly any[]) =>
        rows.filter((row) => row.event !== CHAT_IDENTITY_EVENT);
      if (
        collaborationCopySourceFingerprint(messagesOnly(db.get())) !==
        collaborationCopySourceFingerprint(messagesOnly(head))
      )
        throw Error(
          "legacy chat live state changed; normal save required before migration",
        );
      await migrateLegacyChatIdentities({
        db,
        migration_id: archive.migration_id,
        archived_rows: archive.rows,
        history_complete: true,
        assertCurrent: async () => {
          await assertCurrent();
          if (!(await fs.lstat(source.chat_path)).isFile())
            throw Error("legacy chat source was removed");
        },
        projectArchive: archive.project,
      });
    } finally {
      await db.close();
    }
  });
}
