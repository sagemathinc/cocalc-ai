/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { once } from "node:events";
import { createChatSyncDB } from "@cocalc/chat/server";
import { flushExistingCanonicalRoom } from "@cocalc/backend/collaborators/flush";
import { assertCanonicalRoomHistoryBound } from "@cocalc/backend/collaborators/flush-history";
import { withCollaborationCopyLock } from "@cocalc/backend/collaborators/copy-locks";
import { readCollaborationSource } from "@cocalc/backend/collaborators/filesystem";
import type {
  CollaborationJournal,
  CollaborationScan,
} from "@cocalc/backend/collaborators/journal";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type { Client } from "@cocalc/conat/core/client";
import type { LiteCollaborators } from "./index";

/** The source inventory schedules this work; no browser or directory scan does. */
export async function flushLiteCanonicalRoom(
  source: CollaborationScan,
  options: {
    project_id: string;
    account_id: string;
    client: Client;
    store: Pick<LiteCollaborators, "registeredRoom" | "writerState">;
    journal: CollaborationJournal;
    createFilesystem(): SandboxedFilesystem;
  },
): Promise<void> {
  const { journal, store } = options;
  if (!(await journal.isEnabled())) return;
  if (source.project_id !== options.project_id)
    throw Error("foreign Lite canonical room source");
  const identity = {
    project_id: options.project_id,
    account_id: options.account_id,
  };
  const room = await store.registeredRoom(identity);
  if (!room?.initialized || room.chat_path !== source.chat_path) return;
  await withCollaborationCopyLock([source], async () => {
    const assertCurrent = async () => {
      if (!(await journal.isEnabled()))
        throw Error("Lite canonical room flush disabled");
      journal.assertSourceReady(source);
      const current = await store.registeredRoom(identity);
      const writer = await store.writerState(source);
      if (
        current?.initialized !== true ||
        current.room_id !== room.room_id ||
        current.project_id !== source.project_id ||
        current.chat_path !== source.chat_path ||
        writer?.epoch !== source.epoch ||
        writer.writer_host_id !== null
      )
        throw Error("Lite canonical room writer authority changed");
      if (!(await journal.isEnabled()))
        throw Error("Lite canonical room flush disabled");
      journal.assertSourceReady(source);
    };
    await assertCurrent();
    const fs = options.createFilesystem();
    let db: ReturnType<typeof createChatSyncDB> | undefined;
    try {
      try {
        await fs.lstat(source.chat_path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Preserve normal deletion extraction, never open history to recreate it.
        if (code === "ENOENT" || code === "ENOTDIR") return;
        throw error;
      }
      await flushExistingCanonicalRoom({
        room,
        assertCurrent,
        read: async () => {
          if (!(await fs.lstat(source.chat_path)).isFile())
            throw Error("Lite canonical room is not an existing regular file");
          return readCollaborationSource(fs, source.chat_path);
        },
        acquire: async () => {
          const path = await fs.canonicalSyncIdentityPath(source.chat_path);
          const history = {
            client: options.client,
            project_id: source.project_id,
            path,
          };
          await assertCanonicalRoomHistoryBound(history);
          await assertCurrent();
          db = createChatSyncDB({
            client: options.client,
            project_id: source.project_id,
            path: source.chat_path,
            fs,
            noBackendFsWatch: true,
          });
          if (!db.isReady())
            await once(db, "ready", { signal: AbortSignal.timeout(30_000) });
          await assertCanonicalRoomHistoryBound(history);
          return db;
        },
        release: async () => {
          await db?.close();
          db = undefined;
        },
      });
    } finally {
      // Also close a session that failed or timed out during acquisition.
      try {
        await db?.close();
      } finally {
        fs.close();
      }
    }
  });
}
