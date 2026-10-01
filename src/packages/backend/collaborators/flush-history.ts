/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Client } from "@cocalc/conat/core/client";
import { stream as persistStream } from "@cocalc/conat/persist/client";
import { storagePath } from "@cocalc/conat/sync/core-stream";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";

export const ROOM_HISTORY_MAX_PATCHES = 10_000;
export const ROOM_HISTORY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Metadata-only admission before opening the room's normal SyncDB. Bound the
 * entire stream, since SyncDB can fall back from a stale checkpoint to full
 * history. Inventory bytes are uncompressed, not the SQLite compressed blob.
 * The adapter must supply the same canonical sync identity path used by SyncDB.
 */
export async function assertCanonicalRoomHistoryBound({
  client,
  project_id,
  path,
}: {
  client: Client;
  project_id: string;
  path: string;
}): Promise<void> {
  const stream = persistStream({
    client,
    user: { project_id },
    storage: {
      path: storagePath({ project_id, name: patchesStreamName({ path }) }),
    },
  });
  try {
    // General SQLite RPC is deliberately disabled on the production server.
    // Inventory is the existing authorized, metadata-only persistence API.
    const inventory = await stream.inventory(10_000);
    const count = inventory?.count,
      bytes = inventory?.bytes;
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      count > ROOM_HISTORY_MAX_PATCHES ||
      bytes > ROOM_HISTORY_MAX_BYTES
    )
      throw Error("canonical room history exceeds background flush capacity");
  } finally {
    stream.close();
  }
}
