/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { hasBillingDetails } from "./customer";
import { hasPaymentMethod } from "./get-payment-methods";

export interface BillingReadiness {
  hasBillingDetails: boolean;
  hasPaymentMethod: boolean;
}

export async function getBillingReadiness(
  account_id: string,
): Promise<BillingReadiness> {
  const [billingDetails, paymentMethod] = await Promise.all([
    hasBillingDetails(account_id),
    hasPaymentMethod(account_id),
  ]);
  return {
    hasBillingDetails: billingDetails,
    hasPaymentMethod: paymentMethod,
  };
}

export async function hasBillingReady(account_id: string): Promise<boolean> {
  const readiness = await getBillingReadiness(account_id);
  return readiness.hasBillingDetails && readiness.hasPaymentMethod;
}

export async function assertBillingReady(
  account_id: string,
): Promise<BillingReadiness> {
  const readiness = await getBillingReadiness(account_id);
  if (readiness.hasBillingDetails && readiness.hasPaymentMethod) {
    return readiness;
  }
  if (!readiness.hasBillingDetails && !readiness.hasPaymentMethod) {
    throw Error(
      "Billing details and a payment method are required to start a free trial.",
    );
  }
  if (!readiness.hasBillingDetails) {
    throw Error("Billing details are required to start a free trial.");
  }
  throw Error("A payment method is required to start a free trial.");
}
