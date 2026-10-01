import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import {
  COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS,
  validateCollaborationRoomReplacementRequest,
} from "@cocalc/util/collaboration-room-replacement";
import { submitRoomReplacement } from "../../core/project-chat-room";
import type { ProjectCommandDeps } from "../project";

export function registerChatRoomCommands(
  chat: Command,
  deps: ProjectCommandDeps,
) {
  const room = chat
    .command("room")
    .description("canonical human conversation room lifecycle");
  room
    .command("status")
    .description(
      "read the registered room identity without creating it or starting compute",
    )
    .option("-w, --project <project>", "project id or name")
    .action(async (opts, command: Command) => {
      await deps.withContext(
        command,
        "project chat room status",
        async (ctx) => {
          const project = await deps.resolveProjectFromArgOrContext(
            ctx,
            opts.project,
          );
          return await ctx.hub.collaborators.getRoom({
            project_id: project.project_id,
            account_id: ctx.accountId,
          });
        },
      );
    });
  room
    .command("replace")
    .description(
      `owner-only replacement of a deleted room with a new identity; maximum ${COLLABORATION_ROOM_REPLACEMENT_MAX_OPERATIONS} retained operations per project`,
    )
    .option("-w, --project <project>", "project id or name")
    .requiredOption(
      "--expected-room-id <id>",
      "deleted room identity from room status",
    )
    .requiredOption(
      "--expected-path <path>",
      "exact deleted room path from room status",
    )
    .option("--request-id <id>", "stable idempotency key; reuse on retry")
    .option(
      "--confirm",
      "confirm new identity; old links remain unavailable, not restored",
    )
    .action(async (opts, command: Command) => {
      if (!opts.confirm)
        throw Error(
          "--confirm is required; restore the original file instead to preserve its identity",
        );
      if (process.env.COCALC_AGENT_IDENTITY_FILE)
        throw Error("room replacement requires human account authentication");
      const requestId = opts.requestId ?? randomUUID();
      await deps.withContext(
        command,
        "project chat room replace",
        async (ctx) => {
          const project = await deps.resolveProjectFromArgOrContext(
            ctx,
            opts.project,
          );
          const request = validateCollaborationRoomReplacementRequest({
            version: 1,
            project_id: project.project_id,
            request_id: requestId,
            expected_room_id: opts.expectedRoomId,
            expected_chat_path: opts.expectedPath,
          });
          process.stderr.write(
            `Room replacement request ${requestId}; retry the same expected room/path and --request-id if unconfirmed\n`,
          );
          const routed = await deps.resolveProjectConatClient(
            ctx,
            project.project_id,
          );
          if (routed.project.project_id !== request.project_id)
            throw Error("replacement project route mismatch");
          return await submitRoomReplacement({
            accountId: ctx.accountId,
            request,
            client: routed.client,
            timeoutMs: ctx.timeoutMs,
          });
        },
      );
    });
}
