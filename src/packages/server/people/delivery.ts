/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  PeopleInvitationHistoryRow,
  PeopleCollaborationInvitationHistoryRow,
} from "@cocalc/util/people-invitation-history";
import type { PeopleInvitationDeliveryReceipt } from "@cocalc/util/people-invitations";
import { readPeopleInvitationDelivery } from "@cocalc/server/collaborators/invitations-delivery";

/** Input is a bounded, already authorized account-home page. Not a public RPC.
 * At most four recipient lookups in flight; one lookup per sender/recipient pair.
 */
export async function refreshPeopleHistoryDelivery(
  items: PeopleInvitationHistoryRow[],
) {
  if (items.length > 100) throw Error("delivery page too large");
  const groups = new Map<string, PeopleCollaborationInvitationHistoryRow[]>();
  for (const row of items) {
    if (
      row.kind !== "collaboration" ||
      !row.recipient_account_id ||
      !row.delivery.some((r) => r.receipt_id && r.status !== "suppressed")
    )
      continue;
    const key = `${row.sender_account_id}:${row.recipient_account_id}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const jobs = [...groups.values()];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (next < jobs.length) {
        const rows = jobs[next++];
        const notification_ids = [
          ...new Set(
            rows.flatMap((row) =>
              row.delivery
                .filter((r) => r.status !== "suppressed" && r.receipt_id)
                .map((r) => r.receipt_id!),
            ),
          ),
        ];
        let evidence = new Map<string, PeopleInvitationDeliveryReceipt[]>();
        try {
          evidence = new Map(
            (
              await readPeopleInvitationDelivery({
                recipient_account_id: rows[0].recipient_account_id!,
                sender_account_id: rows[0].sender_account_id,
                notification_ids,
              })
            ).map((r) => [r.notification_id, r.delivery]),
          );
        } catch {
          // A transport failure is not a delivery failure and never triggers send.
        }
        for (const row of rows)
          row.delivery = row.delivery.map((receipt) => {
            if (!receipt.receipt_id || receipt.status === "suppressed")
              return receipt;
            return (
              evidence
                .get(receipt.receipt_id)
                ?.find((r) => r.channel === receipt.channel) ?? {
                channel: receipt.channel,
                receipt_id: receipt.receipt_id,
                status: "unknown",
                reason: "delivery_not_observed",
              }
            );
          });
      }
    }),
  );
}
