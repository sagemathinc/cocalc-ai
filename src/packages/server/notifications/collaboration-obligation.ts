/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  prepareCollaborationNotificationAuthorization,
  lockEventCollaborationNotificationAttention,
} from "@cocalc/database/postgres/collaborators/collaborators-notifications";
import type {
  CollaborationNotificationObligation,
  CollaborationNotificationEntry,
} from "@cocalc/util/collaboration-attention";
import { receiveCollaborationMessageNotification } from "./collaboration";
import type { CollaborationNotificationResult } from "./collaboration";

/** Internal home-routed receiver. No source payload is trusted from the sender:
 * resolve the exact retained obligation at the current owner after fencing.
 * A returned result means the graph transaction committed or policy suppressed
 * delivery. Throws (including unknown commit outcomes) must retain owner work.
 */
export async function receiveCollaborationNotificationObligation(
  input: CollaborationNotificationObligation,
  read: (
    input: CollaborationNotificationObligation,
  ) => Promise<CollaborationNotificationEntry | null>,
): Promise<CollaborationNotificationResult> {
  const authorization = await prepareCollaborationNotificationAuthorization(
    input.account_id,
    input.project_id,
  );
  const entry = await read(input);
  if (!entry) return { status: "revoked" };
  if (
    entry.event.project_id !== input.project_id ||
    entry.attention?.generation !== input.membership_epoch
  )
    throw Error("notification obligation authority mismatch");
  return receiveCollaborationMessageNotification(
    {
      event: entry.event,
      account_id: input.account_id,
      obligation_id: input.id,
      access_generation: entry.authority.access_generation,
      grant_request_id: authorization.request_id,
      attention: entry.attention,
    },
    {
      authorize: async () => entry.authority,
      lockAttention: ({ db, delivery }) =>
        lockEventCollaborationNotificationAttention({
          db,
          delivery,
          authorization,
        }),
    },
  );
}
