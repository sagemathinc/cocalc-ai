import type { DB } from "@cocalc/conat/hub/api/db";
import type { CollaboratorsApi } from "@cocalc/conat/hub/api/collaborators";
import type { Client } from "@cocalc/conat/core/client";
import type { CollaborationRoom } from "@cocalc/util/collaborators";
import { isValidUUID } from "@cocalc/util/misc";

export { prepareChatSend, submitChatSend } from "@cocalc/chat/send";

export interface HumanChatContext {
  accountId: string;
  timeoutMs?: number;
  hub: { collaborators: Pick<CollaboratorsApi, "ensureRoom"> };
}

/** Human writes use the registered room service, never local JSON or ACP. */
export async function submitHumanChatOperation({
  ctx,
  projectId,
  client,
  requestId,
  operation,
}: {
  ctx: HumanChatContext;
  projectId: string;
  client: Pick<Client, "request">;
  requestId: string;
  operation:
    | { action: "createThread"; title?: string }
    | { action: "send"; threadId: string; text: string };
}) {
  if (![ctx.accountId, projectId, requestId].every(isValidUUID))
    throw Error("valid account, project and request identities are required");
  if (operation.action === "send") {
    if (!isValidUUID(operation.threadId))
      throw Error("valid thread_id required");
    if (!operation.text.trim() || operation.text.length > 32_768)
      throw Error("human message must contain 1 to 32768 characters");
  } else if (operation.title != null && operation.title.length > 512) {
    throw Error("human thread title must not exceed 512 characters");
  }
  const room = await ctx.hub.collaborators.ensureRoom({
    account_id: ctx.accountId,
    project_id: projectId,
    request_id: requestId,
  });
  if (room.project_id !== projectId || !isValidUUID(room.room_id))
    throw Error("invalid canonical human room registration");
  try {
    const response = await client.request(
      `services.account-${ctx.accountId}._.${projectId}._.collaborators`,
      [
        operation.action,
        [
          operation.action === "send"
            ? {
                request_id: requestId,
                expected_room_id: room.room_id,
                thread_id: operation.threadId,
                text: operation.text,
              }
            : {
                request_id: requestId,
                expected_room_id: room.room_id,
                title: operation.title,
              },
        ],
      ],
      { timeout: ctx.timeoutMs ?? 60_000, waitForInterest: true },
    );
    const result = response.data as CollaborationRoom & {
      thread_id: string;
      message_id?: string;
    };
    if (
      result?.project_id !== projectId ||
      result.room_id !== room.room_id ||
      !isValidUUID(result.thread_id) ||
      (operation.action === "send" &&
        (result.thread_id !== operation.threadId ||
          !isValidUUID(result.message_id)))
    )
      throw Error("human room service returned an invalid acknowledgement");
    return {
      ...result,
      path: result.chat_path,
      request_id: requestId,
      human: true,
      state: "accepted",
    };
  } catch (error) {
    // An acknowledgement can be lost after persistence. Never invent a new ID.
    throw Error(
      `Human chat operation not confirmed. Retry the same parameters with --request-id ${requestId}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export async function readChatSendAccountSettings(
  db: Pick<DB, "userQuery">,
  accountId: string,
) {
  const result = await db.userQuery({
    query: { accounts: [{ account_id: accountId, other_settings: null }] },
  });
  const account = result?.accounts?.find((row) => row.account_id === accountId);
  if (!account)
    throw new Error("could not read the sending account's preferences");
  return account.other_settings ?? {};
}
