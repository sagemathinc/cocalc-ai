import getConn from "@cocalc/server/stripe/connection";
import getLogger from "@cocalc/backend/logger";
import {
  defaultReturnUrl,
  getStripeCustomerId,
  sanityCheckAmount,
  assertValidUserMetadata,
  getStripeLineItems,
  currentStripeSite,
} from "./util";
import type {
  LineItem,
  PaymentIntentCancelReason,
} from "@cocalc/util/stripe/types";
import {
  alertUncreditedSucceededPayment,
  isReadyToProcess,
  processPaymentIntent,
} from "./process-payment-intents";
import { decimalToStripe, grandTotal } from "@cocalc/util/stripe/calc";
import { SUBSCRIPTION_RENEWAL } from "@cocalc/util/db-schema/purchases";
import { bindSubscriptionRenewalPaymentIntent } from "../subscription-renewal-attempts";
import send, { name, support, url } from "@cocalc/server/messages/send";
import { delay } from "awaiting";
import { assertPaymentCheckoutAllowed } from "@cocalc/server/launch/kill-switches";

const logger = getLogger("purchases:stripe:create-payment-intent");
const INVOICE_PAYMENT_EXPAND = ["payments.data.payment.payment_intent"];

export default async function createPaymentIntent({
  account_id,
  purpose,
  description,
  lineItems,
  return_url,
  metadata,
  force,
  requireAddress = false,
  processImmediately = true,
  idempotencyKeyPrefix,
  allowedPaymentMethodTypes,
}: {
  account_id: string;
  purpose: string;
  // arbitrary string to show to the user
  description?: string;
  lineItems: LineItem[];
  return_url?: string;
  // optional extra metadata: do NOT use 'purpose', 'account_id', 'confirm' or 'processed'.
  // as a key.
  metadata?: { [key: string]: string };
  // Returns a finalized invoice object -- https://docs.stripe.com/api/invoices/object

  // do not bother with sanity checking the amount, e.g., it can be below the
  // min payg setting.
  force?: boolean;
  // For interactive checkout, require a customer address so automatic tax can
  // be computed before we attempt to charge the user.
  requireAddress?: boolean;
  // Some callers must persist local state that processPaymentIntent reads
  // before an immediately paid invoice can be safely processed.
  processImmediately?: boolean;
  // Stable identity for replaying every Stripe mutation in this payment.
  idempotencyKeyPrefix?: string;
  // Restrict automatic collection to explicitly supported instant methods.
  allowedPaymentMethodTypes?: string[];
}): Promise<{ payment_intent: string; hosted_invoice_url: string }> {
  logger.debug("createPaymentIntent", {
    account_id,
    purpose,
    description,
    lineItems,
    return_url,
    force,
  });
  if (!purpose) {
    throw Error("purpose must be set");
  }
  await assertPaymentCheckoutAllowed();
  assertValidUserMetadata(metadata);

  const { lineItemsWithoutCredit, total_excluding_tax_usd } =
    getStripeLineItems(lineItems);

  logger.debug("createPaymentIntent -- ", {
    lineItemsWithoutCredit,
    total_excluding_tax_usd,
  });

  if (!force) {
    await sanityCheckAmount(grandTotal(lineItemsWithoutCredit));
  }

  const stripe = await getConn();
  const customer = await getStripeCustomerId({ account_id, create: true });
  if (!customer) {
    throw Error("bug");
  }

  logger.debug("createPaymentIntent -- create invoice:", { customer });

  metadata = {
    ...metadata,
    purpose,
    account_id,
    cocalc_site: await currentStripeSite(),
    confirm: "true",
    total_excluding_tax_usd: `${total_excluding_tax_usd}`,
  };

  if (!return_url) {
    return_url = await defaultReturnUrl();
  }

  let invoice;
  const invoiceCreateParams = {
    customer,
    auto_advance: false,
    description,
    metadata,
    currency: "usd",
  };

  const addLineItems = async (invoice) => {
    for (const [
      index,
      { amount, description },
    ] of lineItemsWithoutCredit.entries()) {
      logger.debug("creating and add invoice item", {
        customer,
        amount: decimalToStripe(amount),
        currency: "usd",
        description,
        invoice: invoice.id,
      });
      const params = {
        customer,
        amount: decimalToStripe(amount),
        currency: "usd",
        description,
        invoice: invoice.id,
      };
      if (idempotencyKeyPrefix) {
        await stripe.invoiceItems.create(params, {
          idempotencyKey: `${idempotencyKeyPrefix}:item:${index}`,
        });
      } else {
        await stripe.invoiceItems.create(params);
      }
    }
  };

  let finalizedInvoice;
  logger.debug("creating invoice with automatic_tax enabled");
  // try with tax enabled
  const createParams = {
    ...invoiceCreateParams,
    automatic_tax: { enabled: true },
  };
  invoice = idempotencyKeyPrefix
    ? await stripe.invoices.create(createParams, {
        idempotencyKey: `${idempotencyKeyPrefix}:invoice`,
      })
    : await stripe.invoices.create(createParams);
  await addLineItems(invoice);
  try {
    const finalizeParams = {
      auto_advance: false,
      expand: INVOICE_PAYMENT_EXPAND,
    };
    finalizedInvoice = idempotencyKeyPrefix
      ? await stripe.invoices.finalizeInvoice(invoice.id, finalizeParams, {
          idempotencyKey: `${idempotencyKeyPrefix}:finalize`,
        })
      : await stripe.invoices.finalizeInvoice(invoice.id, finalizeParams);
  } catch (err) {
    if (requireAddress) {
      throw Error(
        `Name and address are required before checkout so CoCalc can calculate tax. Please add your name and address and try again. ${err}`,
      );
    }
    logger.debug(`creating invoice with automatic_tax enabled failed: ${err}`);
    logger.debug("creating invoice WITHOUT automatic_tax enabled");
    // failed, so do without tax enabled.  If a user has NO INFO in stripe, then
    // tax will fail.  But there are rare situations where we need to auto generate an
    // invoice, but there is no interactive session with the user, so we fallback
    // here to not using tax in this case.  Once they enter payment information
    // to pay this, next time tax will be properly charged.
    // ALSO we explicitly send them an "ACTION REQUIRED" message asking them to
    // enter their address for tax purposes, and when they do then things will work
    // for all future purposes.  I think it is only likely that old customers would
    // ever get in this situation.
    const updateParams = {
      automatic_tax: { enabled: false },
    };
    if (idempotencyKeyPrefix) {
      await stripe.invoices.update(invoice.id, updateParams, {
        idempotencyKey: `${idempotencyKeyPrefix}:disable-tax`,
      });
    } else {
      await stripe.invoices.update(invoice.id, updateParams);
    }
    const finalizeParams = {
      auto_advance: false,
      expand: INVOICE_PAYMENT_EXPAND,
    };
    finalizedInvoice = idempotencyKeyPrefix
      ? await stripe.invoices.finalizeInvoice(invoice.id, finalizeParams, {
          idempotencyKey: `${idempotencyKeyPrefix}:finalize-without-tax`,
        })
      : await stripe.invoices.finalizeInvoice(invoice.id, finalizeParams);
    send({
      to_ids: [account_id],
      subject: "ACTION REQUIRED: Enter your address for tax purposes",
      body: `
Dear ${await name(account_id)},

Please visit [Payment Methods](${await url("settings", "payment-methods")}) and enter
your name and address so that for we can correctly charge tax.

${await support()}
      `,
    });
  }

  let paymentIntentId = await getInvoicePaymentIntentId({
    stripe,
    invoice: finalizedInvoice,
  });
  // Stripe creates a default InvoicePayment during invoice finalization. In
  // current API versions the PaymentIntent id lives there, not on a top-level
  // invoice.payment_intent field.
  const t0 = Date.now();
  let d = 2000;
  while (!paymentIntentId && Date.now() - t0 <= 30000) {
    logger.debug("finalizing didn't produce payment intent, so checking again");
    await delay(d);
    d *= 1.3 + Math.random();
    finalizedInvoice = await stripe.invoices.retrieve(invoice.id, {
      expand: INVOICE_PAYMENT_EXPAND,
    });
    paymentIntentId = await getInvoicePaymentIntentId({
      stripe,
      invoice: finalizedInvoice,
    });
  }
  if (!paymentIntentId) {
    throw Error(
      "payment intent should have been created but wasn't, even after waiting 30s",
    );
  }

  metadata = { ...metadata, invoice_id: invoice.id };
  await recordPaymentIntent({ purpose, account_id, paymentIntentId, metadata });

  const paymentIntentUpdate = {
    description,
    metadata,
    // needed so if user pays for the first time we keep their payment method
    setup_future_usage: "off_session" as const,
  };
  if (idempotencyKeyPrefix) {
    await stripe.paymentIntents.update(paymentIntentId, paymentIntentUpdate, {
      idempotencyKey: `${idempotencyKeyPrefix}:payment-intent`,
    });
  } else {
    await stripe.paymentIntents.update(paymentIntentId, paymentIntentUpdate);
  }

  let success = false;
  if (allowedPaymentMethodTypes == null) {
    try {
      invoice = idempotencyKeyPrefix
        ? await stripe.invoices.pay(
            finalizedInvoice.id,
            {},
            { idempotencyKey: `${idempotencyKeyPrefix}:pay:default` },
          )
        : await stripe.invoices.pay(finalizedInvoice.id);
      success = true;
    } catch (err) {
      logger.debug(
        `attempt to use default payment method failed (which is fine!): ${err}`,
      );
      logger.debug(
        "instead we check for others or just let user fill something in",
      );
    }
  }

  if (!success) {
    for (const payment_method of await getPaymentMethods({
      customer,
      allowedPaymentMethodTypes,
    })) {
      const updateParams = {
        default_payment_method: payment_method,
      };
      if (idempotencyKeyPrefix) {
        await stripe.invoices.update(invoice.id, updateParams, {
          idempotencyKey: `${idempotencyKeyPrefix}:method:${payment_method}`,
        });
      } else {
        await stripe.invoices.update(invoice.id, updateParams);
      }
      try {
        invoice = idempotencyKeyPrefix
          ? await stripe.invoices.pay(
              finalizedInvoice.id,
              {},
              {
                idempotencyKey: `${idempotencyKeyPrefix}:pay:${payment_method}`,
              },
            )
          : await stripe.invoices.pay(finalizedInvoice.id);
        logger.debug("paying with another method on file worked");
        success = true;
        break;
      } catch (_err) {
        logger.debug("another attempt to use default payment method failed");
      }
    }
  }
  if (!success) {
    return invoiceWithPaymentIntent(finalizedInvoice, paymentIntentId) as any;
  }
  if (!processImmediately) {
    return invoiceWithPaymentIntent(invoice, paymentIntentId) as any;
  }
  // succeeded, so immediately check if we can process, in case of an instant
  // payment method.  otherwise, has to wait on user intervention and/or our
  // periodic polling of Stripe, or maybe a webhook.
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (isReadyToProcess(paymentIntent)) {
    try {
      await processPaymentIntent(paymentIntent);
    } catch (err) {
      await alertUncreditedSucceededPayment({
        account_id,
        err,
        paymentIntent,
        stage: "process",
      });
      throw err;
    }
  }
  return invoiceWithPaymentIntent(invoice, paymentIntentId) as any;
}

function paymentIntentIdFromValue(value): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return value?.id;
}

export function getPaymentIntentIdFromInvoice(invoice): string | undefined {
  const legacyId = paymentIntentIdFromValue(invoice?.payment_intent);
  if (legacyId) {
    return legacyId;
  }

  const payments = invoice?.payments?.data ?? [];
  const payment =
    payments.find(
      ({ is_default, payment }) =>
        is_default && payment?.type === "payment_intent",
    ) ?? payments.find(({ payment }) => payment?.type === "payment_intent");
  const paymentIntentId = paymentIntentIdFromValue(
    payment?.payment?.payment_intent,
  );
  if (paymentIntentId) {
    return paymentIntentId;
  }

  const clientSecret = invoice?.confirmation_secret?.client_secret;
  if (typeof clientSecret === "string" && clientSecret.startsWith("pi_")) {
    return clientSecret.split("_secret_")[0];
  }
}

async function getInvoicePaymentIntentId({ stripe, invoice }) {
  const paymentIntentId = getPaymentIntentIdFromInvoice(invoice);
  if (paymentIntentId) {
    return paymentIntentId;
  }

  if (!invoice?.id || !stripe.invoicePayments?.list) {
    return;
  }

  const { data } = await stripe.invoicePayments.list({
    invoice: invoice.id,
    payment: { type: "payment_intent" },
    limit: 10,
    expand: ["data.payment.payment_intent"],
  });
  return getPaymentIntentIdFromInvoice({ payments: { data } });
}

function invoiceWithPaymentIntent(invoice, paymentIntentId: string) {
  return {
    ...invoice,
    payment_intent: paymentIntentId,
  };
}

// returns first ~10 distinct payment method ids, with the default first if there
// is a default.
async function getPaymentMethods({
  customer,
  allowedPaymentMethodTypes,
}: {
  customer: string;
  allowedPaymentMethodTypes?: string[];
}): Promise<string[]> {
  const stripe = await getConn();
  const paymentMethods: string[] = [];

  const c = await stripe.customers.retrieve(customer);
  const { data } = await stripe.customers.listPaymentMethods(customer);
  const usable = data.filter(
    ({ type }) =>
      allowedPaymentMethodTypes == null ||
      allowedPaymentMethodTypes.includes(type),
  );
  const defaultId = (c as any)?.invoice_settings?.default_payment_method;
  const defaultMethod = usable.find(({ id }) => id === defaultId);
  if (defaultMethod) {
    paymentMethods.push(defaultMethod.id);
  }
  for (const { id } of usable) {
    if (!paymentMethods.includes(id)) {
      paymentMethods.push(id);
    }
  }
  return paymentMethods;
}

// This is meant to be used only by admins
export async function cancelPaymentIntent({
  id,
  reason,
}: {
  id: string;
  reason: PaymentIntentCancelReason;
}) {
  const stripe = await getConn();
  try {
    await stripe.paymentIntents.cancel(id, {
      cancellation_reason: reason as any,
    });
  } catch (err) {
    const e = `${err}`.toLowerCase();
    if (e.includes("checkout") && e.includes("session")) {
      // these cannot be canceled, ever.  so we mark metadata,
      // then filter them out.
      await stripe.paymentIntents.update(id, {
        metadata: { deleted: "true" },
      });
      return;
    }
    if (e.includes("invoice")) {
      // try voiding the invoice instead:
      const paymentIntent = await stripe.paymentIntents.retrieve(id);
      const invoiceId =
        paymentIntentIdFromValue((paymentIntent as any).invoice) ??
        paymentIntentIdFromValue(paymentIntent.metadata?.invoice_id);
      if (invoiceId?.startsWith("in_")) {
        await stripe.invoices.voidInvoice(invoiceId);
        return;
      }
    }
    // I don't know any cases that end up here.
    throw err;
  }
}

export async function getPaymentIntentAccountId(
  id: string,
): Promise<string | undefined> {
  const stripe = await getConn();
  const paymentIntent = await stripe.paymentIntents.retrieve(id);
  return paymentIntent.metadata?.account_id;
}

// When a payment intent is created we change any matching CoCalc state, which
// is critical to avoid double payments and duplicate fulfillment.
export async function recordPaymentIntent({
  purpose,
  account_id,
  paymentIntentId,
  metadata,
}) {
  logger.debug("recordPaymentIntent", {
    purpose,
    account_id,
    paymentIntentId,
    metadata,
  });
  if (purpose == SUBSCRIPTION_RENEWAL) {
    await bindSubscriptionRenewalPaymentIntent({
      account_id,
      subscription_id: parseInt(metadata.subscription_id),
      attempt_id: metadata.renewal_attempt_id,
      payment_intent_id: paymentIntentId,
      stripe_invoice_id: metadata.invoice_id,
    });
  }
}
