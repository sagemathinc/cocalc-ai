/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { once } from "node:events";
import { createChatSyncDB } from "@cocalc/chat/server";
import { conat } from "@cocalc/conat/client";
import type { Client } from "@cocalc/conat/core/client";
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import { flushExistingCanonicalRoom } from "@cocalc/backend/collaborators/flush";
import { assertCanonicalRoomHistoryBound } from "@cocalc/backend/collaborators/flush-history";
import type {
  CollaborationJournal,
  CollaborationScan,
} from "@cocalc/backend/collaborators/journal";
import { withCollaborationCopyLock } from "@cocalc/backend/collaborators/copy-locks";
import {
  journalCollaborationFilesystem,
  readCollaborationSource,
} from "@cocalc/backend/collaborators/filesystem";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { withArtifactCatalog } from "./artifact-catalog";
import { getProject } from "./sqlite/projects";
import { getLocalHostId } from "./sqlite/hosts";
import {
  assertProjectVolumeLifecycleGeneration,
  currentProjectVolumeLifecycleGeneration,
  withProjectVolumeLifecycleLock,
} from "./project-volume-lifecycle";

export async function flushHostedCanonicalRoom(
  source: CollaborationScan,
  options: {
    journal: CollaborationJournal;
    getFilesystem(project_id: string): Promise<SandboxedFilesystem>;
    writerState(source: {
      project_id: string;
      chat_path: string;
    }): ReturnType<CollaboratorsApi["writerState"]>;
    client?: () => Client;
  },
): Promise<void> {
  const { journal } = options;
  if (!(await journal.isEnabled())) return;
  const target = { project_id: source.project_id, chat_path: source.chat_path };
  const checkLocal = () => {
    const project = getProject(source.project_id);
    if (!project || project.local_only)
      throw Error("canonical room project is not locally available");
    journal.assertSourceReady(source);
  };
  checkLocal();
  const writer = await options.writerState(target);
  const room = writer?.canonical_room;
  if (!room || room.initialized !== true) return;
  const matches = (
    state: Awaited<ReturnType<CollaboratorsApi["writerState"]>>,
  ) =>
    state?.epoch === source.epoch &&
    state.writer_host_id === getLocalHostId() &&
    state.canonical_room?.initialized === true &&
    state.canonical_room.room_id === room.room_id &&
    state.canonical_room.project_id === source.project_id &&
    state.canonical_room.chat_path === source.chat_path;
  if (!matches(writer)) throw Error("canonical room writer authority changed");
  await withCollaborationCopyLock([source], () =>
    withProjectVolumeLifecycleLock(source.project_id, async () => {
      checkLocal();
      const generation = currentProjectVolumeLifecycleGeneration(
        source.project_id,
      );
      const assertCurrent = async () => {
        if (!(await journal.isEnabled()))
          throw Error("canonical room flush disabled");
        checkLocal();
        assertProjectVolumeLifecycleGeneration(source.project_id, generation);
        if (!matches(await options.writerState(target)))
          throw Error("canonical room writer authority changed");
        checkLocal();
        assertProjectVolumeLifecycleGeneration(source.project_id, generation);
      };
      await assertCurrent();
      // This reader requires an already provisioned volume, even for stopped projects.
      const fs = journalCollaborationFilesystem(
        withArtifactCatalog(
          await options.getFilesystem(source.project_id),
          source.project_id,
        ),
        source.project_id,
        journal,
      );
      let db: ReturnType<typeof createChatSyncDB> | undefined;
      try {
        try {
          await fs.lstat(source.chat_path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Let the ordinary source reader publish deletion tombstones.
          // Never open persisted history to recreate a missing room file.
          if (code === "ENOENT" || code === "ENOTDIR") return;
          throw error;
        }
        await flushExistingCanonicalRoom({
          room,
          assertCurrent,
          read: async () => {
            if (!(await fs.lstat(source.chat_path)).isFile())
              throw Error("canonical room is not an existing regular file");
            return readCollaborationSource(fs, source.chat_path);
          },
          acquire: async () => {
            const client = (options.client ?? conat)();
            const path = await fs.canonicalSyncIdentityPath(source.chat_path);
            await assertCanonicalRoomHistoryBound({
              client,
              project_id: source.project_id,
              path,
            });
            await assertCurrent();
            db = createChatSyncDB({
              client,
              project_id: source.project_id,
              path: source.chat_path,
              fs,
              noBackendFsWatch: true,
            });
            if (!db.isReady())
              await once(db, "ready", { signal: AbortSignal.timeout(30_000) });
            await assertCanonicalRoomHistoryBound({
              client,
              project_id: source.project_id,
              path,
            });
            return db;
          },
          release: async () => {
            await db?.close();
            db = undefined;
          },
        });
      } finally {
        // Acquisition failure must also release the standalone session and reader.
        try {
          await db?.close();
        } finally {
          fs.close();
        }
      }
    }),
  );
}
