/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type Stripe from "stripe";
import type {
  ProviderRefundAttempt,
  ProviderRefundResult,
} from "./provider-refund-attempts";

type StripeClient = InstanceType<typeof Stripe>;
type Refund = Awaited<
  ReturnType<StripeClient["refunds"]["list"]>
>["data"][number];

export interface ProviderRefundReader {
  charges: Pick<StripeClient["charges"], "retrieve">;
  refunds: Pick<StripeClient["refunds"], "list" | "retrieve">;
}

function normalize(refund: Refund, charge: string): ProviderRefundResult {
  const actual =
    typeof refund?.charge === "string" ? refund.charge : refund?.charge?.id;
  if (!refund?.id || actual !== charge)
    throw Error(
      "Provider refund belongs to another charge; funds remain reserved",
    );
  return {
    id: refund.id,
    charge,
    amount: refund.amount,
    status: refund.status ?? "",
  };
}

/** Reads only; does not bind a request or authorize provider work. */
export async function inspectProviderRefundCharge(
  stripe: ProviderRefundReader,
  attempt: ProviderRefundAttempt,
  charge: string,
): Promise<{
  amount: number;
  amount_refunded: number;
  refund?: ProviderRefundResult;
}> {
  const stripeCharge = await stripe.charges.retrieve(charge, {
    expand: ["refunds"],
  });
  const amount = Number(stripeCharge.amount);
  const amount_refunded = Number(stripeCharge.amount_refunded ?? 0);
  if (
    stripeCharge.id !== charge ||
    stripeCharge.currency !== "usd" ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(amount_refunded) ||
    amount_refunded < 0 ||
    amount_refunded > amount
  ) {
    throw Error(
      "Invalid refundable charge; funds remain reserved pending reconciliation",
    );
  }
  if (amount_refunded > 0 || attempt.provider_request) {
    const refunds: Refund[] = [];
    let starting_after: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 100)
        throw Error("Refund history requires operator reconciliation");
      const result = await stripe.refunds.list({
        charge,
        limit: 100,
        ...(starting_after ? { starting_after } : {}),
      });
      refunds.push(...result.data);
      if (!result.has_more) break;
      const last = result.data.at(-1)?.id;
      if (!last || last === starting_after)
        throw Error("Incomplete provider refund history");
      starting_after = last;
    }
    const own = refunds.find(
      (r) => r.metadata?.refund_attempt_id === attempt.id,
    );
    if (own) return { amount, amount_refunded, refund: normalize(own, charge) };
    const valid = refunds.filter(
      (r) => !["failed", "canceled"].includes(r.status ?? ""),
    );
    if (
      valid.some(
        (r) =>
          r.status !== "succeeded" ||
          (typeof r.charge === "string" ? r.charge : r.charge?.id) !== charge ||
          !Number.isSafeInteger(r.amount) ||
          r.amount <= 0,
      )
    ) {
      throw Error(
        "An existing refund is still unresolved; funds remain reserved",
      );
    }
    const refunded = valid.reduce((total, r) => total + r.amount, 0);
    if (refunded !== amount_refunded)
      throw Error(
        "Refund history disagrees with charge; reconcile before retrying",
      );
    if (refunded === amount)
      return { amount, amount_refunded, refund: normalize(valid[0], charge) };
  }
  return { amount, amount_refunded };
}

export async function readProviderRefund(
  stripe: ProviderRefundReader,
  attempt: ProviderRefundAttempt,
): Promise<ProviderRefundResult | undefined> {
  if (attempt.provider_result) {
    const charge =
      attempt.provider_request?.charge ?? attempt.provider_result.charge;
    return normalize(
      await stripe.refunds.retrieve(attempt.provider_result.id),
      charge,
    );
  }
  if (!attempt.provider_request) return;
  return (
    await inspectProviderRefundCharge(
      stripe,
      attempt,
      attempt.provider_request.charge,
    )
  ).refund;
}
