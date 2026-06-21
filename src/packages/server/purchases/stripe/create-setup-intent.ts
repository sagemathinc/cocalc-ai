/*

"A SetupIntent guides you through the process of setting up and saving a
customer’s payment credentials for future payments. For example, you can use a
SetupIntent to set up and save your customer’s card without immediately
collecting a payment. Later, you can use PaymentIntents to drive the payment
flow." -- https://docs.stripe.com/api/setup_intents
*/

import getConn from "@cocalc/server/stripe/connection";
import getLogger from "@cocalc/backend/logger";
import { getStripeCustomerId } from "./util";
import { assertPaymentCheckoutAllowed } from "@cocalc/server/launch/kill-switches";
import { hasBillingDetails, setCustomer } from "./customer";

const logger = getLogger("purchases:stripe:create-setup-intent");

export default async function createSetupIntent({
  account_id,
  description,
  billing_details,
}: {
  account_id: string;
  description?: string;
  billing_details?: { name?: string; address?: any; email?: string };
}): Promise<{ clientSecret: string }> {
  logger.debug("createSetupIntent", { account_id });
  await assertPaymentCheckoutAllowed();
  if (billing_details != null) {
    await setCustomer(account_id, billing_details);
  }
  if (!(await hasBillingDetails(account_id))) {
    throw Error("Billing details are required before adding a payment method.");
  }

  const stripe = await getConn();
  const customer = await getStripeCustomerId({ account_id, create: true });
  if (!customer) {
    throw Error("bug");
  }

  logger.debug("createSetupIntent -- create setup intent for", { customer });

  const setupIntent = await stripe.setupIntents.create({
    customer,
    description,
    automatic_payment_methods: { enabled: true, allow_redirects: "always" },
    usage: "off_session",
    metadata: { account_id },
    use_stripe_sdk: true,
  });

  if (setupIntent.client_secret == null) {
    throw Error("bug -- client_secret should be defined");
  }

  return { clientSecret: setupIntent.client_secret };
}
