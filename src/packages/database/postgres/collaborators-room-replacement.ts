/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  collaborationRoomReplacementOperationId,
  planCollaborationRoomReplacement,
  validateCollaborationRoomReplacementRequest,
} from "@cocalc/util/collaboration-room-replacement";
import type {
  CollaborationRoomReplacementHostRequest,
  CollaborationRoomReplacementResult,
} from "@cocalc/util/collaboration-room-replacement";
import {
  assertCollaborationWriterAuthority,
  assertCollaborationAccountAuthority,
} from "./collaborators-owner";
import type {
  CollaborationWriterAuthority,
  CollaborationOwnerAuthority,
} from "./collaborators-owner";
import { integer, sourceKey, transaction, uuid } from "./collaborators-common";

export async function getCollaborationRoom(
  project_id: string,
  account_id: string,
  authority: CollaborationOwnerAuthority,
) {
  return transaction(async (db) => {
    await assertCollaborationAccountAuthority(
      db,
      project_id,
      account_id,
      authority,
    );
    return (
      (
        await db.query(
          "SELECT project_id,room_id,chat_path,initialized FROM collaboration_rooms WHERE project_id=$1",
          [project_id],
        )
      ).rows[0] ?? null
    );
  });
}

/** Current-host-only owner RPC. No chat bytes cross the control plane. */
export async function replaceCollaborationRoom(
  opts: CollaborationRoomReplacementHostRequest,
  authority: CollaborationWriterAuthority,
): Promise<CollaborationRoomReplacementResult> {
  const request = validateCollaborationRoomReplacementRequest(opts.request);
  uuid(opts.requesting_account_id, "requesting_account_id");
  if (opts.project_id !== request.project_id)
    throw Error("replacement project identity mismatch");
  const operation_id = collaborationRoomReplacementOperationId(
    request.project_id,
    opts.requesting_account_id,
    request.request_id,
  );
  return transaction(async (db) => {
    // This fences rehome and locks the authoritative project row before any read.
    await assertCollaborationWriterAuthority(db, request.project_id, authority);
    const project = (
      await db.query("SELECT users,host_id FROM projects WHERE project_id=$1", [
        request.project_id,
      ])
    ).rows[0];
    const current_room =
      (
        await db.query(
          "SELECT project_id,room_id,chat_path,initialized FROM collaboration_rooms WHERE project_id=$1",
          [request.project_id],
        )
      ).rows[0] ?? null;
    const previous_source_id = sourceKey({
      project_id: request.project_id,
      chat_path: request.expected_chat_path,
    });
    const source = (
      await db.query(
        "SELECT epoch,retired_room_id FROM collaboration_sources WHERE source_id=$1",
        [previous_source_id],
      )
    ).rows[0];
    const receipt =
      (
        await db.query(
          "SELECT receipt FROM collaboration_room_replacements WHERE operation_id=$1",
          [operation_id],
        )
      ).rows[0]?.receipt ?? null;
    const count = (
      await db.query(
        "SELECT count(*) AS n FROM collaboration_room_replacements WHERE project_id=$1",
        [request.project_id],
      )
    ).rows[0];
    const role = project?.users?.[opts.requesting_account_id]?.group;
    const plan = planCollaborationRoomReplacement({
      request,
      authority: {
        project_id: request.project_id,
        requesting_account_id: opts.requesting_account_id,
        requester_role: role === "owner" ? "owner" : "none",
        authenticated_host_id: authority.host_id,
        current_host_id: project?.host_id ?? null,
      },
      current_room,
      current_source_epoch: source?.epoch ?? null,
      receipt,
      absence: opts.absence,
      retained_operations: Number(count.n),
    });
    if (plan.action === "return") return plan.result;
    if (source?.retired_room_id)
      throw Error("canonical room source is retired");
    const revision = Number(
      (
        await db.query(
          "UPDATE collaboration_projects SET revision=revision+1 WHERE project_id=$1 RETURNING revision",
          [request.project_id],
        )
      ).rows[0]?.revision,
    );
    integer(revision, "replacement catalog revision");
    const updated = await db.query(
      `UPDATE collaboration_rooms SET room_id=$4,chat_path=$5,request_id=$6,initialized=FALSE
       WHERE project_id=$1 AND room_id=$2 AND chat_path=$3 AND initialized=TRUE`,
      [
        request.project_id,
        request.expected_room_id,
        request.expected_chat_path,
        plan.room.room_id,
        plan.room.chat_path,
        request.request_id,
      ],
    );
    if (updated.rowCount !== 1)
      throw Error("canonical room changed during replacement");
    await db.query(
      `INSERT INTO collaboration_room_replacements
       (operation_id,project_id,requesting_account_id,request_id,previous_room_id,previous_source_id,receipt)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        operation_id,
        request.project_id,
        opts.requesting_account_id,
        request.request_id,
        request.expected_room_id,
        previous_source_id,
        JSON.stringify(plan.receipt),
      ],
    );
    // Also fence a room that was initialized but never registered for indexing.
    await db.query(
      `INSERT INTO collaboration_sources
       (source_id,project_id,chat_path,owning_bay_id,writer_host_id,epoch,retired_room_id,revision)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(source_id) DO UPDATE SET epoch=excluded.epoch,
         retired_room_id=excluded.retired_room_id,registration_id=NULL,
         source_sequence=0,payload_hash=NULL,metadata_hash=NULL,relation_set=NULL,revision=excluded.revision`,
      [
        previous_source_id,
        request.project_id,
        request.expected_chat_path,
        authority.owning_bay_id,
        authority.host_id,
        plan.receipt.retired_source_epoch,
        request.expected_room_id,
        revision,
      ],
    );
    // Permanent, content-free identity tombstones prevent copied/restored IDs from
    // rebinding after ordinary catalog compaction. Personal state is not migrated.
    await db.query(
      `UPDATE collaboration_catalog SET
         resource_id=COALESCE(resource_id,metadata->>'resource_id'),
         activity_floor=GREATEST(activity_floor,COALESCE((metadata->>'activity')::bigint,0)),
         metadata=NULL,relation_set=NULL,relation_thread=NULL,relation_count=0,
         deleted_at=COALESCE(deleted_at,now()),revision=$2
       WHERE source_id=$1`,
      [previous_source_id, revision],
    );
    await db.query(
      "DELETE FROM collaboration_source_requests WHERE project_id=$1 AND chat_path=$2",
      [request.project_id, request.expected_chat_path],
    );
    return { outcome: "pending", operation_id, room: plan.room };
  });
}
