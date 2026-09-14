/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { CommercialReceivableAmounts } from "@cocalc/util/commercial-orders";

// Called by the seed-authoritative store. SQL numeric aggregation avoids both
// floating-point rounding and accidental sums across currencies or invoice joins.
export async function getDiagnosticAmounts(): Promise<
  Record<string, CommercialReceivableAmounts>
> {
  const { rows } = await getPool().query<
    CommercialReceivableAmounts & { currency: string }
  >(`
    WITH invoices AS (
      SELECT lower(i.currency) AS currency,
        sum(i.amount_due) AS invoice_outstanding,
        sum(CASE WHEN i.due_at < NOW() THEN i.amount_due ELSE 0 END) AS invoice_overdue,
        sum(CASE WHEN o.fulfillment_state='provisioned' THEN i.amount_due ELSE 0 END)
          AS fulfilled_invoice_outstanding
      FROM commercial_invoices i JOIN commercial_orders o ON o.id=i.commercial_order_id
      WHERE i.status='open' AND i.amount_due > 0
      GROUP BY lower(i.currency)
    ), orders AS (
      SELECT lower(o.currency) AS currency,
        sum(CASE WHEN o.collection_state='not_invoiced' AND NOT EXISTS (
          SELECT 1 FROM commercial_invoices i WHERE i.commercial_order_id=o.id
            AND i.status IN ('creating','draft','open','paid','uncollectible')
        ) THEN o.agreed_total ELSE 0 END) AS uninvoiced_pipeline,
        sum(CASE WHEN o.collection_state='paid' AND o.fulfillment_state='not_provisioned'
          THEN o.agreed_total ELSE 0 END) AS paid_unfulfilled_order_value,
        sum(o.agreed_total) AS open_order_value
      FROM commercial_orders o WHERE o.workflow_state NOT IN ('complete','cancelled')
      GROUP BY lower(o.currency)
    )
    SELECT COALESCE(i.currency,o.currency) AS currency,
      COALESCE(i.invoice_outstanding,0)::text AS invoice_outstanding,
      COALESCE(i.invoice_overdue,0)::text AS invoice_overdue,
      COALESCE(i.fulfilled_invoice_outstanding,0)::text AS fulfilled_invoice_outstanding,
      COALESCE(o.uninvoiced_pipeline,0)::text AS uninvoiced_pipeline,
      COALESCE(o.paid_unfulfilled_order_value,0)::text AS paid_unfulfilled_order_value,
      COALESCE(o.open_order_value,0)::text AS open_order_value
    FROM invoices i FULL OUTER JOIN orders o ON o.currency=i.currency
    ORDER BY currency
  `);
  return Object.fromEntries(
    rows.map(({ currency, ...amounts }) => [currency, amounts]),
  );
}
