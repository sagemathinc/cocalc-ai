/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  claimCollaborationNotificationRecipients,
  settleCollaborationNotificationRecipient,
} from "@cocalc/database/postgres/collaborators/collaborators-notification-fanout";
import type { CollaborationNotificationObligation } from "@cocalc/util/collaboration-attention";

/** One bounded project pass. The scheduler supplies the authenticated home route.
 * Unknown outcomes are retried with the same stable obligation; a home graph
 * commit followed by a lost response must never become a second notification.
 */
export async function deliverCollaborationNotificationFanout({
  project_id,
  bay_id,
  deliver,
}: {
  project_id: string;
  bay_id: string;
  deliver: (
    input: CollaborationNotificationObligation,
  ) => Promise<{ status: string }>;
}) {
  const claims = await claimCollaborationNotificationRecipients({
    project_id,
    bay_id,
  });
  let acknowledged = 0;
  let deferred = 0;
  for (const claim of claims) {
    let outcome: "acknowledge" | "retry" = "retry";
    try {
      const result = await deliver({
        project_id,
        id: claim.id,
        account_id: claim.account_id,
        membership_epoch: claim.membership_epoch,
      });
      if (
        !["created", "duplicate", "suppressed", "revoked"].includes(
          result.status,
        )
      )
        throw Error("invalid notification delivery receipt");
      outcome = "acknowledge";
    } catch {
      // No local decision can distinguish a lost reply from an uncommitted call.
      // The durable graph's stable identity resolves that ambiguity on retry.
    }
    const settled = await settleCollaborationNotificationRecipient({
      project_id,
      bay_id,
      id: claim.id,
      claim_id: claim.claim_id,
      outcome,
    });
    if (settled && outcome === "acknowledge") acknowledged++;
    else deferred++;
  }
  return { attempted: claims.length, acknowledged, deferred };
}
