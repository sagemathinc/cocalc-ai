/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Admin refunds from the CLI: the same refund flow as the admin purchases UI
(POST /api/v2/purchases/create-refund), behind a preview. A preview shows the
purchase that would be refunded; a commit runs the billing authority's
create-refund command, which refunds a card payment through the payment
provider and records the refund purchase, and returns the existing refund if
the purchase was already refunded.
*/

import getPool from "@cocalc/database/pool";
import { executeBillingHttpCommand } from "@cocalc/server/purchases/billing-authority/client";
import type {
  AdminRefundPurchasePreview,
  AdminRefundResult,
} from "@cocalc/conat/hub/api/purchases";

const REASONS = [
  "duplicate",
  "fraudulent",
  "requested_by_customer",
  "other",
] as const;
type Reason = (typeof REASONS)[number];

const MAX_NOTES_LENGTH = 1000;

function normalizeReason(reason: unknown): Reason {
  const value = `${reason ?? ""}`.trim();
  if (!(REASONS as readonly string[]).includes(value)) {
    throw Error(`reason must be one of ${REASONS.join(", ")}`);
  }
  return value as Reason;
}

function normalizePurchaseId(purchase_id: unknown): number {
  const id = Number(purchase_id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Error("purchase_id must be a positive integer");
  }
  return id;
}

async function loadPurchase(id: number): Promise<AdminRefundPurchasePreview> {
  const { rows } = await getPool().query(
    `SELECT id, account_id, time, service, cost, invoice_id, description
       FROM purchases WHERE id=$1`,
    [id],
  );
  const row = rows[0];
  if (row == null) throw Error(`No purchase with id ${id}`);
  const refundId = row.description?.refund_purchase_id;
  return {
    id: row.id,
    account_id: row.account_id,
    time: row.time == null ? null : new Date(row.time).toISOString(),
    service: row.service,
    cost: row.cost == null ? null : Number(row.cost),
    description_type: row.description?.type ?? null,
    provider_payment:
      (row.service === "credit" || row.service === "auto-credit") &&
      !!row.invoice_id,
    existing_refund_purchase_id: Number.isInteger(refundId) ? refundId : null,
  };
}

export async function adminRefundPurchase({
  admin_account_id,
  purchase_id,
  reason,
  notes,
  commit,
}: {
  admin_account_id: string;
  purchase_id: unknown;
  reason: unknown;
  notes?: unknown;
  commit: boolean;
}): Promise<AdminRefundResult> {
  const id = normalizePurchaseId(purchase_id);
  const normalizedReason = normalizeReason(reason);
  const normalizedNotes = `${notes ?? ""}`.trim();
  if (normalizedNotes.length > MAX_NOTES_LENGTH) {
    throw Error(`notes must be at most ${MAX_NOTES_LENGTH} characters`);
  }
  const purchase = await loadPurchase(id);
  const result: AdminRefundResult = {
    commit,
    purchase,
    reason: normalizedReason,
    notes: normalizedNotes,
  };
  if (!commit) return result;
  const refund_purchase_id = await executeBillingHttpCommand<number>(
    "create-refund",
    {
      account_id: admin_account_id,
      actor_account_id: admin_account_id,
      purchase_id: id,
      reason: normalizedReason,
      notes: normalizedNotes,
    },
  );
  return { ...result, refund_purchase_id };
}
