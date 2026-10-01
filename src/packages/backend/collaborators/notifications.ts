/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";
import {
  validateCollaborationMessageEvent,
  type CollaborationMessageEvent,
} from "@cocalc/util/collaboration-attention";
import { COLLABORATION_MAX_SOURCE_BYTES } from "@cocalc/util/collaborators";
import type { CollaborationSourceSnapshot } from "@cocalc/util/collaborators";
import type { CollaborationRead, CollaborationSource } from "./journal";

export type CollaborationDelivery = CollaborationSourceSnapshot & {
  notification_events?: CollaborationMessageEvent[];
};
export const SOURCE_EVENT_BATCH_LIMIT = 100;

/** All mutations run inside the source journal transaction, never independently. */
export class SourceNotifications {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_baselines (
        project_id TEXT NOT NULL, chat_path TEXT NOT NULL, room_id TEXT NOT NULL,
        lifecycle_generation INTEGER NOT NULL, PRIMARY KEY(project_id,chat_path));
      CREATE TABLE IF NOT EXISTS notification_events (
        project_id TEXT NOT NULL, chat_path TEXT NOT NULL, room_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(project_id,room_id,thread_id,message_id));
      CREATE INDEX IF NOT EXISTS notification_source ON notification_events(project_id,chat_path);
    `);
  }
  /** Only call for a newly created empty live room, never when adopting history. */
  arm(source: CollaborationSource, room_id: string, generation = 0) {
    if (
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(room_id) ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    )
      throw Error("invalid human room notification baseline");
    this.db
      .prepare(
        "INSERT INTO notification_baselines VALUES(?,?,?,?) ON CONFLICT(project_id,chat_path) DO UPDATE SET room_id=excluded.room_id,lifecycle_generation=excluded.lifecycle_generation",
      )
      .run(source.project_id, source.chat_path, room_id, generation);
  }
  prepare(
    source: CollaborationSource,
    read: CollaborationRead,
    positions: Map<string, number>,
  ) {
    if (!read.notification_room_id) {
      // Missing/replaced source must go through a new backfill cutover.
      this.db
        .prepare(
          "DELETE FROM notification_baselines WHERE project_id=? AND chat_path=?",
        )
        .run(source.project_id, source.chat_path);
      return;
    }
    const generation = read.lifecycle_generation ?? 0;
    const baseline = this.db
      .prepare(
        "SELECT * FROM notification_baselines WHERE project_id=? AND chat_path=?",
      )
      .get(source.project_id, source.chat_path);
    const live =
      baseline?.room_id === read.notification_room_id &&
      baseline?.lifecycle_generation === generation;
    this.arm(source, read.notification_room_id, generation);
    if (!live) return;
    if ((read.notification_messages?.length ?? 0) > 100_000)
      throw Error("notification source capacity exceeded");
    const identities = new Set<string>();
    for (const fact of read.notification_messages ?? []) {
      const key = JSON.stringify([fact.thread_id, fact.message_id]);
      if (identities.has(key))
        throw Error("duplicate notification source identity");
      identities.add(key);
      const activity = positions.get(key);
      if (activity === undefined) continue;
      const event = validateCollaborationMessageEvent({
        ...fact,
        activity,
        mode: "live",
      });
      if (
        event.project_id !== source.project_id ||
        event.room_id !== read.notification_room_id
      )
        throw Error("notification source identity mismatch");
      this.db
        .prepare("INSERT INTO notification_events VALUES(?,?,?,?,?,?)")
        .run(
          source.project_id,
          source.chat_path,
          event.room_id,
          event.thread_id,
          event.message_id,
          JSON.stringify(event),
        );
    }
    if (
      Number(
        this.db.prepare("SELECT count(*) AS n FROM notification_events").get()!
          .n,
      ) > 100_000
    )
      throw Error("notification journal event capacity exceeded");
  }
  batch(
    snapshot: CollaborationSourceSnapshot,
    reservedBytes = 0,
  ): CollaborationDelivery {
    const rows = this.db
      .prepare(
        "SELECT payload FROM notification_events WHERE project_id=? AND chat_path=? ORDER BY rowid LIMIT ?",
      )
      .all(snapshot.project_id, snapshot.chat_path, SOURCE_EVENT_BATCH_LIMIT);
    const { notification_events: _previous, ...base } =
      snapshot as CollaborationDelivery;
    const result: CollaborationDelivery = { ...base };
    const events: CollaborationMessageEvent[] = [];
    for (const row of rows) {
      const event: CollaborationMessageEvent = JSON.parse(String(row.payload));
      const resource = snapshot.resources.find(
        (r) => r.kind === "conversation" && r.thread_id === event.thread_id,
      );
      if (!resource || resource.activity < event.activity)
        throw Error("notification event lacks complete source resource");
      if (
        Buffer.byteLength(
          JSON.stringify({ ...base, notification_events: [...events, event] }),
        ) +
          reservedBytes >
        COLLABORATION_MAX_SOURCE_BYTES
      ) {
        if (!events.length)
          throw Error("notification snapshot byte capacity exceeded");
        break;
      }
      events.push(event);
    }
    if (events.length) result.notification_events = events;
    return result;
  }
  /** Validate even later batches now so acknowledgement can always make progress. */
  assertFits(snapshot: CollaborationSourceSnapshot, reservedBytes = 0) {
    const max = Number(
      this.db
        .prepare(
          "SELECT COALESCE(MAX(length(CAST(payload AS BLOB))),0) AS n FROM notification_events WHERE project_id=? AND chat_path=?",
        )
        .get(snapshot.project_id, snapshot.chat_path)!.n,
    );
    if (
      max &&
      Buffer.byteLength(JSON.stringify(snapshot)) + max + 32 + reservedBytes >
        COLLABORATION_MAX_SOURCE_BYTES
    )
      throw Error("notification snapshot byte capacity exceeded");
  }
  acknowledge(snapshot: CollaborationDelivery) {
    for (const event of snapshot.notification_events ?? [])
      this.db
        .prepare(
          "DELETE FROM notification_events WHERE project_id=? AND room_id=? AND thread_id=? AND message_id=? AND payload=?",
        )
        .run(
          snapshot.project_id,
          event.room_id,
          event.thread_id,
          event.message_id,
          JSON.stringify(event),
        );
  }
  get bytes(): number {
    return Number(
      this.db
        .prepare(
          "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM notification_events",
        )
        .get()!.n,
    );
  }
  relocate(project_id: string, from_path: string, to_path: string) {
    this.db
      .prepare(
        "DELETE FROM notification_baselines WHERE project_id=? AND chat_path=?",
      )
      .run(project_id, to_path);
    for (const table of ["notification_baselines", "notification_events"])
      this.db
        .prepare(
          `UPDATE ${table} SET chat_path=? WHERE project_id=? AND chat_path=?`,
        )
        .run(to_path, project_id, from_path);
  }
}
