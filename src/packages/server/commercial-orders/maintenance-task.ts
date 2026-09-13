/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { isCommercialReceivablesCapabilityEnabled } from "./feature-flags";
import type { CommercialOrderDiagnostics } from "@cocalc/util/commercial-orders";
import { updateCommercialQueueMetrics } from "./observability";
import {
  processCommercialStripeEventQueue,
  reconcileStaleCommercialInvoices,
  reconcileStaleCommercialQuotes,
} from "./reconcile";
import { getCommercialOrderDiagnostics } from "./store";

export interface CommercialReceivablesAuthorityResult extends Record<
  string,
  unknown
> {
  webhook: unknown;
  reconciliation: unknown;
  quoteReconciliation: unknown;
  diagnostics: CommercialOrderDiagnostics;
}

export async function runCommercialReceivablesAuthorityTask(): Promise<CommercialReceivablesAuthorityResult> {
  const reconciliationEnabled =
    await isCommercialReceivablesCapabilityEnabled("reconciliation");
  let webhook = { processed: 0, failed: 0, disabled: true };
  let reconciliation = { reconciled: 0, failed: 0, disabled: true };
  let quoteReconciliation = { reconciled: 0, failed: 0, disabled: true };
  if (reconciliationEnabled) {
    webhook = {
      ...(await processCommercialStripeEventQueue(1)),
      disabled: false,
    };
    if (webhook.processed + webhook.failed === 0) {
      reconciliation = {
        ...(await reconcileStaleCommercialInvoices({ limit: 1 })),
        disabled: false,
      };
    }
    if (
      webhook.processed +
        webhook.failed +
        reconciliation.reconciled +
        reconciliation.failed ===
      0
    ) {
      quoteReconciliation = {
        ...(await reconcileStaleCommercialQuotes({ limit: 1 })),
        disabled: false,
      };
    }
  }
  const diagnostics = await getCommercialOrderDiagnostics();
  updateCommercialQueueMetrics(diagnostics);
  return { webhook, reconciliation, quoteReconciliation, diagnostics };
}
