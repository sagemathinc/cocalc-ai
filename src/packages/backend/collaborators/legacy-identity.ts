/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  CHAT_IDENTITY_EVENT,
  planChatIdentityMigration,
  resolveChatIdentityRows,
} from "@cocalc/util/collaboration-chat-identity";
import type { ChatIdentityMarker } from "@cocalc/util/collaboration-chat-identity-markers";

export interface LegacyIdentitySyncDB {
  get(): readonly Record<string, any>[];
  set(row: ChatIdentityMarker): unknown;
  commit(): unknown;
  save(): Promise<unknown>;
  save_to_disk(): Promise<unknown>;
}

/**
 * Project-data-plane adapter only. Caller holds source/copy/volume fences and
 * supplies an operation ID persisted before this call. Archive enumeration must
 * be complete and fenced against rotation/deletion; a head-only scan is not proof
 * of complete history. No catalog publication is permitted until this succeeds.
 */
export async function migrateLegacyChatIdentities({
  db,
  migration_id,
  archived_rows,
  history_complete,
  assertCurrent,
  projectArchive,
}: {
  db: LegacyIdentitySyncDB;
  migration_id: string;
  archived_rows: readonly Record<string, any>[];
  history_complete: boolean;
  assertCurrent(): Promise<void>;
  /** Derived SQLite identity columns only, never archived message JSON. */
  projectArchive(markers: readonly ChatIdentityMarker[]): Promise<void>;
}): Promise<{ changed: boolean; markers: readonly ChatIdentityMarker[] }> {
  await assertCurrent();
  const markers = planChatIdentityMigration([...db.get(), ...archived_rows], {
    migration_id,
    history_complete,
  });
  const allMarkers = [
    ...db
      .get()
      .filter(
        (row) =>
          row.event === CHAT_IDENTITY_EVENT &&
          row.migration_id !== migration_id,
      ),
    ...markers,
  ] as ChatIdentityMarker[];
  // A completed retry still repairs the derived archive projection after a crash.
  const effectiveMarkers = markers.length
    ? allMarkers
    : (db
        .get()
        .filter(
          (row) => row.event === CHAT_IDENTITY_EVENT,
        ) as ChatIdentityMarker[]);
  if (markers.length) {
    for (const marker of markers) {
      if (marker.record_type === "chunk") db.set(marker);
    }
    db.commit();
    await db.save();
    await assertCurrent();
    await db.save_to_disk();
    await assertCurrent();
  }
  await projectArchive(effectiveMarkers);
  await assertCurrent();
  if (markers.length) {
    // Replan against the live rows before making the new generation readable.
    const current = planChatIdentityMigration([...db.get(), ...archived_rows], {
      migration_id,
      history_complete,
    });
    if (JSON.stringify(current) !== JSON.stringify(markers))
      throw Error("chat identity source changed during migration");
    for (const marker of markers) {
      if (marker.record_type === "manifest") db.set(marker);
    }
    db.commit();
    await db.save();
    await assertCurrent();
    await db.save_to_disk();
    await assertCurrent();
  } else if (effectiveMarkers.length) {
    // A previous successful in-memory commit may have lost its disk-save ACK.
    await db.save();
    await assertCurrent();
    await db.save_to_disk();
    await assertCurrent();
  }
  resolveChatIdentityRows([...db.get(), ...archived_rows]);
  return { changed: markers.length > 0, markers: effectiveMarkers };
}
