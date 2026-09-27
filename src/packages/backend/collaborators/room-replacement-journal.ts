/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import type { CollaborationSource } from "./journal";
import type { CollaborationRoomServiceState } from "@cocalc/util/collaboration-room-replacement";

/** Local exclusion and permanent retirement, never the owner CAS authority. */
export class RoomReplacementJournal {
  private active = new Set<string>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly retireRelations: (source: CollaborationSource) => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS retired_rooms (
      project_id TEXT NOT NULL, room_id TEXT NOT NULL, chat_path TEXT NOT NULL,
      PRIMARY KEY(project_id,room_id), UNIQUE(project_id,chat_path));`);
  }
  private key(source: CollaborationSource) {
    return JSON.stringify([source.project_id, source.chat_path]);
  }
  isRetired(source: CollaborationSource): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM retired_rooms WHERE project_id=? AND chat_path=?")
      .get(source.project_id, source.chat_path);
  }
  assertWritable(source: CollaborationSource) {
    if (this.active.has(this.key(source)) || this.isRetired(source))
      throw Error("canonical room source is replacing or permanently retired");
  }
  assertRoom(project_id: string, room_id: string) {
    if (
      this.db
        .prepare("SELECT 1 FROM retired_rooms WHERE project_id=? AND room_id=?")
        .get(project_id, room_id)
    )
      throw Error("canonical room identity is permanently retired");
  }
  async lock<T>(
    source: CollaborationSource,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = this.key(source);
    if (
      this.active.has(key) ||
      this.db
        .prepare(
          "SELECT 1 FROM writes WHERE project_id=? AND chat_path=? LIMIT 1",
        )
        .get(source.project_id, source.chat_path)
    )
      throw Error("canonical room has pending writes; retry replacement");
    // Receipt replay must be possible even after this old source was retired.
    this.active.add(key);
    try {
      return await run();
    } finally {
      this.active.delete(key);
    }
  }
  /** Call inside the journal transaction only after authoritative confirmation. */
  retire(source: CollaborationSource, room_id: string) {
    this.retireRelations(source);
    this.db
      .prepare(
        "INSERT INTO retired_rooms VALUES(?,?,?) ON CONFLICT(project_id,room_id) DO NOTHING",
      )
      .run(source.project_id, room_id, source.chat_path);
    // Existing scan/registration/relocation selectors already exclude redirects.
    // A self-redirect is terminal, not a new locator to follow.
    this.db
      .prepare(
        "INSERT INTO source_redirects VALUES(?,?,?) ON CONFLICT(project_id,chat_path) DO UPDATE SET to_path=excluded.to_path",
      )
      .run(source.project_id, source.chat_path, source.chat_path);
    for (const table of [
      "deliveries",
      "notification_events",
      "notification_baselines",
    ])
      this.db
        .prepare(`DELETE FROM ${table} WHERE project_id=? AND chat_path=?`)
        .run(source.project_id, source.chat_path);
    this.db
      .prepare(
        "DELETE FROM room_initializations WHERE project_id=? AND room_id=?",
      )
      .run(source.project_id, room_id);
  }
  replace(previous: CollaborationRoom, next: CollaborationRoom) {
    if (
      previous.project_id !== next.project_id ||
      previous.room_id === next.room_id ||
      previous.chat_path === next.chat_path
    )
      throw Error("invalid canonical room replacement transition");
    this.assertRoom(next.project_id, next.room_id);
    const current = this.db
      .prepare("SELECT room_id FROM rooms WHERE project_id=?")
      .get(previous.project_id);
    if (
      current &&
      current.room_id !== previous.room_id &&
      current.room_id !== next.room_id
    )
      throw Error("local canonical room replacement was superseded");
    this.retire(previous, previous.room_id);
    this.db
      .prepare(
        `INSERT INTO rooms(project_id,room_id,initialized) VALUES(?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET room_id=excluded.room_id,
      initialized=CASE WHEN rooms.room_id=excluded.room_id THEN MAX(rooms.initialized,excluded.initialized) ELSE excluded.initialized END`,
      )
      .run(next.project_id, next.room_id, next.initialized === true ? 1 : 0);
  }

  /** Reconcile only from an authenticated current-owner lookup, never a file marker. */
  reconcile(room: CollaborationRoomServiceState) {
    for (const retired of room.retired_rooms ?? []) {
      if (
        retired.room_id === room.room_id ||
        retired.chat_path === room.chat_path
      )
        throw Error("current canonical room cannot be retired");
      this.retire(
        { project_id: room.project_id, chat_path: retired.chat_path },
        retired.room_id,
      );
    }
    this.assertRoom(room.project_id, room.room_id);
    const current = this.db
      .prepare("SELECT room_id FROM rooms WHERE project_id=?")
      .get(room.project_id);
    if (current && current.room_id !== room.room_id) {
      const previous = this.db
        .prepare(
          "SELECT chat_path FROM retired_rooms WHERE project_id=? AND room_id=?",
        )
        .get(room.project_id, current.room_id);
      if (!previous)
        throw Error("local canonical room transition is not owner-confirmed");
      this.replace(
        {
          project_id: room.project_id,
          room_id: String(current.room_id),
          chat_path: String(previous.chat_path),
        },
        room,
      );
    }
  }
}
