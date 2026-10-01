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
import type { Client } from "@cocalc/conat/core/client";

/** A ready service-side copy intent permits one marker write, not chat rewrites. */
export async function initializeLiteCollaborationCopy(
  copy: CollaborationCopy,
  options: {
    project_id: string;
    client: Client;
    reader: SandboxedFilesystem;
    assertEnabled(): Promise<void>;
  },
): Promise<void> {
  await options.assertEnabled();
  if (copy.project_id !== options.project_id)
    throw Error("foreign Lite collaboration copy");
  if (copy.state !== "ready" || !copy.fingerprint)
    throw Error("copy outcome requires reconciliation");
  const rows = (
    await readCollaborationSource(options.reader, copy.chat_path)
  ).map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw Error("invalid collaboration copy source row");
    return row as Record<string, any>;
  });
  if (
    collaborationIdentityNamespace(rows) !== copy.operation_id &&
    collaborationCopySourceFingerprint(rows) !== copy.fingerprint
  )
    throw Error("copy destination changed; reconciliation required");
  await options.assertEnabled();
  const db = await acquireChatSyncDB({
    client: options.client,
    project_id: copy.project_id,
    path: copy.chat_path,
    readyTimeoutMs: 30_000,
  });
  try {
    await options.assertEnabled();
    await initializeCollaborationCopy(db, {
      operation_id: copy.operation_id,
      fingerprint: collaborationCopyFingerprint(rows),
    });
  } finally {
    await releaseChatSyncDB(copy.project_id, copy.chat_path);
  }
}
