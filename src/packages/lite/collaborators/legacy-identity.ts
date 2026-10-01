/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Client } from "@cocalc/conat/core/client";
import { createChatSyncDB } from "@cocalc/chat/server";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type {
  CollaborationJournal,
  CollaborationScan,
} from "@cocalc/backend/collaborators/journal";
import { withCollaborationCopyLock } from "@cocalc/backend/collaborators/copy-locks";
import { migrateLegacyChatSource } from "@cocalc/backend/collaborators/legacy-identity-source";
import type { LiteCollaborators } from "./index";

export async function migrateLiteChatIdentity(
  source: CollaborationScan,
  options: {
    project_id: string;
    client: Client;
    journal: CollaborationJournal;
    store: Pick<LiteCollaborators, "writerState">;
    createFilesystem(): SandboxedFilesystem;
  },
): Promise<void> {
  if (!(await options.journal.isEnabled())) return;
  await withCollaborationCopyLock([source], async () => {
    const assertCurrent = async () => {
      if (
        !(await options.journal.isEnabled()) ||
        source.project_id !== options.project_id
      )
        throw Error("legacy Lite chat migration is unavailable");
      options.journal.assertSourceReady(source);
      const writer = await options.store.writerState(source);
      if (writer?.epoch !== source.epoch || writer.writer_host_id !== null)
        throw Error("legacy Lite chat writer authority changed");
      options.journal.assertSourceReady(source);
    };
    await assertCurrent();
    const fs = options.createFilesystem();
    try {
      await migrateLegacyChatSource({
        source,
        fs,
        client: options.client,
        createSyncDB: createChatSyncDB,
        assertCurrent,
      });
    } finally {
      fs.close();
    }
  });
}
