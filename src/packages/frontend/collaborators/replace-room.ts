/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  collaborationRoomReplacementOperationId,
  validateCollaborationRoomReplacementRequest,
} from "@cocalc/util/collaboration-room-replacement";
import type {
  CollaborationRoomReplacementRequest,
  CollaborationRoomReplacementResult,
} from "@cocalc/util/collaboration-room-replacement";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export async function replaceConversationRoom({
  accountId,
  request,
  signal,
}: {
  accountId: string;
  request: CollaborationRoomReplacementRequest;
  signal: AbortSignal;
}): Promise<CollaborationRoomReplacementResult> {
  const intent = validateCollaborationRoomReplacementRequest(request);
  const client = webapp_client.conat_client;
  const check = () => {
    if (
      signal.aborted ||
      client !== webapp_client.conat_client ||
      redux.getStore("account")?.get("account_id") !== accountId
    )
      throw Error("Room replacement cancelled or session changed.");
  };
  check();
  const operation_id = collaborationRoomReplacementOperationId(
    intent.project_id,
    accountId,
    intent.request_id,
  );
  const host = await client.projectConat({
    project_id: intent.project_id,
    caller: "collaborators.replaceRoom",
    requireRouting: true,
  });
  check();
  const response = await host.request(
    `services.account-${accountId}._.${intent.project_id}._.collaborators`,
    ["replaceRoom", [intent]],
    { timeout: 60_000, waitForInterest: true },
  );
  check();
  const result = response.data as CollaborationRoomReplacementResult;
  if (
    result?.operation_id !== operation_id ||
    !["pending", "ready", "superseded"].includes(result.outcome)
  )
    throw Error(
      "The room replacement was not confirmed. Retry this same operation.",
    );
  if (
    result.outcome !== "superseded" &&
    (result.room?.project_id !== intent.project_id ||
      result.room.room_id === intent.expected_room_id)
  )
    throw Error("The service returned a different replacement identity.");
  return result;
}
