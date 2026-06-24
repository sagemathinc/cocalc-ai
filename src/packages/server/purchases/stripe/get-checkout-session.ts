import getConn from "@cocalc/server/stripe/connection";
import getLogger from "@cocalc/backend/logger";
import {
  assertValidUserMetadata,
  getStripeCustomerId,
  sanityCheckAmount,
  getStripeLineItems,
  currentStripeSite,
} from "./util";
import type {
  CheckoutSessionSecret,
  CheckoutSessionOptions,
} from "@cocalc/util/stripe/types";
import { isEqual } from "lodash";
import { createHash } from "node:crypto";
import { decimalToStripe } from "@cocalc/util/stripe/calc";
import { url } from "@cocalc/server/messages/send";
import { toDecimal } from "@cocalc/util/money";
import { assertPaymentCheckoutAllowed } from "@cocalc/server/launch/kill-switches";

const logger = getLogger("purchases:stripe:get-checkout-session");

function stableJson(value): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkoutSessionKey({
  description,
  lineItems,
  metadata,
}: {
  description: string;
  lineItems: unknown[];
  metadata: Record<string, string>;
}): string {
  return createHash("sha256")
    .update(stableJson({ description, lineItems, metadata }))
    .digest("hex");
}

interface Options extends CheckoutSessionOptions {
  // user that is paying: assumed already authenticated/valid
  account_id: string;
}

export default async function getCheckoutSession({
  account_id,
  purpose,
  description,
  lineItems,
  return_url,
  metadata,
}: Options): Promise<CheckoutSessionSecret> {
  logger.debug("getCheckoutSession", {
    account_id,
    purpose,
    description,
    lineItems,
    return_url,
    metadata,
  });
  if (!purpose) {
    throw Error("purpose must be set");
  }
  await assertPaymentCheckoutAllowed();
  assertValidUserMetadata(metadata);

  let total = toDecimal(0);
  for (const { amount } of lineItems) {
    total = total.add(toDecimal(amount));
  }
  await sanityCheckAmount(total);

  const stripe = await getConn();
  const customer = await getStripeCustomerId({ account_id, create: true });
  if (!customer) {
    throw Error("bug");
  }

  const baseMetadata = {
    ...metadata,
    purpose,
    account_id,
    cocalc_site: await currentStripeSite(),
  };
  const checkout_key = checkoutSessionKey({
    description,
    lineItems,
    metadata: baseMetadata,
  });
  metadata = {
    ...baseMetadata,
    checkout_key,
    lineItems: JSON.stringify(lineItems),
  };

  if (!return_url) {
    return_url = await url();
  }

  const openSessions = await stripe.checkout.sessions.list({
    status: "open",
    customer,
  });
  // cutoff = an hour ago in stripe time.  Restricting only to status='open'
  // as above should work, but doesn't, since we had many reports of users
  // with open checkout sessions that didn't work. This might help.
  const cutoff = Math.floor((Date.now() - 1000 * 60 * 60) / 1000);
  for (const session of openSessions.data) {
    if (session.metadata?.purpose == purpose && session.client_secret) {
      if (
        session.metadata?.checkout_key != checkout_key ||
        !isEqual(session.metadata?.lineItems, JSON.stringify(lineItems)) ||
        session.created <= cutoff
      ) {
        logger.debug("getCheckoutSession: expiring checkout session");
        // The line items or description changed or its older than an hour, so don't use it.
        await stripe.checkout.sessions.expire(session.id);
      } else {
        logger.debug("getCheckoutSession: using existing checkout session");
        // we use it -- same line items
        return { clientSecret: session.client_secret, sessionId: session.id };
      }
    }
  }

  const { lineItemsWithoutCredit, total_excluding_tax_usd } =
    getStripeLineItems(lineItems);

  metadata = {
    ...metadata,
    total_excluding_tax_usd: `${total_excluding_tax_usd}`,
  };
  const session = await stripe.checkout.sessions.create({
    customer,
    ui_mode: "embedded_page",
    line_items: lineItemsWithoutCredit.map(({ amount, description }) => {
      return {
        price_data: {
          unit_amount: decimalToStripe(amount),
          currency: "usd",
          product_data: {
            name: description,
          },
        },
        quantity: 1,
      };
    }),
    mode: "payment",
    return_url,
    redirect_on_completion: "if_required",
    automatic_tax: { enabled: true },
    metadata,
    payment_intent_data: {
      description,
      setup_future_usage: "off_session",
      metadata: { ...metadata, confirm: "true" },
    },

    // not sure we'll use this, but it's a good double check
    client_reference_id: account_id,
    invoice_creation: {
      enabled: true,
      invoice_data: {
        metadata,
      },
    },
    tax_id_collection: { enabled: true },
    customer_update: {
      address: "auto",
      name: "auto",
      shipping: "auto",
    },
    saved_payment_method_options: {
      allow_redisplay_filters: ["limited", "always", "unspecified"],
    },
  });

  if (!session.client_secret) {
    throw Error("unable to create session");
  }

  return { clientSecret: session.client_secret, sessionId: session.id };
}
