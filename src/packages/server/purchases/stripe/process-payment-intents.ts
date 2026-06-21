import getConn from "@cocalc/server/stripe/connection";
import { getStripeCustomerId, getAccountIdFromStripeCustomerId } from "./util";
import getLogger from "@cocalc/backend/logger";
import createCredit from "@cocalc/server/purchases/create-credit";
import { LineItem } from "@cocalc/util/stripe/types";
import { stripeToDecimal } from "@cocalc/util/stripe/calc";
import {
  AUTO_CREDIT,
  SUBSCRIPTION_RENEWAL,
  RESUME_SUBSCRIPTION,
  MEMBERSHIP_CHANGE,
  MEMBERSHIP_PACKAGE_PURCHASE,
  TEAM_LICENSE_CHANGE,
  TEAM_LICENSE_RENEWAL,
} from "@cocalc/util/db-schema/purchases";
import {
  processSubscriptionRenewal,
  processSubscriptionRenewalFailure,
  processResumeSubscription,
  processResumeSubscriptionFailure,
} from "./create-subscription-payment";
import { applyMembershipChange } from "../membership-change";
import send, { support, url, name } from "@cocalc/server/messages/send";
import adminAlert from "@cocalc/server/messages/admin-alert";
import {
  moneyRound2Down,
  moneyToCurrency,
  toDecimal,
} from "@cocalc/util/money";
import type { MoneyValue } from "@cocalc/util/money";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import getBalance from "@cocalc/server/purchases/get-balance";
import getPool from "@cocalc/database/pool";
import { recordPaymentIntent } from "./create-payment-intent";
import purchaseMembershipPackage, {
  purchaseMembershipPackages,
} from "@cocalc/server/purchases/membership-package";
import {
  verifyDirectStudentCourseProduct,
  verifyDirectStudentCourseProducts,
} from "@cocalc/server/purchases/direct-student-course-product";
import {
  processTeamLicenseRenewal,
  processTeamLicenseRenewalFailure,
  purchaseTeamLicenseChange,
} from "@cocalc/server/purchases/team-license";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import sendEmail from "@cocalc/server/email/send-email";
import { getUser } from "@cocalc/server/purchases/statements/email-statement";

const logger = getLogger("purchases:stripe:process-payment-intents");

function stripeCustomerId(customer): string | undefined {
  if (typeof customer === "string") {
    return customer;
  }
  return customer?.id;
}

export function assertPaymentIntentAccountBinding({
  paymentIntent,
  account_id,
  expected_customer_id,
}: {
  paymentIntent;
  account_id: string;
  expected_customer_id: string;
}) {
  const metadataAccountId = `${paymentIntent.metadata?.account_id ?? ""}`;
  if (metadataAccountId && metadataAccountId !== account_id) {
    throw Error("payment intent account metadata does not match payer");
  }
  if (stripeCustomerId(paymentIntent.customer) !== expected_customer_id) {
    throw Error("payment intent customer does not match payer");
  }
}

export function assertInvoiceAccountBinding({
  invoice,
  expected_customer_id,
}: {
  invoice;
  expected_customer_id: string;
}) {
  if (stripeCustomerId(invoice.customer) !== expected_customer_id) {
    throw Error("payment invoice customer does not match payer");
  }
}

function invoiceIdFromValue(value): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return value?.id;
}

function paymentIntentInvoiceId(paymentIntent): string | undefined {
  const invoiceId =
    invoiceIdFromValue(paymentIntent.invoice) ??
    `${paymentIntent.metadata?.invoice_id ?? ""}`.trim();
  return invoiceId || undefined;
}

function isMissingStripeInvoiceError(err): boolean {
  const message = `${err}`.toLowerCase();
  return (
    message.includes("no such invoice") ||
    ((err as any)?.code === "resource_missing" &&
      `${(err as any)?.param ?? ""}`.includes("invoice"))
  );
}

async function attachInvoicePaymentLink(paymentIntent): Promise<void> {
  if (paymentIntentInvoiceId(paymentIntent) || !paymentIntent.id) {
    return;
  }
  const stripe = await getConn();
  const { data } = await stripe.invoicePayments.list({
    payment: {
      type: "payment_intent",
      payment_intent: paymentIntent.id,
    },
    limit: 10,
  });
  const invoiceId = invoiceIdFromValue(
    (
      data.find(({ status, is_default }) => status === "paid" && is_default) ??
      data.find(({ status }) => status === "paid") ??
      data[0]
    )?.invoice,
  );
  if (!invoiceId) {
    return;
  }
  paymentIntent.invoice = invoiceId;
  paymentIntent.metadata = {
    ...(paymentIntent.metadata ?? {}),
    invoice_id: invoiceId,
  };
  try {
    await stripe.paymentIntents.update(paymentIntent.id, {
      metadata: paymentIntent.metadata,
    });
  } catch (err) {
    logger.debug(
      `WARNING: unable to persist invoice_id metadata on payment intent ${paymentIntent.id} -- ${err}`,
    );
  }
}

function getMembershipPackageProductFromMetadata(
  metadata?: Record<string, string>,
): MembershipPackageProduct {
  const value = `${metadata?.membership_package_product ?? ""}`.trim();
  if (!value) {
    throw Error("membership package purchase metadata is missing");
  }
  const product = JSON.parse(value);
  if (product?.type !== "membership-package") {
    throw Error("invalid membership package purchase metadata");
  }
  return product;
}

function getMembershipPackageProductsFromMetadata(
  metadata?: Record<string, string>,
): MembershipPackageProduct[] {
  const value = `${metadata?.membership_package_products ?? ""}`.trim();
  if (!value) {
    return [getMembershipPackageProductFromMetadata(metadata)];
  }
  const products = JSON.parse(value);
  if (!Array.isArray(products) || products.length === 0) {
    throw Error("invalid membership package purchase metadata");
  }
  for (const product of products) {
    if (product?.type !== "membership-package") {
      throw Error("invalid membership package purchase metadata");
    }
  }
  return products;
}

function getTeamLicenseTargetSeatsFromMetadata(
  metadata?: Record<string, string>,
): Record<string, number> {
  const value = `${metadata?.team_license_target_seats ?? ""}`.trim();
  if (!value) {
    throw Error("team license change metadata is missing");
  }
  const parsed = JSON.parse(value);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Error("invalid team license change metadata");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [
      key,
      Math.max(0, Math.floor(Number(value) || 0)),
    ]),
  );
}

export default async function processPaymentIntents({
  paymentIntents,
  account_id,
  checkout_session_id,
  payment_intent_id,
  strict = false,
}: {
  account_id?: string;
  checkout_session_id?: string;
  payment_intent_id?: string;
  paymentIntents?;
  strict?: boolean;
}): Promise<number> {
  const explicitPaymentIntent =
    payment_intent_id != null || checkout_session_id != null;
  if (paymentIntents == null && explicitPaymentIntent) {
    paymentIntents = await getExplicitPaymentIntents({
      account_id,
      checkout_session_id,
      payment_intent_id,
    });
  } else if (paymentIntents == null) {
    if (account_id == null) {
      // nothing to do
      return 0;
    }
    const customer = await getStripeCustomerId({ account_id, create: false });
    if (!customer) {
      return 0;
    }

    const stripe = await getConn();

    // all recent ones for this customer
    const recentPaymentIntents = await stripe.paymentIntents.list({ customer });

    // older ones that might have been missed:  this WILL miss newest from above due to time to update the stripe query index!
    // get payment intents with the new purpose metadata field set,
    // which are successful, and which have not been processed.
    // note that the index is slow to update, so we do not filter on status:"succeeded"
    // here, and instead do that in the loop below.
    const query = `customer:"${customer}" AND status:"succeeded" AND -metadata["processed"]:"true" -metadata["purpose"]:null`;
    const olderPaymentIntents = await stripe.paymentIntents.search({
      query,
      limit: 100,
    });
    paymentIntents = recentPaymentIntents.data.concat(olderPaymentIntents.data);
  }
  logger.debug(
    `processing ${paymentIntents.length} payment intents`,
    account_id != null ? `for account_id=${account_id}` : "",
  );

  const seen = new Set<string>();
  const purchase_ids = new Set<number>([]);
  for (const paymentIntent of paymentIntents) {
    if (seen.has(paymentIntent.id)) {
      continue;
    }
    seen.add(paymentIntent.id);
    await attachInvoicePaymentLink(paymentIntent);
    if (needsToBeRecorded(paymentIntent)) {
      try {
        await recordPaymentIntent({
          paymentIntentId: paymentIntent.id,
          purpose: paymentIntent.metadata.purpose,
          account_id: paymentIntent.metadata.account_id,
          metadata: paymentIntent.metadata,
        });
        await setMetadataRecorded(paymentIntent);
      } catch (err) {
        await alertUncreditedSucceededPayment({
          account_id,
          err,
          paymentIntent,
          stage: "record",
        });
        logger.debug(
          `WARNING: issue processing a payment intent ${paymentIntent.id} -- ${err}`,
        );
        if (strict) {
          throw err;
        }
      }
    }
    if (isReadyToProcess(paymentIntent)) {
      try {
        const id = await processPaymentIntent(paymentIntent);
        if (id) {
          purchase_ids.add(id);
        } else if (strict && explicitPaymentIntent) {
          throw Error(`payment intent ${paymentIntent.id} was not processed`);
        }
      } catch (err) {
        await alertUncreditedSucceededPayment({
          account_id,
          err,
          paymentIntent,
          stage: "process",
        });
        // There are a number of things that are expected to go wrong, hopefully ephemeral.  We log
        // them.  Examples:
        //   - Problem creating an item a user wants to buy because they spend too much right when
        //     the purchase is happening. Result: they have their credit and try to do the purchase
        //     again and get their thing.
        //   - The line "await stripe.invoices.retrieve(paymentIntent.invoice);" below fails, since
        //     invoice isn't actually quite created.  It will be the next time we try in a minute.
        logger.debug(
          `WARNING: issue processing a payment intent ${paymentIntent.id} -- ${err}`,
        );
        if (strict) {
          throw err;
        }
      }
    } else if (
      strict &&
      explicitPaymentIntent &&
      paymentIntent.metadata?.processed != "true"
    ) {
      throw Error(
        `payment intent ${paymentIntent.id} is not ready to process (${paymentIntentNotReadyReason(paymentIntent)})`,
      );
    }
  }
  return purchase_ids.size;
}

async function getExplicitPaymentIntents({
  account_id,
  checkout_session_id,
  payment_intent_id,
}: {
  account_id?: string;
  checkout_session_id?: string;
  payment_intent_id?: string;
}) {
  const stripe = await getConn();
  if (payment_intent_id != null) {
    const paymentIntent =
      await stripe.paymentIntents.retrieve(payment_intent_id);
    if (account_id != null) {
      const expectedCustomerId = await getStripeCustomerId({
        account_id,
        create: false,
      });
      if (!expectedCustomerId) {
        throw Error("payer does not have a Stripe customer");
      }
      assertPaymentIntentAccountBinding({
        paymentIntent,
        account_id,
        expected_customer_id: expectedCustomerId,
      });
    }
    return [paymentIntent];
  }
  if (checkout_session_id == null) {
    return [];
  }
  const session = await stripe.checkout.sessions.retrieve(checkout_session_id, {
    expand: ["payment_intent"],
  });
  if (account_id != null) {
    const expectedCustomerId = await getStripeCustomerId({
      account_id,
      create: false,
    });
    if (!expectedCustomerId) {
      throw Error("payer does not have a Stripe customer");
    }
    if (stripeCustomerId(session.customer) !== expectedCustomerId) {
      throw Error("checkout session customer does not match payer");
    }
  }
  const paymentIntent = session.payment_intent;
  if (paymentIntent == null) {
    throw Error("checkout session does not have a payment intent");
  }
  if (typeof paymentIntent === "string") {
    return [await stripe.paymentIntents.retrieve(paymentIntent)];
  }
  return [paymentIntent];
}

export async function alertUncreditedSucceededPayment({
  account_id,
  err,
  paymentIntent,
  stage,
}: {
  account_id?: string;
  err;
  paymentIntent;
  stage: "record" | "process";
}) {
  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.metadata?.processed === "true" ||
    paymentIntent.metadata?.credit_id ||
    paymentIntent.metadata?.processing_error_alerted
  ) {
    return;
  }
  try {
    const stripe = await getConn();
    const alertedAt = `${Date.now()}`;
    await stripe.paymentIntents.update(paymentIntent.id, {
      metadata: {
        ...(paymentIntent.metadata ?? {}),
        processing_error_alerted: alertedAt,
      },
    });
    paymentIntent.metadata = {
      ...(paymentIntent.metadata ?? {}),
      processing_error_alerted: alertedAt,
    };
  } catch (metadataErr) {
    logger.debug(
      `WARNING: unable to mark payment intent ${paymentIntent.id} as alerted -- ${metadataErr}`,
    );
  }
  adminAlert({
    subject: "Issue Processing a User Payment Before Credit",
    body: `CoCalc could not convert a succeeded Stripe payment into account credit.\n\n- Payment intent: ${paymentIntent.id}\n- Account id: ${account_id ?? paymentIntent.metadata?.account_id ?? "unknown"}\n- Stage: ${stage}\n- ERROR: ${err}`,
  });
}

export function isReadyToProcess(paymentIntent) {
  // Ready to process if it is in either of the FINAL states, which are
  // succeeded or canceled.  https://docs.stripe.com/payments/paymentintents/lifecycle
  return (
    (paymentIntent.status == "succeeded" ||
      paymentIntent.status == "canceled") &&
    paymentIntent.metadata["processed"] != "true" &&
    paymentIntent.metadata["purpose"] &&
    paymentIntent.metadata["total_excluding_tax_usd"] &&
    paymentIntent.metadata["deleted"] != "true"
  );
}

function paymentIntentNotReadyReason(paymentIntent): string {
  const reasons: string[] = [];
  if (
    paymentIntent.status != "succeeded" &&
    paymentIntent.status != "canceled"
  ) {
    reasons.push(`status=${paymentIntent.status}`);
  }
  if (paymentIntent.metadata?.processed == "true") {
    reasons.push("already processed");
  }
  if (!paymentIntent.metadata?.purpose) {
    reasons.push("missing purpose metadata");
  }
  if (!paymentIntent.metadata?.total_excluding_tax_usd) {
    reasons.push("missing total metadata");
  }
  if (paymentIntent.metadata?.deleted == "true") {
    reasons.push("deleted");
  }
  return reasons.join(", ") || "unknown reason";
}

// Is this a payment intent coming from a stripe checkout session that we haven't
// yet recorded its impacted?   paymentIntent.invoice being null means it's stripe
// checkout since we make our non-checkout payment intents from an invoice.
function needsToBeRecorded(paymentIntent) {
  return (
    !paymentIntent.invoice &&
    paymentIntent.metadata["purpose"] &&
    paymentIntent.metadata["recorded"] != "true" &&
    paymentIntent.metadata["deleted"] != "true"
  );
}

export function paymentSuccessSubject({
  amount,
}: {
  amount: MoneyValue;
}): string {
  return `Payment received: ${moneyToCurrency(amount)}`;
}

export function paymentSuccessBody({
  amount,
  reason,
  credit_id,
  balance,
  paymentsUrl,
  purchasesUrl,
  supportUrl,
}: {
  amount: MoneyValue;
  reason: string;
  credit_id: number;
  balance: MoneyValue;
  paymentsUrl: string;
  purchasesUrl: string;
  supportUrl: string;
}): string {
  return `Your payment of ${moneyToCurrency(amount)} was successful.


It was used to ${reason}.


Receipt details:

- Amount: ${moneyToCurrency(amount)}

- CoCalc credit id: ${credit_id}

- Account balance after payment: ${moneyToCurrency(balance)}


Account pages:

- Payments: ${paymentsUrl}

- Purchases: ${purchasesUrl}


If you have questions, reply to this message or contact support:

${supportUrl}
`;
}

function escapeHtml(value: unknown): string {
  return `${value ?? ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlLink(label: string, href: string): string {
  const safeHref = escapeHtml(href);
  return `<a href="${safeHref}" style="color:#0E2B59; text-decoration:none; font-weight:600;">${escapeHtml(label)}</a>`;
}

export function paymentSuccessHtmlBody({
  amount,
  reason,
  credit_id,
  balance,
  paymentsUrl,
  purchasesUrl,
  supportUrl,
}: {
  amount: MoneyValue;
  reason: string;
  credit_id: number;
  balance: MoneyValue;
  paymentsUrl: string;
  purchasesUrl: string;
  supportUrl: string;
}): string {
  const rowStyle =
    "padding:8px 0; border-bottom:1px solid #edf1f7; vertical-align:top;";
  const labelStyle = `${rowStyle} color:#5f6b7a; width:42%;`;
  const valueStyle = `${rowStyle} font-weight:600;`;
  return `
<div style="font-family:Verdana,Geneva,sans-serif; font-size:14px; line-height:1.65; color:#1f2937;">
  <p style="margin:0 0 18px 0;">Your payment of <strong>${escapeHtml(
    moneyToCurrency(amount),
  )}</strong> was successful.</p>

  <p style="margin:0 0 26px 0;">It was used to ${escapeHtml(reason)}.</p>

  <h2 style="font-size:18px; line-height:1.3; margin:0 0 12px 0;">Receipt details</h2>
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:100%; max-width:560px; margin:0 0 28px 0;">
    <tr>
      <td style="${labelStyle}">Amount</td>
      <td style="${valueStyle}">${escapeHtml(moneyToCurrency(amount))}</td>
    </tr>
    <tr>
      <td style="${labelStyle}">CoCalc credit id</td>
      <td style="${valueStyle}">${escapeHtml(credit_id)}</td>
    </tr>
    <tr>
      <td style="${labelStyle}">Account balance after payment</td>
      <td style="${valueStyle}">${escapeHtml(moneyToCurrency(balance))}</td>
    </tr>
  </table>

  <h2 style="font-size:18px; line-height:1.3; margin:0 0 12px 0;">Account pages</h2>
  <p style="margin:0 0 8px 0;">${htmlLink("Payments", paymentsUrl)}</p>
  <p style="margin:0 0 26px 0;">${htmlLink("Purchases", purchasesUrl)}</p>

  <p style="margin:0 0 8px 0;">If you have questions, reply to this message or contact support:</p>
  <p style="margin:0;">${htmlLink("Contact support", supportUrl)}</p>
</div>
`;
}

async function sendPaymentSuccessEmail({
  account_id,
  subject,
  text,
  html,
}: {
  account_id: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const { email_address } = await getUser(account_id);
  if (!email_address) {
    throw Error("account does not have an email address");
  }
  await sendEmail(
    {
      to: email_address,
      subject,
      text,
      html,
      categories: ["payment-receipt"],
    },
    account_id,
    "transactional",
  );
}

async function setMetadataRecorded(paymentIntent) {
  const stripe = await getConn();
  paymentIntent.metadata.recorded = "true";
  await stripe.paymentIntents.update(paymentIntent.id, {
    metadata: paymentIntent.metadata,
  });
}

// NOT a critical assumption.  We do NOT assume processPaymentIntent is never run twice at
// the same time for the same payment, either in the same process or on the cluster.
// If $n$ attempts to run this happen at once, the createCredit call will succeed for
// one of them and fail for all others due to the unique index on the invoice_id field.
// The credit thus gets created at most once, and no items are created except by the
// thread that created the credit.

// reuseInFlight since this function is called pretty aggressively, and we want to avoid calling it twice
// on the same input at the same time.  That doesn't result in a double transaction, but sends multiple
// messages out to the user, which is confusing.
export const processPaymentIntent = reuseInFlight(
  async (paymentIntent): Promise<number | undefined> => {
    paymentIntent.metadata ??= {};
    if (paymentIntent.metadata.processed == "true") {
      // already done.
      return;
    }
    const stripe = await getConn();
    let invoice;
    const getInvoice = async () => {
      const invoiceId = paymentIntentInvoiceId(paymentIntent);
      if (invoice == null && invoiceId) {
        try {
          invoice = await stripe.invoices.retrieve(invoiceId);
        } catch (err) {
          if (!isMissingStripeInvoiceError(err)) {
            throw err;
          }
          logger.debug(
            `WARNING: unable to retrieve optional invoice ${invoiceId} for payment intent ${paymentIntent.id} -- ${err}`,
          );
        }
      }
      return invoice;
    };
    if (
      !paymentIntent.metadata?.account_id ||
      !paymentIntent.metadata?.purpose ||
      !paymentIntent.metadata?.total_excluding_tax_usd
    ) {
      invoice = await getInvoice();
      if (invoice?.metadata != null) {
        paymentIntent.metadata = {
          ...invoice.metadata,
          ...paymentIntent.metadata,
        };
      }
    }
    let account_id = paymentIntent.metadata.account_id;
    logger.debug("processPaymentIntent", { id: paymentIntent.id, account_id });
    const paymentIntentCustomerId = stripeCustomerId(paymentIntent.customer);
    let expectedCustomerId = paymentIntentCustomerId;
    if (!account_id) {
      // this should never happen, but in case it does, we lookup the account_id
      // in our database, based on the customer id.
      if (!paymentIntentCustomerId) {
        logger.debug("processPaymentIntent: missing stripe customer", {
          payment_intent_id: paymentIntent.id,
        });
        return;
      }
      account_id = await getAccountIdFromStripeCustomerId(
        paymentIntentCustomerId,
      );
      if (!account_id) {
        // no possible way to process this.
        // This will happen in *test mode* since I use the exact same test credentials with
        // many unrelated cocalc dev servers and they might all try to process the same payments.
        logger.debug(
          "processPaymentIntent: unknown stripe customer",
          paymentIntent.customer,
        );
        adminAlert({
          subject: `Broken payment intent ${paymentIntent.id} that can't be processed - please investigate`,
          body: `
CoCalc was processing the payment intent with id ${paymentIntent.id}, but the metadata didn't have an
account_id set (which should impossible) AND the customer for the paymentIntent isn't a known stripe
customer.  So we don't know what to do with this.  Please manually investigate.
`,
        });
        return;
      }
    }

    expectedCustomerId = await getStripeCustomerId({
      account_id,
      create: false,
    });
    if (!expectedCustomerId) {
      throw Error("payer does not have a Stripe customer");
    }
    assertPaymentIntentAccountBinding({
      paymentIntent,
      account_id,
      expected_customer_id: expectedCustomerId,
    });

    // IMPORTANT: There is just no way in general to know directly from the payment intent
    // and invoice exactly what we were trying to charge the customer!  The problem is that
    // the invoice (and line items) in some cases (e.g., stripe checkout) is in a non-US currency.
    // We thus set the metadata to have the total in **US PENNIES** (!). Users can't touch
    // this metadata, and we depend on it for how much the invoice is worth to us.
    const total_excluding_tax_usd =
      paymentIntent.metadata.total_excluding_tax_usd;
    if (total_excluding_tax_usd == null) {
      // cannot be processed further.
      return;
    }
    const amount = stripeToDecimal(parseInt(total_excluding_tax_usd));

    if (paymentIntent.status == "canceled") {
      // This is a payment intent that has definitely failed
      // forever.  In some cases, we also want to do some
      // processing.

      paymentIntent.metadata.processed = "true";
      await stripe.paymentIntents.update(paymentIntent.id, {
        metadata: paymentIntent.metadata,
      });

      let result = "we did NOT add credit to your account";
      try {
        if (paymentIntent.metadata.purpose == SUBSCRIPTION_RENEWAL) {
          result = `we did NOT renew subscription (id=${paymentIntent.metadata.subscription_id})`;
          await processSubscriptionRenewalFailure({
            account_id,
            paymentIntent,
          });
        } else if (paymentIntent.metadata.purpose == RESUME_SUBSCRIPTION) {
          result = `we did NOT resume subscription (id=${paymentIntent.metadata.subscription_id})`;
          await processResumeSubscriptionFailure({
            account_id,
            paymentIntent,
          });
        } else if (paymentIntent.metadata.purpose == MEMBERSHIP_CHANGE) {
          result = `the membership change to ${paymentIntent.metadata.membership_class} was not applied`;
        } else if (
          paymentIntent.metadata.purpose == MEMBERSHIP_PACKAGE_PURCHASE
        ) {
          result = "the membership package purchase was not completed";
        } else if (paymentIntent.metadata.purpose == TEAM_LICENSE_CHANGE) {
          result = "the team license change was not completed";
        } else if (paymentIntent.metadata.purpose == TEAM_LICENSE_RENEWAL) {
          result = "the team license renewal was not completed";
          await processTeamLicenseRenewalFailure({
            account_id,
            paymentIntent,
          });
        } else if (paymentIntent.metadata.purpose?.startsWith("statement-")) {
          const statement_id = parseInt(
            paymentIntent.metadata.purpose.split("-")[1],
          );
          result = `your monthly statement (id=${statement_id}) is not paid for and you may still owe money`;
        }
        send({
          to_ids: [account_id],
          subject: `Canceled ${moneyToCurrency(amount)} Payment`,
          body: `A payment of ${moneyToCurrency(amount)} was canceled, and as a result ${result}.
- Payment id: ${paymentIntent.id}

- Your payments: ${await url("settings", "payments")}

- Account Balance: ${moneyToCurrency(
            moneyRound2Down(toDecimal(await getBalance({ account_id }))),
          )}

${await support()}`,
        });
        const n = await name(account_id);
        adminAlert({
          subject: `User's Payment (paymentIntent = ${paymentIntent.id}) was canceled`,
          body: `
The user ${await name(account_id)} with account_id=${account_id} had a canceled payment intent. We told them
the consequence is "${result}".  Admins might want to investigate.

- User: ${n}, account_id=${account_id}


`,
        });
      } catch (err) {
        // There basically should never be a case where any of the above fails... but reality.
        // So communicate this.
        const body = `You canceled a payment of ${moneyToCurrency(amount)}, so ${result}.  However, cleaning up this resulted in an error.  You may need to contact support.

- Account Balance: ${moneyToCurrency(
          moneyRound2Down(toDecimal(await getBalance({ account_id }))),
        )}

- ERROR: ${err}

${await support()}`;
        send({
          to_ids: [account_id],
          subject: `Possible Issue Processing Canceled ${moneyToCurrency(amount)} Payment`,
          body,
        });
        adminAlert({
          subject: "Issue Processing a Canceled Payment",
          body: `There was an error processing the cancelation of a payment intent with id ${paymentIntent.id} for the user with account_id=${account_id}.  An admin might want to look into this, since this sort of error should never happen.

## Message sent to user: ${body}`,
        });
        throw err;
      }

      return;
    }

    invoice = await getInvoice();
    if (invoice != null) {
      assertInvoiceAccountBinding({
        invoice,
        expected_customer_id: expectedCustomerId,
      });
    }

    // credit the account.  If the account was already credited for this (e.g.,
    // by another process doing this at the same time), that should be detected
    // and is a no-op, due to the invoice_id being unique amount purchases records
    // for this account (MAKE SURE!).
    const credit_id = await createCredit({
      account_id,
      invoice_id: paymentIntent.id,
      amount,
      description: {
        line_items: getInvoiceLineItems(invoice),
        description: paymentIntent.description,
        purpose: paymentIntent.metadata.purpose,
      },
      service:
        paymentIntent.metadata.purpose == AUTO_CREDIT
          ? "auto-credit"
          : "credit",
    });

    // Keep the credit id on the in-memory payment intent, but only mark the
    // payment intent processed after the intended product change succeeds.
    // createCredit is idempotent by invoice_id, so failed product processing
    // can safely be retried without creating duplicate account credit.
    paymentIntent.metadata.credit_id = credit_id;

    let reason = "add credit to your account";
    try {
      if (paymentIntent.metadata.purpose == SUBSCRIPTION_RENEWAL) {
        reason = `renew a subscription (id=${paymentIntent.metadata.subscription_id})`;
        await processSubscriptionRenewal({ account_id, paymentIntent, amount });
      } else if (paymentIntent.metadata.purpose == RESUME_SUBSCRIPTION) {
        reason = `resume a subscription (id=${paymentIntent.metadata.subscription_id})`;
        await processResumeSubscription({ account_id, paymentIntent, amount });
      } else if (paymentIntent.metadata.purpose == MEMBERSHIP_CHANGE) {
        reason = `change membership to ${paymentIntent.metadata.membership_class}`;
        await applyMembershipChange({
          account_id,
          targetClass: paymentIntent.metadata.membership_class,
          interval: paymentIntent.metadata.membership_interval as
            | "month"
            | "year",
          allowDowngrade: paymentIntent.metadata.allow_downgrade === "true",
          storeVisibleOnly: true,
          paymentAmount: amount,
        });
      } else if (
        paymentIntent.metadata.purpose == MEMBERSHIP_PACKAGE_PURCHASE
      ) {
        const products = getMembershipPackageProductsFromMetadata(
          paymentIntent.metadata,
        );
        if (products.length === 1) {
          const product = await verifyDirectStudentCourseProduct({
            account_id,
            product: products[0],
          });
          reason =
            product.package_id != null
              ? `expand membership package ${product.package_id}`
              : `purchase a ${product.kind} membership package`;
          await purchaseMembershipPackage({
            account_id,
            fulfillment_id: paymentIntent.id,
            product,
            amount,
          });
        } else {
          const verifiedProducts = await verifyDirectStudentCourseProducts({
            account_id,
            products,
          });
          reason = `purchase ${verifiedProducts.length} membership package changes`;
          await purchaseMembershipPackages({
            account_id,
            fulfillment_id: paymentIntent.id,
            products: verifiedProducts,
            amount,
          });
        }
      } else if (paymentIntent.metadata.purpose == TEAM_LICENSE_CHANGE) {
        reason = "change your team license";
        await purchaseTeamLicenseChange({
          account_id,
          target_seats: getTeamLicenseTargetSeatsFromMetadata(
            paymentIntent.metadata,
          ),
          amount,
        });
      } else if (paymentIntent.metadata.purpose == TEAM_LICENSE_RENEWAL) {
        reason = `renew team license ${paymentIntent.metadata.team_license_id}`;
        await processTeamLicenseRenewal({ account_id, paymentIntent, amount });
      } else if (paymentIntent.metadata.purpose?.startsWith("statement-")) {
        const statement_id = parseInt(
          paymentIntent.metadata.purpose.split("-")[1],
        );
        reason = `pay balance on monthly statement (id=${statement_id})`;
        await markStatementPaidByPurchase({
          account_id,
          statement_id,
          credit_id,
          amount,
        });
      }
    } catch (err) {
      // There basically should never be a case where any of the above fails.  But multiple
      // transactions happening at once, or bugs, etc. could maybe lead to a case where
      // cocalc refuses to fully process the transaction.  Communicate this.
      const body = `
You made a payment of ${moneyToCurrency(amount)}, which has been successfully processed by our
payment processor, and a credit of ${moneyToCurrency(amount)} has been added to your
account (purchase id=${credit_id}).   You made this payment to ${reason}, but something
went wrong.

Please retry that purchase instead using the credit that is now on your account, or contact
support if you are concerned (see below).

- Account Balance: ${moneyToCurrency(
        moneyRound2Down(toDecimal(await getBalance({ account_id }))),
      )}

- Your payments: ${await url("settings", "payments")}

- ERROR: ${err}

${await support()}
`;
      try {
        await send({
          to_ids: [account_id],
          subject: `Possible Issue Processing ${moneyToCurrency(amount)} Payment`,
          body,
        });
      } catch (messageErr) {
        logger.debug(
          `WARNING: unable to send payment processing issue notification for ${paymentIntent.id} -- ${messageErr}`,
        );
      }
      adminAlert({
        subject: "Issue Processing a User Payment",
        body: `There was an error processing payment intent id ${paymentIntent.id} for the user with account_id=${account_id}.\n\n## Message sent to user:\n\n${body}`,
      });
      throw err;
    }

    // make metadata so we won't consider this payment intent ever again
    // NOTE: we are mutating this on purpose so that the paymentIntent
    // that gets returned, e.g., by getPayments is already up to date with the credit_id!
    paymentIntent.metadata.processed = "true";
    await stripe.paymentIntents.update(paymentIntent.id, {
      metadata: paymentIntent.metadata,
    });

    try {
      const receipt = {
        amount,
        reason,
        credit_id,
        balance: moneyRound2Down(toDecimal(await getBalance({ account_id }))),
        paymentsUrl: await url("settings", "payments"),
        purchasesUrl: await url("settings", "purchases"),
        supportUrl: await url("support", "new"),
      };
      await sendPaymentSuccessEmail({
        account_id,
        subject: paymentSuccessSubject({ amount }),
        text: paymentSuccessBody(receipt),
        html: paymentSuccessHtmlBody(receipt),
      });
    } catch (err) {
      logger.debug(
        `WARNING: unable to send payment success notification for ${paymentIntent.id} -- ${err}`,
      );
      adminAlert({
        subject: "Issue Sending Payment Success Message",
        body: `There was an error sending the success message for payment intent id ${paymentIntent.id} for the user with account_id=${account_id}.\n\nERROR: ${err}`,
      });
    }

    return credit_id;
  },
);

export async function markStatementPaidByPurchase({
  account_id,
  statement_id,
  credit_id,
  amount,
}: {
  account_id: string;
  statement_id: number;
  credit_id: number;
  amount: MoneyValue;
}) {
  if (!Number.isInteger(statement_id)) {
    throw Error("invalid statement id");
  }
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT balance, paid_purchase_id FROM statements WHERE id=$1 AND account_id=$2",
    [statement_id, account_id],
  );
  if (rows.length == 0) {
    throw Error("statement does not belong to this account");
  }

  const { balance, paid_purchase_id } = rows[0];
  if (paid_purchase_id != null) {
    if (paid_purchase_id == credit_id) {
      return;
    }
    throw Error("statement is already paid");
  }
  const amountDue = toDecimal(balance).neg();
  if (amountDue.lte(0)) {
    throw Error("statement does not require payment");
  }
  if (toDecimal(amount).lt(amountDue)) {
    throw Error(
      `payment amount ${moneyToCurrency(amount)} is less than statement amount due ${moneyToCurrency(amountDue)}`,
    );
  }

  const result = await pool.query(
    "UPDATE statements SET paid_purchase_id=$1 WHERE id=$2 AND account_id=$3 AND paid_purchase_id IS NULL",
    [credit_id, statement_id, account_id],
  );
  if (result.rowCount != 1) {
    throw Error("unable to mark statement paid");
  }
}

// This allows for a periodic check that we have processed all recent payment
// intents across all users.  It should be called periodically.
// This should be called periodically as a maintenance task.
export async function processAllRecentPaymentIntents(): Promise<number> {
  const stripe = await getConn();

  // payments that might have been missed. This might miss something from up to 1-2 minutes ago
  // due to time to update the index, but that is fine given the point of this function.
  // We also use a small limit, since in almost all cases this will be empty, and if it is
  // not empty, we would just call it again to get more results.
  const query = `status:"succeeded" AND -metadata["processed"]:"true" AND -metadata["purpose"]:null`;
  const paymentIntents = await stripe.paymentIntents.search({
    query,
    limit: 10,
  });
  logger.debug(
    `processAllRecentPaymentIntents: considering ${paymentIntents.data.length} payments...`,
  );
  const purchase_ids = new Set<number>([]);
  for (const paymentIntent of paymentIntents.data) {
    if (isReadyToProcess(paymentIntent)) {
      const id = await processPaymentIntent(paymentIntent);
      if (id) {
        purchase_ids.add(id);
      }
    }
  }
  return purchase_ids.size;
}

export async function maintainPaymentIntents() {
  logger.debug("maintainPaymentIntents");
  // Right now we just call this. We could put in a longer interval between
  // calls (i.e. refuse to call too frequently if necessary).  Right now
  // this gets called every 5 minutes, which seems fine.
  await processAllRecentPaymentIntents();
}

function getInvoiceLineItems(invoice): LineItem[] {
  const data = invoice?.lines?.data;
  if (data == null) {
    return [];
  }
  const v: LineItem[] = data.map(({ description, amount }) => {
    return { description: description ?? "", amount: stripeToDecimal(amount) };
  });
  if (invoice.tax) {
    v.push({
      description: "Tax",
      amount: stripeToDecimal(invoice.tax),
      tax: true,
    });
  }
  return v;
}
