/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { CreditFragment } from "@cocalc/util/credit-transfers";
export type {
  PaymentRoot,
  CreditFragment,
} from "@cocalc/util/credit-transfers";

export interface ProvenancePurchase {
  id: number;
  cost: string;
  /** Present only for server-verified payment roots or durable received transfers. */
  credit?: CreditFragment[];
  /** Explicit source fragments recorded atomically with an outgoing transfer. */
  debit?: CreditFragment[];
}

/** Reconstruct the actual ledger, not payment totals capped by total balance.
 * Ordinary debits consume paid lots first, then restricted credit. Later refunds
 * and promotional credits cannot recreate spent paid lots. Outstanding debt
 * consumes future credits before any new transferable lot is available.
 */
export function projectCreditLots(
  purchases: ProvenancePurchase[],
  eligibleRoots?: ReadonlySet<string>,
): CreditFragment[] {
  const lots: CreditFragment[] = [];
  let restricted = toDecimal(0);
  let debt = toDecimal(0);
  let previous = 0;
  for (const row of purchases) {
    if (!Number.isSafeInteger(row.id) || row.id <= previous)
      throw Error("Unordered provenance ledger");
    previous = row.id;
    const cost = toDecimal(row.cost);
    if (row.credit) {
      if (!cost.lt(0) || row.debit) throw Error("Invalid provenance credit");
      let sum = toDecimal(0);
      for (const fragment of row.credit) {
        const amount = toDecimal(fragment.amount_usd);
        if (!amount.gt(0)) throw Error("Invalid credit fragment");
        sum = sum.plus(amount);
        const applied = amount.lt(debt) ? amount : debt;
        debt = debt.minus(applied);
        lots.push({
          ...fragment,
          source_purchase_id: row.id,
          amount_usd: moneyToDbString(amount.minus(applied)),
        });
      }
      if (!sum.eq(cost.neg()))
        throw Error("Provenance credit does not match ledger");
    } else if (cost.lt(0)) {
      const amount = cost.neg();
      const applied = amount.lt(debt) ? amount : debt;
      debt = debt.minus(applied);
      restricted = restricted.plus(amount.minus(applied));
    } else if (row.debit) {
      let sum = toDecimal(0);
      for (const fragment of row.debit) {
        let amount = toDecimal(fragment.amount_usd);
        if (!amount.gt(0)) throw Error("Invalid debit fragment");
        sum = sum.plus(amount);
        for (const lot of lots) {
          if (
            lot.root.root_id !== fragment.root.root_id ||
            lot.source_purchase_id !== fragment.source_purchase_id
          )
            continue;
          const remaining = toDecimal(lot.amount_usd);
          const used = remaining.lt(amount) ? remaining : amount;
          lot.amount_usd = moneyToDbString(remaining.minus(used));
          amount = amount.minus(used);
        }
        // A backdated/edited purchase cannot silently reassign already exported credit.
        if (!amount.isZero())
          throw Error("Exported payment provenance requires reconciliation");
      }
      if (!sum.eq(cost)) throw Error("Provenance debit does not match ledger");
    } else {
      let remaining = cost;
      const spendOrder = eligibleRoots
        ? [
            ...lots.filter((lot) => eligibleRoots.has(lot.root.root_id)),
            ...lots.filter((lot) => !eligibleRoots.has(lot.root.root_id)),
          ]
        : lots;
      for (const lot of spendOrder) {
        const available = toDecimal(lot.amount_usd);
        const used = available.lt(remaining) ? available : remaining;
        lot.amount_usd = moneyToDbString(available.minus(used));
        remaining = remaining.minus(used);
        if (remaining.isZero()) break;
      }
      const used = restricted.lt(remaining) ? restricted : remaining;
      restricted = restricted.minus(used);
      debt = debt.plus(remaining.minus(used));
    }
  }
  return lots.filter((lot) => toDecimal(lot.amount_usd).gt(0));
}

export function selectCreditFragments(
  lots: CreditFragment[],
  eligibleRoots: ReadonlySet<string>,
  amount_usd: string,
): CreditFragment[] {
  let remaining = toDecimal(amount_usd);
  if (remaining.lte(0)) throw Error("Invalid transfer amount");
  const selected: CreditFragment[] = [];
  for (const lot of lots) {
    if (!eligibleRoots.has(lot.root.root_id)) continue;
    const available = toDecimal(lot.amount_usd);
    const used = available.lt(remaining) ? available : remaining;
    if (used.gt(0))
      selected.push({ ...lot, amount_usd: moneyToDbString(used) });
    remaining = remaining.minus(used);
    if (remaining.isZero()) return selected;
  }
  throw Error("Insufficient cleared, unencumbered payment credit");
}
