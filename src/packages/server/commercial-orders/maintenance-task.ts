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
  const webhook = reconciliationEnabled
    ? await processCommercialStripeEventQueue(100)
    : { processed: 0, failed: 0, disabled: true };
  const reconciliation = reconciliationEnabled
    ? await reconcileStaleCommercialInvoices({ limit: 100 })
    : { reconciled: 0, failed: 0, disabled: true };
  const quoteReconciliation = reconciliationEnabled
    ? await reconcileStaleCommercialQuotes({ limit: 100 })
    : { reconciled: 0, failed: 0, disabled: true };
  const diagnostics = await getCommercialOrderDiagnostics();
  updateCommercialQueueMetrics(diagnostics);
  return { webhook, reconciliation, quoteReconciliation, diagnostics };
}
