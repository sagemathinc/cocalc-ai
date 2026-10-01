/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import type { PoolClient } from "@cocalc/database/pool";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isValidUUID } from "@cocalc/util/misc";
import { PEOPLE_INVITATION_LIMITS } from "@cocalc/util/people-invitations";

export interface ContentInvitationNotificationInput {
  db: PoolClient;
  operation_id: string;
  invitation_id: string;
  sender_account_id: string;
  recipient_account_id: string;
  recipient_home_bay_id: string;
  project_id?: string;
  authored_label?: string;
  message?: string;
  access_invite_ids?: string[];
  channels: { notification: boolean; email: boolean };
}

export type ContentInvitationNotificationResult =
  | { status: "suppressed" }
  | {
      status: "queued" | "duplicate";
      event_id: string;
      notification_id: string;
    };

function uuid(value: string, field: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw Error(`invalid content invitation ${field}`);
  }
  return value.toLowerCase();
}

function authoredText(value: string | undefined, limit: number): string {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > limit ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  ) {
    throw Error("invalid content invitation authored text");
  }
  return value.replace(/\r\n?/g, "\n").trim();
}

/** Internal delivery boundary, NOT an account-callable notification API.
 * The service must authorize the immutable reviewed send at the project owner,
 * check blocks/rate limits, and resolve the recipient's current home first.
 * Call inside the sender-home rehome-fenced operation transaction and persist
 * this receipt with the collaboration invitation. No RPC is performed here.
 * Access offers, if any, must suppress their separate notice for this send.
 * Retain operation/event identities for the full retry horizon, including rehome.
 */
export async function queueContentInvitationNotification(
  input: ContentInvitationNotificationInput,
): Promise<ContentInvitationNotificationResult> {
  const operation_id = uuid(input.operation_id, "operation id");
  const invitation_id = uuid(input.invitation_id, "invitation id");
  const sender_account_id = uuid(input.sender_account_id, "sender id");
  const recipient_account_id = uuid(input.recipient_account_id, "recipient id");
  const project_id =
    input.project_id === undefined
      ? null
      : uuid(input.project_id, "project id");
  if (
    typeof input.recipient_home_bay_id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,200}$/.test(input.recipient_home_bay_id)
  ) {
    throw Error("invalid content invitation recipient home");
  }
  if (
    typeof input.channels?.notification !== "boolean" ||
    typeof input.channels?.email !== "boolean"
  ) {
    throw Error("invalid content invitation channels");
  }
  const channels = {
    notification: input.channels.notification,
    email: input.channels.email,
  };
  const label = authoredText(
    input.authored_label,
    PEOPLE_INVITATION_LIMITS.label,
  );
  const message = authoredText(input.message, PEOPLE_INVITATION_LIMITS.message);
  const accessIds = input.access_invite_ids ?? [];
  if (
    !Array.isArray(accessIds) ||
    accessIds.length > PEOPLE_INVITATION_LIMITS.projects
  ) {
    throw Error("invalid content invitation access offers");
  }
  const access_invite_ids = Array.from(
    new Set(accessIds.map((id) => uuid(id, "access invite id"))),
  ).sort();
  if (
    sender_account_id === recipient_account_id ||
    (!channels.notification && !channels.email)
  ) {
    return { status: "suppressed" };
  }

  const key = [
    "content-invitation:v1",
    sender_account_id,
    operation_id,
    invitation_id,
    recipient_account_id,
  ].join(":");
  const event_id = uuidv5(key, uuidv5.URL);
  const notification_id = uuidv5("notification", event_id);
  const summary = {
    notice_type: "collaboration_invitation",
    title: "Invitation to collaborate",
    severity: "info",
    origin_label: "People",
    actor_account_id: sender_account_id,
    stable_source_id: invitation_id,
    invitation_id,
    operation_id,
    access_invite_ids,
    invitation_channels: channels,
    // Authored text is deliberately NOT Markdown, HTML, a URL, or runtime input.
    body_text: [
      label
        ? `You were invited to work on "${label}".`
        : "You were invited to collaborate.",
      message,
      access_invite_ids.length
        ? "Project access offers are included. Review and accept them separately if needed."
        : "This invitation does not change your project access.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    action_label: "View invitation",
    action_link: `/people/invites/?invitation_id=${invitation_id}`,
  };
  // Routing can change on retry; authored intent and identities cannot.
  const intent_hash = createHash("sha256")
    .update(JSON.stringify({ project_id, summary }))
    .digest("hex");
  await input.db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  const { rows } = await input.db.query(
    `SELECT e.payload_json, t.notification_id, t.target_account_id
     FROM notification_events e LEFT JOIN notification_targets t USING(event_id)
     WHERE e.event_id=$1`,
    [event_id],
  );
  if (rows.length) {
    if (
      rows.length !== 1 ||
      rows[0].notification_id !== notification_id ||
      rows[0].target_account_id !== recipient_account_id ||
      rows[0].payload_json?.intent_hash !== intent_hash
    ) {
      throw Error("conflicting content invitation notification intent");
    }
    return { status: "duplicate", event_id, notification_id };
  }
  await createNotificationEventGraphInTransaction({
    db: input.db,
    input: {
      event_id,
      kind: "account_notice",
      source_bay_id: getConfiguredBayId(),
      source_project_id: project_id,
      actor_account_id: sender_account_id,
      origin_kind: "account",
      payload_json: { ...summary, intent_hash },
      targets: [
        {
          target_account_id: recipient_account_id,
          target_home_bay_id: input.recipient_home_bay_id,
          notification_id,
          dedupe_key: key,
          summary_json: summary,
        },
      ],
    },
  });
  return { status: "queued", event_id, notification_id };
}
