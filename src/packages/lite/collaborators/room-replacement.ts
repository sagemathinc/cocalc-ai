/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";
import {
  collaborationRoomReplacementOperationId,
  planCollaborationRoomReplacement,
} from "@cocalc/util/collaboration-room-replacement";
import type {
  CollaborationRoomReplacementHostRequest,
  CollaborationRoomReplacementResult,
} from "@cocalc/util/collaboration-room-replacement";

export function initializeLiteRoomReplacementSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS collaboration_room_replacements (
    operation_id TEXT PRIMARY KEY, previous_room_id TEXT NOT NULL UNIQUE,
    previous_chat_path TEXT NOT NULL UNIQUE, retired_epoch TEXT NOT NULL, receipt TEXT NOT NULL);`);
}
export function retiredLiteRoomSource(db: DatabaseSync, path: string) {
  return db
    .prepare(
      "SELECT previous_room_id,retired_epoch FROM collaboration_room_replacements WHERE previous_chat_path=?",
    )
    .get(path);
}

/** The local owner calls this within its transaction after validating the sole human. */
export function replaceLiteRoom(
  db: DatabaseSync,
  opts: CollaborationRoomReplacementHostRequest,
  room_home: string,
  retireRelations: (chat_path: string) => void,
): CollaborationRoomReplacementResult {
  const { request } = opts;
  if (opts.project_id !== request.project_id)
    throw Error("replacement project identity mismatch");
  const operation_id = collaborationRoomReplacementOperationId(
    request.project_id,
    opts.requesting_account_id,
    request.request_id,
  );
  const previous = db
    .prepare(
      "SELECT receipt FROM collaboration_room_replacements WHERE operation_id=?",
    )
    .get(operation_id);
  const room = db
    .prepare(
      "SELECT room_id,chat_path,EXISTS(SELECT 1 FROM collaboration_initialized_rooms i WHERE i.room_id=r.room_id) AS initialized FROM collaboration_room r WHERE singleton=1",
    )
    .get();
  const source = db
    .prepare("SELECT epoch FROM collaboration_sources WHERE chat_path=?")
    .get(request.expected_chat_path);
  const plan = planCollaborationRoomReplacement({
    request,
    authority: {
      project_id: request.project_id,
      requesting_account_id: opts.requesting_account_id,
      requester_role: "owner",
      authenticated_host_id: request.project_id,
      current_host_id: request.project_id,
      room_home,
    },
    current_room: room
      ? {
          project_id: request.project_id,
          room_id: String(room.room_id),
          chat_path: String(room.chat_path),
          initialized: room.initialized === 1,
        }
      : null,
    current_source_epoch: source ? String(source.epoch) : null,
    receipt: previous ? JSON.parse(String(previous.receipt)) : null,
    absence: opts.absence,
    retained_operations: Number(
      db
        .prepare("SELECT count(*) AS n FROM collaboration_room_replacements")
        .get()!.n,
    ),
  });
  if (plan.action === "return") return plan.result;
  retireRelations(request.expected_chat_path);
  db.prepare(
    "INSERT INTO collaboration_room_replacements VALUES(?,?,?,?,?)",
  ).run(
    operation_id,
    request.expected_room_id,
    request.expected_chat_path,
    plan.receipt.retired_source_epoch,
    JSON.stringify(plan.receipt),
  );
  const changed = db
    .prepare(
      "UPDATE collaboration_room SET room_id=?,chat_path=?,request_id=? WHERE singleton=1 AND room_id=? AND chat_path=?",
    )
    .run(
      plan.room.room_id,
      plan.room.chat_path,
      request.request_id,
      request.expected_room_id,
      request.expected_chat_path,
    );
  if (Number(changed.changes) !== 1)
    throw Error("canonical room changed during replacement");
  db.prepare(
    "UPDATE collaboration_sources SET epoch=?,registration_id='',sequence=0,payload_hash=NULL,metadata_hash=NULL WHERE chat_path=?",
  ).run(plan.receipt.retired_source_epoch, request.expected_chat_path);
  db.prepare(
    "DELETE FROM collaboration_requested_sources WHERE chat_path=?",
  ).run(request.expected_chat_path);
  db.prepare(
    "DELETE FROM collaboration_search WHERE rowid IN (SELECT rowid FROM collaboration_resources WHERE chat_path=?)",
  ).run(request.expected_chat_path);
  db.prepare(
    "DELETE FROM collaboration_participants WHERE resource_key IN (SELECT resource_key FROM collaboration_resources WHERE chat_path=?)",
  ).run(request.expected_chat_path);
  db.prepare(
    `UPDATE collaboration_resources SET deleted=1,created_by=NULL,
    metadata=json_object('activity',COALESCE(json_extract(metadata,'$.activity'),0)) WHERE chat_path=?`,
  ).run(request.expected_chat_path);
  db.prepare(
    "UPDATE collaboration_owner SET revision=revision+1 WHERE singleton=1",
  ).run();
  return { outcome: "pending", operation_id, room: plan.room };
}
