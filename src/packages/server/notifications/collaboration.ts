/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { admitCollaborationAlert } from "./collaboration-summary";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { v5 as uuidv5 } from "uuid";
import type { PoolClient } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  COLLABORATION_NOTIFICATION_BATCH_LIMIT,
  collaborationAccountId,
  collaborationNotificationKey,
  collaborationNotificationReason,
  validateCollaborationMessageEvent,
  validateCollaborationNotificationAttention,
} from "@cocalc/util/collaboration-attention";
import type {
  CollaborationAttentionState,
  CollaborationNotificationAuthority,
  CollaborationNotificationDelivery,
} from "@cocalc/util/collaboration-attention";
export type {
  CollaborationNotificationAuthority,
  CollaborationNotificationDelivery,
} from "@cocalc/util/collaboration-attention";

export interface CollaborationNotificationHooks {
  /** Route to the current project owner, verify the authenticated writer's accepted
   * immutable event and canonical HUMAN room, and recheck actor/recipient membership.
   * Return null only for definitive revocation/deletion; throw on unknown/unavailable.
   * This RPC runs before acquiring the account transaction/fence.
   */
  authorize(
    input: CollaborationNotificationDelivery,
  ): Promise<CollaborationNotificationAuthority | null>;
  /** Runs on the recipient home bay, under its rehome fence, in the notification
   * transaction. Lock access + attention rows, compare generation with the owner
   * result, and reconcile/persist legacy state and the membership starting boundary.
   * Read/follow/mute writes and membership invalidation must use the same row lock.
   * Owner-supplied attention can replace the resource projection, but never the
   * access fence. Return null only for definitive revocation; throw if required
   * authorization state (or a legacy owner's projection) is not ready.
   * No RPC inside this callback. Do not mark activity read merely by delivering it.
   */
  lockAttention(input: {
    db: PoolClient;
    delivery: CollaborationNotificationDelivery;
    authority: CollaborationNotificationAuthority;
  }): Promise<{
    access_generation: string;
    state: CollaborationAttentionState;
  } | null>;
}

export type CollaborationNotificationResult =
  | { status: "suppressed" | "revoked" }
  | { status: "created" | "duplicate"; notification_id: string };

function member(role: string): boolean {
  return role === "owner" || role === "collaborator";
}

function generation(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw Error("invalid collaboration access generation");
  }
  return value;
}

function validateAuthority(
  input: CollaborationNotificationDelivery,
  authority: CollaborationNotificationAuthority,
): void {
  if (
    authority.project_id !== input.event.project_id ||
    authority.room_id !== input.event.room_id ||
    authority.thread_id !== input.event.thread_id ||
    typeof authority.owning_bay_id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,200}$/.test(authority.owning_bay_id) ||
    typeof authority.chat_path !== "string" ||
    authority.chat_path.length > 2048 ||
    !authority.chat_path.startsWith("/home/user/") ||
    !authority.chat_path.endsWith(".chat") ||
    /[\x00-\x1f\x7f]/.test(authority.chat_path) ||
    posix.normalize(authority.chat_path) !== authority.chat_path
  )
    throw Error("invalid collaboration notification authority");
  generation(authority.access_generation);
}

/** SERVICE INTERNAL ONLY: never register as an account/host-callable createMention
 * API, and never impersonate the author via createMention({account_id: author}).
 *
 * Integration contract:
 * - The existing source journal/owner outbox retains immutable event intent until
 *   all recipient pages are acknowledged. Batches contain at most 25 recipients;
 *   mention-all uses durable, bounded membership pagination, not an in-memory list.
 * - Only post-cutover live messages emit events. Disable legacy browser mention
 *   AND follower emission for these rooms before enabling this consumer.
 * - Retry thrown errors with the same event/recipient/generation, including an
 *   unknown commit outcome. Burst overflow retains exact receipts and one durable summary.
 * - A first observation/rejoin persists the owner-issued notify_after cutover;
 *   it is NOT advanced per delivery, so out-of-order live events remain deliverable.
 * - Notification events/targets and their existing outbox are the only delivery
 *   source. Retain their dedup rows for the source replay horizon. Account rehome
 *   must preserve these event identities or replay floors before resuming delivery.
 * - Revocation is checked at the owner then under the home access-generation lock.
 *   Invalidation between these checks is rejected. Already committed notifications
 *   are not erased here; the surrounding projection invalidation owns that window.
 */
export async function receiveCollaborationMessageNotification(
  input: CollaborationNotificationDelivery,
  hooks: CollaborationNotificationHooks,
): Promise<CollaborationNotificationResult> {
  const delivery: CollaborationNotificationDelivery = {
    event: validateCollaborationMessageEvent(input.event),
    obligation_id: input.obligation_id,
    account_id: collaborationAccountId(input.account_id),
    access_generation: generation(input.access_generation),
    ...(input.attention === undefined
      ? {}
      : {
          attention: validateCollaborationNotificationAttention(
            input.attention,
          ),
        }),
    ...(input.grant_request_id === undefined
      ? {}
      : {
          grant_request_id:
            input.grant_request_id === null
              ? null
              : collaborationAccountId(input.grant_request_id),
        }),
  };
  const { event, account_id } = delivery;
  if (event.mode !== "live" || event.actor_account_id === account_id)
    return { status: "suppressed" };
  const authority = await hooks.authorize(delivery);
  if (!authority) return { status: "revoked" };
  validateAuthority(delivery, authority);
  if (
    !member(authority.actor_role) ||
    !member(authority.recipient_role) ||
    authority.access_generation !== delivery.access_generation
  )
    return { status: "revoked" };

  return await withAccountRehomeWriteFence({
    account_id,
    action: "record collaboration notification",
    fn: async (db): Promise<CollaborationNotificationResult> => {
      const attention = await hooks.lockAttention({ db, delivery, authority });
      if (
        !attention ||
        attention.access_generation !== delivery.access_generation
      )
        return { status: "revoked" };
      const reason = collaborationNotificationReason({
        event,
        account_id,
        state: attention.state,
      });
      if (!reason) return { status: "suppressed" };
      const key = collaborationNotificationKey(event, account_id, reason);
      const event_id = uuidv5(key, uuidv5.URL);
      const notification_id = uuidv5("notification", event_id);
      const event_hash = createHash("sha256")
        .update(JSON.stringify(event))
        .digest("hex");
      // Account rehome fence serializes simultaneous retries; the graph insert
      // and durable outbox commit in this SAME transaction as the dedup check.
      const existing = await db.query(
        `SELECT t.target_account_id, t.notification_id, e.payload_json
         FROM notification_events e JOIN notification_targets t USING(event_id)
         WHERE e.event_id=$1`,
        [event_id],
      );
      if (existing.rows.length) {
        const row = existing.rows[0];
        if (
          existing.rows.length !== 1 ||
          row.target_account_id !== account_id ||
          row.notification_id !== notification_id ||
          row.payload_json?.event_hash !== event_hash
        ) {
          throw Error("conflicting collaboration notification identity");
        }
        return { status: "duplicate", notification_id };
      }
      const grouped = await admitCollaborationAlert({
        db,
        account_id,
        actor_account_id: event.actor_account_id,
        event_id,
        event_hash,
        project_id: event.project_id,
        obligation_id: delivery.obligation_id,
      });
      if (grouped) return grouped;
      const description =
        reason === "mention"
          ? "You were mentioned in a project conversation."
          : "New reply in a project conversation you follow.";
      const summary = {
        description,
        priority: "normal",
        notification_reason: reason,
        stable_source_id: event.message_id,
        room_id: event.room_id,
        thread_id: event.thread_id,
        message_id: event.message_id,
        activity: event.activity,
        actor_account_id: event.actor_account_id,
        path: authority.chat_path,
        display_path: authority.chat_path.slice("/home/user/".length),
      };
      await createNotificationEventGraphInTransaction({
        db,
        input: {
          event_id,
          kind: "mention",
          source_bay_id: getConfiguredBayId(),
          source_project_id: event.project_id,
          source_path: authority.chat_path,
          actor_account_id: event.actor_account_id,
          origin_kind: "project",
          payload_json: { ...summary, event_hash },
          targets: [
            {
              target_account_id: account_id,
              target_home_bay_id: getConfiguredBayId(),
              notification_id,
              dedupe_key: key,
              summary_json: summary,
            },
          ],
        },
      });
      return { status: "created", notification_id };
    },
  });
}

/** All-or-retry page acknowledgment: earlier commits are safe to replay after a
 * later recipient fails. No fire-and-forget promises or success on partial failure.
 */
export async function receiveCollaborationNotificationBatch(
  deliveries: CollaborationNotificationDelivery[],
  hooks: CollaborationNotificationHooks,
): Promise<CollaborationNotificationResult[]> {
  if (
    !Array.isArray(deliveries) ||
    deliveries.length > COLLABORATION_NOTIFICATION_BATCH_LIMIT
  ) {
    throw Error("collaboration notification batch exceeds capacity");
  }
  const results: CollaborationNotificationResult[] = [];
  for (const delivery of deliveries) {
    results.push(
      await receiveCollaborationMessageNotification(delivery, hooks),
    );
  }
  return results;
}
