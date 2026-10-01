/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  buildChatMessage,
  buildThreadConfigRecord,
  buildThreadRecord,
} from "./core";
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import { collaborationIdentityNamespace } from "./collaborators-copy";

/** Narrow live SyncDB interface; no filesystem writer or agent transport. */
export interface HumanRoomSyncDB {
  get(): readonly Record<string, any>[];
  set(row: any): unknown;
  commit(): unknown;
  save(): Promise<unknown>;
  save_to_disk(): Promise<unknown>;
}

function uuid(id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw Error("valid operation/account identity required");
}

async function persist(db: HumanRoomSyncDB) {
  db.commit();
  await db.save();
  await db.save_to_disk();
}

export function humanRoomMarker(
  db: HumanRoomSyncDB,
  room: CollaborationRoom,
): boolean {
  if (collaborationIdentityNamespace(db.get()))
    throw Error("copied chat is not the registered human room");
  const markers = db.get().filter((row) => row.event === "collaborators-room");
  if (
    markers.length &&
    (markers.length !== 1 ||
      markers[0].room_id !== room.room_id ||
      markers[0].project_id !== room.project_id)
  )
    throw Error("human room identity conflict");
  return markers.length === 1;
}

export async function initializeHumanRoom(
  db: HumanRoomSyncDB,
  room: CollaborationRoom,
) {
  uuid(room.room_id);
  if (!humanRoomMarker(db, room)) {
    if (db.get().length)
      throw Error("existing chat requires explicit human-room adoption");
    db.set({
      event: "collaborators-room",
      sender_id: "__collaborators__",
      date: "1970-01-01T00:00:00.000Z",
      thread_id: room.room_id,
      room_id: room.room_id,
      project_id: room.project_id,
      schema_version: 1,
      mode: "human",
    });
  }
  // Retry persistence too: a previous invocation may have lost its disk ack.
  await persist(db);
  return room;
}

export async function createHumanThread(
  db: HumanRoomSyncDB,
  opts: {
    room: CollaborationRoom;
    thread_id: string;
    account_id: string;
    title?: string;
    now?: number;
  },
) {
  const { room, thread_id, account_id } = opts;
  uuid(thread_id);
  uuid(account_id);
  if (!humanRoomMarker(db, room)) throw Error("human room is not initialized");
  const rows = db.get();
  const existing = rows.find(
    (row) => row.event === "chat-thread" && row.thread_id === thread_id,
  );
  const config = rows.find(
    (row) => row.event === "chat-thread-config" && row.thread_id === thread_id,
  );
  if (existing || config) {
    if (
      !existing ||
      !config ||
      existing.created_by !== account_id ||
      config.agent_kind !== "none" ||
      config.acp_config ||
      config.agent_model
    )
      throw Error("human thread identity conflict");
  } else {
    const date = new Date(opts.now ?? Date.now());
    db.set(
      buildThreadRecord({
        thread_id,
        root_message_id: thread_id,
        created_by: account_id,
        created_at: date,
      }),
    );
    db.set(
      buildThreadConfigRecord({
        thread_id,
        updated_by: account_id,
        updated_at: date,
        name: (opts.title?.trim() || "Untitled conversation").slice(0, 512),
        agent_kind: "none",
      }),
    );
  }
  await persist(db);
  return { ...room, thread_id };
}

/** Mentions are authored text here; this function has no agent invocation path. */
export async function sendHumanMessage(
  db: HumanRoomSyncDB,
  opts: {
    room: CollaborationRoom;
    thread_id: string;
    message_id: string;
    account_id: string;
    text: string;
    now?: number;
  },
) {
  uuid(opts.message_id);
  uuid(opts.account_id);
  if (!humanRoomMarker(db, opts.room))
    throw Error("human room is not initialized");
  if (
    typeof opts.text !== "string" ||
    !opts.text.trim() ||
    opts.text.length > 32_768
  )
    throw Error("human message must contain 1 to 32768 characters");
  const rows = db.get();
  const config = rows.find(
    (row) =>
      row.event === "chat-thread-config" && row.thread_id === opts.thread_id,
  );
  if (
    !config ||
    config.agent_kind !== "none" ||
    config.acp_config ||
    config.agent_model ||
    config.archived
  )
    throw Error("active human-only thread required");
  const existing = rows.find(
    (row) => row.event === "chat" && row.message_id === opts.message_id,
  );
  if (existing) {
    if (
      existing.thread_id !== opts.thread_id ||
      existing.sender_id !== opts.account_id
    )
      throw Error("human message identity conflict");
  } else {
    const messages = rows
      .filter((row) => row.event === "chat" && row.thread_id === opts.thread_id)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const dates = new Set(rows.map((row) => Date.parse(row.date)));
    let date = opts.now ?? Date.now();
    while (dates.has(date)) date++;
    db.set(
      buildChatMessage({
        prevHistory: [],
        generating: false,
        sender_id: opts.account_id,
        content: opts.text,
        date: new Date(date),
        message_id: opts.message_id,
        thread_id: opts.thread_id,
        parent_message_id: messages.at(-1)?.message_id,
        schema_version: 2,
      }),
    );
    if (!messages.length) {
      const thread = rows.find(
        (row) =>
          row.event === "chat-thread" && row.thread_id === opts.thread_id,
      );
      if (thread) db.set({ ...thread, root_message_id: opts.message_id });
    }
  }
  await persist(db);
  return {
    ...opts.room,
    thread_id: opts.thread_id,
    message_id: opts.message_id,
  };
}
