/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  USE_BALANCE_TOWARD_SUBSCRIPTIONS,
  USE_BALANCE_TOWARD_SUBSCRIPTIONS_DEFAULT,
} from "@cocalc/util/db-schema/accounts";
import { toDecimal } from "@cocalc/util/money";
import type { MoneyValue } from "@cocalc/util/money";
import { getTotalBalance } from "./get-balance";
import { getBillingReadiness } from "./stripe/billing-readiness";

const DAY_MS = 24 * 60 * 60 * 1000;

export function getPaymentActionDate(currentPeriodEnd: Date): Date {
  return new Date(currentPeriodEnd.valueOf() - DAY_MS);
}

export function formatRenewalDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

export function formatPaymentActionDate(currentPeriodEnd: Date): string {
  return formatRenewalDate(getPaymentActionDate(currentPeriodEnd));
}

export async function useBalanceTowardSubscriptions(
  account_id: string,
): Promise<boolean> {
  const pool = getPool("long");
  const { rows } = await pool.query(
    `SELECT other_settings#>>'{${USE_BALANCE_TOWARD_SUBSCRIPTIONS}}' as use_balance FROM accounts WHERE account_id=$1`,
    [account_id],
  );
  switch (rows[0]?.use_balance) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      return USE_BALANCE_TOWARD_SUBSCRIPTIONS_DEFAULT;
  }
}

export async function getRenewalPaymentNotice({
  account_id,
  cost,
  current_period_end,
}: {
  account_id: string;
  cost: MoneyValue;
  current_period_end: Date;
}): Promise<string> {
  const useBalance = await useBalanceTowardSubscriptions(account_id);
  const totalBalance = toDecimal(await getTotalBalance(account_id));
  const renewalCost = toDecimal(cost ?? 0);
  if (useBalance && totalBalance.gte(renewalCost)) {
    return "Your account balance currently covers this renewal, so no card charge is expected.";
  }

  const billing = await getBillingReadiness(account_id);
  const actionDate = formatPaymentActionDate(current_period_end);
  if (billing.hasBillingDetails && billing.hasPaymentMethod) {
    return `Your payment method will be charged on or after ${actionDate}.`;
  }

  const missing = describeMissingBilling(billing);
  if (useBalance) {
    return `Add funds or ${missing} before ${actionDate} to avoid interruption.`;
  }
  return `Add ${missing} before ${actionDate} to avoid interruption.`;
}

function describeMissingBilling({
  hasBillingDetails,
  hasPaymentMethod,
}: {
  hasBillingDetails: boolean;
  hasPaymentMethod: boolean;
}): string {
  if (!hasBillingDetails && !hasPaymentMethod) {
    return "billing details and a payment method";
  }
  if (!hasBillingDetails) {
    return "billing details";
  }
  return "a payment method";
}
