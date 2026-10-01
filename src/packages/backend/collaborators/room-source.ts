/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import { readCollaborationSource } from "@cocalc/backend/collaborators/filesystem";

/** Check disk before SyncDB's tolerant loader can discard corrupt/restored rows. */
export async function assertPendingRoomSource(
  fs: SandboxedFilesystem,
  room: CollaborationRoom,
): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(room.chat_path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile()) throw Error("pending human room must be a regular file");
  // A lost disk/owner ACK may leave the exact room already persisted. Existing
  // empty, unmarked, copied or malformed files are not initialization permission.
  const rows = await readCollaborationSource(fs, room.chat_path);
  let markers = 0;
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("invalid pending human room row");
    const row = value as Record<string, unknown>;
    if (row.event === "collaborators-identity")
      throw Error("copied chat is not the pending human room");
    if (row.event !== "collaborators-room") continue;
    markers++;
    if (
      row.room_id !== room.room_id ||
      row.project_id !== room.project_id ||
      row.thread_id !== room.room_id ||
      row.schema_version !== 1 ||
      row.mode !== "human"
    )
      throw Error("pending human room identity conflict");
  }
  if (markers !== 1)
    throw Error("pending human room requires exactly one current room marker");
}
