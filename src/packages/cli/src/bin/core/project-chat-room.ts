import type { Client } from "@cocalc/conat/core/client";
import {
  collaborationRoomReplacementOperationId,
  validateCollaborationRoomReplacementRequest,
} from "@cocalc/util/collaboration-room-replacement";
import type {
  CollaborationRoomReplacementRequest,
  CollaborationRoomReplacementResult,
} from "@cocalc/util/collaboration-room-replacement";

export async function submitRoomReplacement({
  accountId,
  request,
  client,
  timeoutMs = 60_000,
}: {
  accountId: string;
  request: CollaborationRoomReplacementRequest;
  client: Pick<Client, "request">;
  timeoutMs?: number;
}) {
  const intent = validateCollaborationRoomReplacementRequest(request);
  const operation_id = collaborationRoomReplacementOperationId(
    intent.project_id,
    accountId,
    intent.request_id,
  );
  try {
    const response = await client.request(
      `services.account-${accountId}._.${intent.project_id}._.collaborators`,
      ["replaceRoom", [intent]],
      { timeout: timeoutMs, waitForInterest: true },
    );
    const result = response.data as CollaborationRoomReplacementResult;
    if (
      result?.operation_id !== operation_id ||
      !["pending", "ready", "superseded"].includes(result.outcome)
    )
      throw Error("invalid replacement acknowledgement");
    if (
      result.outcome !== "superseded" &&
      (result.room?.project_id !== intent.project_id ||
        result.room.room_id === intent.expected_room_id)
    )
      throw Error("invalid replacement room identity");
    return { ...result, request_id: intent.request_id };
  } catch (error) {
    throw Error(
      `Room replacement not confirmed. Retry the same expected room/path and --request-id ${intent.request_id}: ${error instanceof Error ? error.message : error}`,
    );
  }
}
