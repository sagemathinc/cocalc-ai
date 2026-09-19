/*
Create a stripe checkout session with mode "setup" to setup things
for future *automatic payments*.

DOES NOT WORK.  This very bizarrely and stupidly doesn't work, because for
mode='setup' you have to specify the exact payment types you accept for
the given user... which makes absolutely no sense for us to do, since stripe
should be doing that, as it is a function of geographic location, etc.
This is really weird.  So we're switching back to a usage based subscription
hack, since that works.

NOTE: this is just the first step of implementing this, and we would also
need a webhook to finish it.

See:

 - https://stripe.com/docs/payments/save-and-reuse
 - https://stripe.com/docs/api/checkout/sessions
 - https://stripe.com/docs/api/payment_intents

*/

import getConn from "@cocalc/server/stripe/connection";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import {
  billingAccountsTable,
  ensureBillingAccount,
  getBillingAccountProfile,
} from "@cocalc/server/purchases/billing-account";
import { getStripeCustomerId } from "./stripe/util";
import { getCurrentSession } from "./create-stripe-checkout-session";
import type { Checkout } from "stripe";
import { assertPaymentCheckoutAllowed } from "@cocalc/server/launch/kill-switches";

const logger = getLogger("purchases:create-stripe-payment-method-session");

interface Options {
  account_id: string;
  success_url: string;
  cancel_url?: string;
}

export default async function createStripePaymentMethodSession(
  opts: Options,
): Promise<Checkout.Session> {
  const { account_id, success_url, cancel_url } = opts;
  const log = (...args) => {
    logger.debug("createStripePaymentMethodSession", ...args);
  };
  log(opts);
  await assertPaymentCheckoutAllowed();

  // check if there is already a stripe checkout session; if so throw error.
  if ((await getCurrentSession(account_id)) != null) {
    throw Error("there is already an active stripe checkout session");
  }
  await ensureBillingAccount(account_id);
  if (!success_url) {
    throw Error("success_url must be nontrivial");
  }
  const stripe = await getConn();
  const customer = await getStripeCustomerId({ account_id, create: true });
  log({ customer });
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    success_url: success_url + "?session_id={CHECKOUT_SESSION_ID}",
    cancel_url,
    client_reference_id: account_id,
    customer,
    customer_email:
      customer == null
        ? (await getBillingAccountProfile(account_id)).email_address
        : undefined,
    tax_id_collection: { enabled: true },
    //     automatic_tax: {
    //       enabled: true,
    //     },
    customer_update: {
      address: "auto",
      name: "auto",
      shipping: "auto",
    },
  });
  const db = getPool();
  const table = billingAccountsTable();
  await db.query(
    `UPDATE ${table} SET stripe_checkout_session=$2 WHERE account_id=$1`,
    [account_id, { id: session.id, url: session.url }],
  );
  return session;
}
