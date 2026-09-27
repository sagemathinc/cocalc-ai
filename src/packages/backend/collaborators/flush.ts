/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import { collaborationCopySourceFingerprint } from "./filesystem";

export interface CanonicalRoomSyncDB {
  get(): readonly unknown[];
  save(): Promise<unknown>;
  save_to_disk(): Promise<unknown>;
}
const MAX_ROWS = 100_000;
const MAX_BYTES = 16 * 1024 * 1024;
export const ROOM_SAVE_TIMEOUT_MS = 30_000;

/**
 * Only install on a standalone session. SyncDoc.save_to_disk calls this same
 * public save method before writeFileDelta. Timing out that network-only stage
 * therefore rejects its continuation BEFORE a filesystem write can start; we
 * never race the disk save itself against a timer or unlock an in-flight write.
 */
function boundNetworkSave(db: CanonicalRoomSyncDB, timeoutMs: number): void {
  const save = db.save.bind(db);
  const deadline = Date.now() + timeoutMs;
  let expired = false;
  db.save = async () => {
    const remaining = deadline - Date.now();
    if (expired || remaining <= 0)
      throw Error("canonical room history save timed out; retry required");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        save(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(
              Error("canonical room history save timed out; retry required"),
            );
          }, remaining);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

function roomFingerprint(
  rows: readonly unknown[],
  room: CollaborationRoom,
): string {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS)
    throw Error("canonical room exceeds row capacity");
  let bytes = 0;
  let markers = 0;
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("invalid canonical room row");
    const row = value as Record<string, unknown>;
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > MAX_BYTES) throw Error("canonical room exceeds byte capacity");
    if (row.event === "collaborators-identity")
      throw Error("copied chat cannot be flushed as the canonical room");
    if (row.event === "collaborators-room") {
      markers++;
      if (
        row.room_id !== room.room_id ||
        row.project_id !== room.project_id ||
        row.mode !== "human" ||
        row.schema_version !== 1
      )
        throw Error("canonical room marker changed");
    }
  }
  if (markers !== 1)
    throw Error(
      "canonical room was deleted or replaced; explicit restore required",
    );
  return collaborationCopySourceFingerprint([...rows]);
}

/**
 * Adapters hold deletion/relocation/lifecycle fences throughout, authorize the
 * existing owner pointer, and read only an existing regular file. Never creates
 * a room or arms notification history; only normal live SyncDB saves write data.
 * Acquire must create a standalone session, never a shared pooled document.
 * Release closes that session (native Conat table close does not await saves).
 */
export async function flushExistingCanonicalRoom({
  room,
  assertCurrent,
  read,
  acquire,
  release,
  saveTimeoutMs = ROOM_SAVE_TIMEOUT_MS,
}: {
  room: CollaborationRoom;
  assertCurrent(): Promise<void>;
  read(): Promise<readonly unknown[]>;
  acquire(): Promise<CanonicalRoomSyncDB>;
  release(): Promise<void>;
  saveTimeoutMs?: number;
}): Promise<boolean> {
  if (!Number.isFinite(saveTimeoutMs) || saveTimeoutMs <= 0)
    throw Error("invalid canonical room save timeout");
  if (room.initialized !== true)
    throw Error("canonical room is not initialized");
  await assertCurrent();
  roomFingerprint(await read(), room);
  const db = await acquire();
  try {
    boundNetworkSave(db, saveTimeoutMs);
    roomFingerprint(db.get(), room);
    await assertCurrent();
    await db.save();
    const disk = roomFingerprint(await read(), room);
    if (disk === roomFingerprint(db.get(), room)) return false;
    await assertCurrent();
    // Detect deletion/replacement during authority lookup as well as acquisition.
    roomFingerprint(await read(), room);
    const expected = roomFingerprint(db.get(), room);
    await db.save_to_disk();
    await assertCurrent();
    if (roomFingerprint(await read(), room) !== expected)
      throw Error("canonical room flush was not persisted; retry required");
    return true;
  } finally {
    await release();
  }
}
