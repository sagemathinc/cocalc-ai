/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { conat } from "@cocalc/conat/client";
import { createChatSyncDB } from "@cocalc/chat/server";
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type {
  CollaborationJournal,
  CollaborationScan,
} from "@cocalc/backend/collaborators/journal";
import { withCollaborationCopyLock } from "@cocalc/backend/collaborators/copy-locks";
import { journalCollaborationFilesystem } from "@cocalc/backend/collaborators/filesystem";
import { migrateLegacyChatSource } from "@cocalc/backend/collaborators/legacy-identity-source";
import { getProject } from "./sqlite/projects";
import { getLocalHostId } from "./sqlite/hosts";
import { withArtifactCatalog } from "./artifact-catalog";
import {
  assertProjectVolumeLifecycleGeneration,
  currentProjectVolumeLifecycleGeneration,
  withProjectVolumeLifecycleLock,
} from "./project-volume-lifecycle";

export async function migrateHostedChatIdentity(
  source: CollaborationScan,
  options: {
    journal: CollaborationJournal;
    getFilesystem(project_id: string): Promise<SandboxedFilesystem>;
    writerState(source: {
      project_id: string;
      chat_path: string;
    }): ReturnType<CollaboratorsApi["writerState"]>;
  },
): Promise<void> {
  if (!(await options.journal.isEnabled())) return;
  await withCollaborationCopyLock([source], () =>
    withProjectVolumeLifecycleLock(source.project_id, async () => {
      const generation = currentProjectVolumeLifecycleGeneration(
        source.project_id,
      );
      const assertCurrent = async () => {
        if (!(await options.journal.isEnabled()))
          throw Error("legacy chat migration disabled");
        const project = getProject(source.project_id);
        if (!project || project.local_only)
          throw Error("legacy chat project is unavailable locally");
        options.journal.assertSourceReady(source);
        assertProjectVolumeLifecycleGeneration(source.project_id, generation);
        const writer = await options.writerState(source);
        if (
          writer?.epoch !== source.epoch ||
          writer.writer_host_id !== getLocalHostId()
        )
          throw Error("legacy chat writer authority changed");
        options.journal.assertSourceReady(source);
        assertProjectVolumeLifecycleGeneration(source.project_id, generation);
      };
      await assertCurrent();
      const fs = journalCollaborationFilesystem(
        withArtifactCatalog(
          await options.getFilesystem(source.project_id),
          source.project_id,
        ),
        source.project_id,
        options.journal,
      );
      try {
        await migrateLegacyChatSource({
          source,
          fs,
          client: conat(),
          createSyncDB: createChatSyncDB,
          assertCurrent,
        });
      } finally {
        fs.close();
      }
    }),
  );
}
