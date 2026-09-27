/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { acquireChatSyncDB, releaseChatSyncDB } from "@cocalc/chat/server";
import {
  collaborationCopyFingerprint,
  collaborationIdentityNamespace,
  initializeCollaborationCopy,
} from "@cocalc/chat";
import {
  collaborationCopySourceFingerprint,
  readCollaborationSource,
} from "@cocalc/backend/collaborators/filesystem";
import type { CollaborationCopy } from "@cocalc/backend/collaborators/journal";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { withCollaborationCopyLock } from "@cocalc/backend/collaborators/copy-locks";
import { getMasterConatClient } from "./master-conat-client";
import { getProject } from "./sqlite/projects";
import {
  assertProjectVolumeLifecycleGeneration,
  currentProjectVolumeLifecycleGeneration,
  withProjectVolumeLifecycleLock,
} from "./project-volume-lifecycle";

export async function initializeCopiedCollaboration(
  copy: CollaborationCopy,
  getFilesystem: (project_id: string) => Promise<SandboxedFilesystem>,
): Promise<void> {
  if (copy.state !== "ready" || !copy.fingerprint)
    throw Error("copy outcome requires reconciliation");
  await withCollaborationCopyLock([copy], () =>
    withProjectVolumeLifecycleLock(copy.project_id, async () => {
      const project = getProject(copy.project_id);
      const client = getMasterConatClient();
      if (!project || project.local_only || !client)
        throw Error("copy project is not locally available");
      const generation = currentProjectVolumeLifecycleGeneration(
        copy.project_id,
      );
      const fs = await getFilesystem(copy.project_id);
      try {
        if (!(await fs.lstat(copy.chat_path)).isFile())
          throw Error("copy destination is no longer a regular chat source");
        const rows = await readCollaborationSource(fs, copy.chat_path);
        const namespace = collaborationIdentityNamespace(rows);
        if (
          namespace !== copy.operation_id &&
          collaborationCopySourceFingerprint(rows) !== copy.fingerprint
        )
          throw Error("copy destination changed; reconciliation required");
        if (!(await fs.lstat(copy.chat_path)).isFile())
          throw Error("copy destination was removed during reconciliation");
        const db = await acquireChatSyncDB({
          client,
          project_id: copy.project_id,
          path: copy.chat_path,
          readyTimeoutMs: 30_000,
        });
        try {
          assertProjectVolumeLifecycleGeneration(copy.project_id, generation);
          await initializeCollaborationCopy(db, {
            operation_id: copy.operation_id,
            fingerprint: collaborationCopyFingerprint(rows),
          });
          assertProjectVolumeLifecycleGeneration(copy.project_id, generation);
        } finally {
          await releaseChatSyncDB(copy.project_id, copy.chat_path);
        }
      } finally {
        fs.close();
      }
    }),
  );
}
