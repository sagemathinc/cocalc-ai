/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import type {
  CreditFragment,
  PaymentRoot,
} from "@cocalc/util/credit-transfers";
import { COST_OR_METERED_COST } from "../get-balance";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import { projectCreditLots } from "./provenance";
import type { VerifiedPaymentRoot } from "./payment-verification";

export async function importVerifiedPaymentRoots(
  client: PoolClient,
  account_id: string,
  verified: VerifiedPaymentRoot[],
) {
  for (const { root, evidence } of verified) {
    if (root.account_id !== account_id) continue;
    // Recheck mutable local refund/fulfillment state after taking the common lock.
    const { rows } = await client.query(
      `SELECT p.id FROM purchases p
      WHERE p.account_id=$1 AND p.invoice_id=$2 AND p.cost=-$3::numeric
      AND p.service IN ('credit','auto-credit') AND p.description->>'purpose' IN ('add-credit','auto-credit')
      AND NOT EXISTS (SELECT 1 FROM provider_refund_attempts r WHERE r.purchase_id=p.id AND r.state <> 'failed')
      AND NOT EXISTS (SELECT 1 FROM payment_fulfillments f WHERE f.credit_id=p.id)`,
      [account_id, root.payment_intent_id, root.amount_usd],
    );
    if (!rows.length)
      throw Error("Payment credit changed during transfer verification");
    await client.query(
      `INSERT INTO credit_payment_roots
      (root_id,account_id,home_bay_id,purchase_id,payment_intent_id,amount_usd,evidence,original_purchase_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (root_id) DO UPDATE SET
        evidence=excluded.evidence,
        original_purchase_id=COALESCE(credit_payment_roots.original_purchase_id,excluded.original_purchase_id)
      WHERE credit_payment_roots.account_id=excluded.account_id
        AND credit_payment_roots.purchase_id=excluded.purchase_id
        AND credit_payment_roots.payment_intent_id=excluded.payment_intent_id
        AND credit_payment_roots.amount_usd=excluded.amount_usd`,
      [
        root.root_id,
        root.account_id,
        root.home_bay_id,
        rows[0].id,
        root.payment_intent_id,
        root.amount_usd,
        evidence,
        root.purchase_id,
      ],
    );
  }
}

export async function readCreditLots(
  client: PoolClient,
  account_id: string,
  eligibleRoots?: ReadonlySet<string>,
): Promise<CreditFragment[]> {
  const { rows: roots } = await client.query<
    PaymentRoot & { local_purchase_id: number }
  >(
    `SELECT root_id,home_bay_id,account_id,purchase_id AS local_purchase_id,
     COALESCE(original_purchase_id,purchase_id) AS purchase_id,payment_intent_id,amount_usd::text
     FROM credit_payment_roots WHERE account_id=$1`,
    [account_id],
  );
  const rootByPurchase = new Map(
    roots.map(({ local_purchase_id, ...root }) => [local_purchase_id, root]),
  );
  const { rows: entries } = await client.query<{
    purchase_id: number;
    leg: string;
    fragments: CreditFragment[];
  }>(
    "SELECT purchase_id,leg,fragments FROM credit_transfer_entries WHERE account_id=$1",
    [account_id],
  );
  const entryByPurchase = new Map(
    entries.map((entry) => [entry.purchase_id, entry]),
  );
  // An incomplete scan must never imply that absent debits did not happen.
  const { rows } = await client.query<{
    id: number;
    cost: string;
    service: string;
    invoice_id: string;
  }>(
    `SELECT id,(${COST_OR_METERED_COST})::text AS cost,service,invoice_id FROM purchases WHERE account_id=$1 ORDER BY id LIMIT 100001`,
    [account_id],
  );
  if (rows.length > 100000)
    throw Error(
      "Transfer provenance ledger needs a checkpoint before continuing",
    );
  const seen = new Set(rows.map(({ id }) => id));
  const { rows: observations } = await client.query<{
    purchase_id: number;
    max_cost: string;
  }>(
    "SELECT purchase_id,max_cost::text FROM credit_transfer_ledger_observations WHERE account_id=$1",
    [account_id],
  );
  const observed = new Map(
    observations.map((row) => [row.purchase_id, row.max_cost]),
  );
  if (
    [
      ...rootByPurchase.keys(),
      ...entryByPurchase.keys(),
      ...observed.keys(),
    ].some((id) => !seen.has(id))
  )
    throw Error("Transfer provenance ledger is incomplete");
  for (const row of rows) {
    if (row.cost == null) throw Error("Transfer provenance cost is unresolved");
    const prior = observed.get(row.id);
    if (prior != null && toDecimal(prior).gt(row.cost)) row.cost = prior;
  }
  await client.query(
    `INSERT INTO credit_transfer_ledger_observations (purchase_id,account_id,max_cost)
    SELECT x.purchase_id,$1,x.cost FROM jsonb_to_recordset($2::jsonb) AS x(purchase_id integer,cost numeric)
    ON CONFLICT (purchase_id) DO UPDATE SET max_cost=GREATEST(credit_transfer_ledger_observations.max_cost,excluded.max_cost)`,
    [
      account_id,
      JSON.stringify(
        rows.map((row) => ({ purchase_id: row.id, cost: row.cost })),
      ),
    ],
  );
  return projectCreditLots(
    rows.map((row) => {
      if (row.cost == null)
        throw Error("Transfer provenance cost is unresolved");
      const root = rootByPurchase.get(row.id);
      const entry = entryByPurchase.get(row.id);
      if (row.service === "credit-transfer" && !entry)
        throw Error("Unattributed transfer ledger entry");
      if (root) {
        if (
          entry ||
          row.invoice_id !== root.payment_intent_id ||
          !toDecimal(row.cost).neg().eq(root.amount_usd)
        )
          throw Error("Payment provenance changed");
        return {
          id: row.id,
          cost: row.cost,
          credit: [
            {
              root,
              source_purchase_id: row.id,
              amount_usd: moneyToDbString(root.amount_usd),
            },
          ],
        };
      }
      return {
        id: row.id,
        cost: row.cost,
        ...(entry
          ? entry.leg === "debit"
            ? { debit: entry.fragments }
            : { credit: entry.fragments }
          : {}),
      };
    }),
    eligibleRoots,
  );
}

/** Exported roots remain attached to their original payment. Voluntary provider
 * refunds require reconciliation of that chain, even after sender compensation.
 */
export async function assertPaymentRootNotExported(
  client: PoolClient,
  account_id: string,
  purchase_id: number,
) {
  const { rows } = await client.query(
    `SELECT 1 FROM credit_transfer_entries e, jsonb_array_elements(e.fragments) f,
      credit_payment_roots r
    WHERE e.account_id=$1 AND e.leg='debit' AND r.account_id=$1 AND r.purchase_id=$2
      AND f->'root'->>'root_id'=r.root_id::text LIMIT 1`,
    [account_id, purchase_id],
  );
  if (rows.length)
    throw Error(
      "Transferred payment credit must be reconciled through its transfer chain before refunding",
    );
}
