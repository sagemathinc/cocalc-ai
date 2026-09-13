/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import deletePaymentMethod from "@cocalc/server/purchases/stripe/delete-payment-method";
import { cancelPaymentIntent } from "@cocalc/server/purchases/stripe/create-payment-intent";
import { getAllOpenPayments } from "@cocalc/server/purchases/stripe/get-payments";
import getPaymentMethods from "@cocalc/server/purchases/stripe/get-payment-methods";

export async function cancelOpenPaymentIntentsForQuarantine(
  account_id: string,
): Promise<number> {
  const payments = await getAllOpenPayments(account_id);
  let count = 0;
  for (const intent of payments.data ?? []) {
    if (!intent?.id) continue;
    await cancelPaymentIntent({ id: intent.id, reason: "fraudulent" });
    count += 1;
  }
  return count;
}

export async function detachPaymentMethodsForQuarantine(
  account_id: string,
): Promise<number> {
  let count = 0;
  let starting_after: string | undefined;
  do {
    const methods = await getPaymentMethods({
      account_id,
      starting_after,
      limit: 100,
    });
    for (const method of methods.data ?? []) {
      if (!method?.id) continue;
      await deletePaymentMethod({ account_id, payment_method: method.id });
      count += 1;
      starting_after = method.id;
    }
    if (!methods.has_more) break;
  } while (starting_after);
  return count;
}
