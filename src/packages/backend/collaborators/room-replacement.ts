/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  collaborationRoomReplacementOperationId,
  validateCollaborationRoomReplacementRequest,
} from "@cocalc/util/collaboration-room-replacement";
import type {
  CollaborationRoomReplacementAbsence,
  CollaborationRoomReplacementRequest,
  CollaborationRoomReplacementResult,
} from "@cocalc/util/collaboration-room-replacement";
import type { CollaborationRoom } from "@cocalc/util/collaborators";

/** Host/Lite orchestration. The caller reserves its room-service admission first. */
export async function replaceCanonicalRoom(options: {
  request: CollaborationRoomReplacementRequest;
  identity: { project_id: string; account_id: string };
  host_id: string;
  /** Recheck current local placement, lifecycle and owner membership after awaits. */
  assertCurrent(): void;
  withSourceLock<T>(run: () => Promise<T>): Promise<T>;
  currentRoom(): Promise<CollaborationRoom>;
  sourceEpoch(): Promise<string | null>;
  /** lstat the old locator: only ENOENT qualifies, never a read/parse failure. */
  lstat(): Promise<unknown>;
  commit(
    absence?: CollaborationRoomReplacementAbsence,
  ): Promise<CollaborationRoomReplacementResult>;
  transition(previous: CollaborationRoom, next: CollaborationRoom): void;
}): Promise<CollaborationRoomReplacementResult> {
  const request = validateCollaborationRoomReplacementRequest(options.request);
  if (request.project_id !== options.identity.project_id)
    throw Error("replacement project identity mismatch");
  options.assertCurrent();
  return options.withSourceLock(async () => {
    options.assertCurrent();
    const room = await options.currentRoom();
    options.assertCurrent();
    if (room.project_id !== request.project_id)
      throw Error("replacement room project mismatch");
    let absence: CollaborationRoomReplacementAbsence | undefined;
    if (
      room.room_id === request.expected_room_id &&
      room.chat_path === request.expected_chat_path
    ) {
      if (room.initialized !== true)
        throw Error("only an initialized, deleted room may be replaced");
      let missing = false;
      try {
        await options.lstat();
      } catch (error) {
        if ((error as { code?: string })?.code !== "ENOENT") throw error;
        missing = true;
      }
      options.assertCurrent();
      if (!missing)
        throw Error(
          "canonical room still exists; restore or repair it instead of replacing it",
        );
      const source_epoch = await options.sourceEpoch();
      options.assertCurrent();
      absence = {
        status: "missing",
        project_id: request.project_id,
        requesting_account_id: options.identity.account_id,
        host_id: options.host_id,
        request_id: request.request_id,
        room_id: request.expected_room_id,
        chat_path: request.expected_chat_path,
        source_epoch,
      };
    }
    // A retry after owner commit must not re-observe the retired file. It may
    // already be restored, and the authoritative receipt decides supersession.
    const result = await options.commit(absence);
    options.assertCurrent();
    if (
      result.operation_id !==
      collaborationRoomReplacementOperationId(
        request.project_id,
        options.identity.account_id,
        request.request_id,
      )
    )
      throw Error("replacement operation acknowledgement mismatch");
    if (result.outcome !== "superseded") {
      if (
        result.room.project_id !== request.project_id ||
        result.room.room_id === request.expected_room_id
      )
        throw Error("replacement room acknowledgement mismatch");
      options.transition(
        {
          project_id: request.project_id,
          room_id: request.expected_room_id,
          chat_path: request.expected_chat_path,
          initialized: true,
        },
        result.room,
      );
    }
    return result;
  });
}
