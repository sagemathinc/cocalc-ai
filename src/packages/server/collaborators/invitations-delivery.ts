/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createInterBayCollaboratorsClient } from "@cocalc/conat/inter-bay/collaborators";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { readContentInvitationDeliveryOnHomeBay } from "@cocalc/server/notifications/content-invitation-delivery";
import type { ContentInvitationDeliveryRequest } from "@cocalc/server/notifications/content-invitation-delivery";
import type {
  PeopleInvitationOperation,
  PeopleInvitationDeliveryReceipt,
} from "@cocalc/util/people-invitations";

/** Caller must first authorize the operation/history owner. Not a public RPC. */
export async function readPeopleInvitationDelivery(
  input: ContentInvitationDeliveryRequest,
) {
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id: input.recipient_account_id,
  });
  if (!home_bay_id) throw Error("invitation recipient home unavailable");
  return home_bay_id === getConfiguredBayId()
    ? readContentInvitationDeliveryOnHomeBay(input)
    : createInterBayCollaboratorsClient({
        client: getInterBayFabricClient(),
        bay_id: home_bay_id,
      }).readInvitationDelivery({ ...input, route: { bay_id: home_bay_id } });
}

/** Delivery-only read overlay: no receipt lookup can grant access or resend. */
export async function refreshPeopleInvitationDelivery(
  operation: PeopleInvitationOperation,
): Promise<void> {
  if (operation.payload.recipient.kind !== "account") return;
  const notification_ids = [
    ...new Set(
      operation.outcomes.flatMap((r) =>
        r.delivery.flatMap((d) => (d.receipt_id ? [d.receipt_id] : [])),
      ),
    ),
  ];
  if (!notification_ids.length) return;
  const receipts = new Map<string, PeopleInvitationDeliveryReceipt[]>();
  try {
    const result = await readPeopleInvitationDelivery({
      recipient_account_id: operation.payload.recipient.account_id,
      sender_account_id: operation.account_id,
      notification_ids,
    });
    for (const r of result) receipts.set(r.notification_id, r.delivery);
  } catch {
    /* Missing delivery evidence is unknown, never false success. */
  }
  for (const outcome of operation.outcomes) {
    outcome.delivery = outcome.delivery.map((prior) => {
      if (!operation.payload.channels[prior.channel])
        return {
          channel: prior.channel,
          status: "suppressed",
          reason: "not_requested",
        };
      if (!prior.receipt_id) return prior;
      const current = receipts
        .get(prior.receipt_id)
        ?.find((r) => r.channel === prior.channel);
      return (
        current ??
        (prior.status === "sent" ||
        prior.status === "failed" ||
        prior.status === "suppressed"
          ? prior
          : {
              ...prior,
              status: "unknown",
              reason: "delivery_status_unavailable",
            })
      );
    });
  }
}
