/*
Membership pricing + eligibility for in-app membership changes.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import {
  computeMembershipChange,
  getSeedMembershipTierMap,
} from "@cocalc/server/membership/tiers";
import { isPurchaseAllowed } from "@cocalc/server/purchases/is-purchase-allowed";
import { getBillingReadiness } from "@cocalc/server/purchases/stripe/billing-readiness";

function trialSetupReason({
  requiresBillingDetails,
  requiresPaymentMethod,
}: {
  requiresBillingDetails: boolean;
  requiresPaymentMethod: boolean;
}) {
  if (requiresBillingDetails && requiresPaymentMethod) {
    return "Add billing details and a payment method to start this free trial.";
  }
  if (requiresBillingDetails) {
    return "Add billing details to start this free trial.";
  }
  return "Add a payment method to start this free trial.";
}

export default async function handle(req, res) {
  try {
    res.json(await get(req));
  } catch (err) {
    res.json({ error: `${err.message}` });
    return;
  }
}

async function get(req) {
  if (req.header("Authorization")) {
    throw Error("API keys are not allowed to access billing account details");
  }
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }
  const { class: targetClass, interval, allow_downgrade } = req.body ?? {};
  if (!targetClass) {
    throw Error("membership class is required");
  }
  if (interval !== "month" && interval !== "year") {
    throw Error("interval must be 'month' or 'year'");
  }

  const tierMap = await getSeedMembershipTierMap({ includeDisabled: true });
  const pricing = await computeMembershipChange({
    account_id,
    targetClass,
    interval,
    allowDowngrade: !!allow_downgrade,
    storeVisibleOnly: true,
    tierMap,
  });

  if (pricing.trial_available && pricing.trial_days) {
    const readiness = await getBillingReadiness(account_id);
    const trial_requires_billing_details = !readiness.hasBillingDetails;
    const trial_requires_payment_method = !readiness.hasPaymentMethod;
    if (trial_requires_billing_details || trial_requires_payment_method) {
      return {
        ...pricing,
        allowed: false,
        reason: trialSetupReason({
          requiresBillingDetails: trial_requires_billing_details,
          requiresPaymentMethod: trial_requires_payment_method,
        }),
        charge_amount: 0,
        trial_requires_billing_details,
        trial_requires_payment_method,
      };
    }
    return {
      ...pricing,
      allowed: true,
      charge_amount: 0,
      trial_requires_billing_details: false,
      trial_requires_payment_method: false,
    };
  }

  if (pricing.charge <= 0) {
    return { ...pricing, allowed: true, charge_amount: 0 };
  }

  const purchase = await isPurchaseAllowed({
    account_id,
    service: "membership",
    cost: pricing.charge,
  });

  return {
    ...pricing,
    allowed: purchase.allowed,
    discouraged: purchase.discouraged,
    reason: purchase.reason,
    charge_amount: purchase.chargeAmount ?? pricing.charge,
  };
}
