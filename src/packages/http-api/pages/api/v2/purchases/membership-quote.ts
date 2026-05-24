/*
Membership pricing + eligibility for in-app membership changes.
*/

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { computeMembershipChange } from "@cocalc/server/membership/tiers";
import { isPurchaseAllowed } from "@cocalc/server/purchases/is-purchase-allowed";
import { hasPaymentMethod } from "@cocalc/server/purchases/stripe/get-payment-methods";

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

  const pricing = await computeMembershipChange({
    account_id,
    targetClass,
    interval,
    allowDowngrade: !!allow_downgrade,
    storeVisibleOnly: true,
  });

  if (pricing.trial_available && pricing.trial_days) {
    if (!(await hasPaymentMethod(account_id))) {
      return {
        ...pricing,
        allowed: false,
        reason: "Add a payment method to start this free trial.",
        charge_amount: 0,
        trial_requires_payment_method: true,
      };
    }
    return {
      ...pricing,
      allowed: true,
      charge_amount: 0,
      trial_requires_payment_method: true,
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
