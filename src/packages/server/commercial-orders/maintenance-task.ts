/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { isCommercialReceivablesCapabilityEnabled } from "./feature-flags";
import type { BillingAuthorityCommercialMaintenanceTask } from "@cocalc/server/purchases/billing-authority/protocol";
import {
  processCommercialStripeEventQueue,
  reconcileStaleCommercialInvoices,
  reconcileStaleCommercialQuotes,
} from "./reconcile";

export interface CommercialReceivablesAuthorityResult extends Record<
  string,
  unknown
> {
  task: BillingAuthorityCommercialMaintenanceTask;
  webhook: unknown;
  reconciliation: unknown;
  quoteReconciliation: unknown;
}

export async function runCommercialReceivablesAuthorityTask(
  task: BillingAuthorityCommercialMaintenanceTask,
): Promise<CommercialReceivablesAuthorityResult> {
  const reconciliationEnabled =
    await isCommercialReceivablesCapabilityEnabled("reconciliation");
  let webhook = { processed: 0, failed: 0, disabled: true };
  let reconciliation = { reconciled: 0, failed: 0, disabled: true };
  let quoteReconciliation = { reconciled: 0, failed: 0, disabled: true };
  if (reconciliationEnabled) {
    if (task === "stripe-events") {
      webhook = {
        ...(await processCommercialStripeEventQueue(1)),
        disabled: false,
      };
    } else if (task === "invoices") {
      reconciliation = {
        ...(await reconcileStaleCommercialInvoices({ limit: 1 })),
        disabled: false,
      };
    } else {
      quoteReconciliation = {
        ...(await reconcileStaleCommercialQuotes({ limit: 1 })),
        disabled: false,
      };
    }
  }
  return {
    task,
    webhook,
    reconciliation,
    quoteReconciliation,
  };
}
