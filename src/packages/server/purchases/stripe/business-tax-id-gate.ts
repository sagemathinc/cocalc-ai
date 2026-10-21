/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The server side of "EU and UK purchases need a VAT ID"
(util/stripe/business-tax-id.ts): every path that takes money through Stripe
checks the customer before charging, refuses an EU or UK customer without a
valid VAT ID, and records the refusal so lost sales can be counted.
*/

import { v4 as uuid } from "uuid";

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import send, { name, support } from "@cocalc/server/messages/send";
import {
  ADMIN_MEMBERSHIP_PACKAGE_PURCHASE,
  AUTO_CREDIT,
  SUBSCRIPTION_RENEWAL,
  TEAM_LICENSE_RENEWAL,
} from "@cocalc/util/db-schema/purchases";
import {
  BUSINESS_TAX_ID_REQUIRED_MESSAGE,
  businessTaxIdStatus,
  requiresBusinessTaxId,
  type BusinessTaxIdStatus,
  type StripeCustomerLike,
} from "@cocalc/util/stripe/business-tax-id";

const logger = getLogger("purchases:stripe:business-tax-id-gate");

export const BUSINESS_TAX_ID_REQUIRED = "business_tax_id_required";

export class BusinessTaxIdRequiredError extends Error {
  code = BUSINESS_TAX_ID_REQUIRED;
  constructor(public status: BusinessTaxIdStatus) {
    super(BUSINESS_TAX_ID_REQUIRED_MESSAGE);
  }
}

export function isBusinessTaxIdRequiredError(err: unknown): boolean {
  return (err as any)?.code === BUSINESS_TAX_ID_REQUIRED;
}

// The customer with its tax IDs, which Stripe returns only when expanded.
export async function retrieveCustomerWithTaxIds(
  stripe,
  customer: string,
): Promise<StripeCustomerLike> {
  const result = await stripe.customers.retrieve(customer, {
    expand: ["tax_ids"],
  });
  if (result?.deleted) {
    return {};
  }
  return result;
}

// Payments CoCalc starts without the customer present.
export function isOffSessionPurpose(purpose: string): boolean {
  return (
    purpose === AUTO_CREDIT ||
    purpose === SUBSCRIPTION_RENEWAL ||
    purpose === TEAM_LICENSE_RENEWAL ||
    purpose.startsWith("statement-")
  );
}

// An admin decided the sale is institutional (William, Oct 21, 2026).
export function isBusinessTaxIdExemptPurpose(purpose: string): boolean {
  return purpose === ADMIN_MEMBERSHIP_PACKAGE_PURCHASE;
}

const OFF_SESSION_NOTICE_DAYS = 7;

export async function recordBusinessTaxIdRefusal({
  account_id,
  country,
  path,
  reason,
  amount,
}: {
  account_id: string;
  country: string;
  path: string;
  reason: string;
  amount?: number | string | null;
}): Promise<void> {
  logger.warn("refused a purchase without a valid VAT ID", {
    account_id,
    country,
    path,
    reason,
    amount,
  });
  try {
    // A retried automatic payment is one lost sale, not one per attempt.
    await getPool().query(
      `INSERT INTO business_tax_id_refusals
         (id, account_id, country, path, reason, amount, created)
       SELECT $1, $2, $3, $4, $5, $6, NOW()
        WHERE NOT EXISTS (
          SELECT 1 FROM business_tax_id_refusals
           WHERE account_id = $2 AND path = $4
             AND created > NOW() - INTERVAL '1 day')`,
      [
        uuid(),
        account_id,
        country.slice(0, 2),
        path.slice(0, 64),
        reason.slice(0, 32),
        amount == null || amount === "" ? null : `${amount}`,
      ],
    );
  } catch (err) {
    // Counting lost sales must never turn a refusal into a different error.
    logger.warn("could not record a business tax ID refusal", { err });
  }
}

// The message for a customer whose automatic payment was refused, at most
// once a week.
async function sendOffSessionRefusalNotice(account_id: string): Promise<void> {
  try {
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM business_tax_id_refusals
        WHERE account_id = $1 AND created > NOW() - $2::interval`,
      [account_id, `${OFF_SESSION_NOTICE_DAYS} days`],
    );
    // The refusal just recorded is the first one in the period.
    if ((rows[0]?.n ?? 0) > 1) return;
    await send({
      to_ids: [account_id],
      subject: "CoCalc: automatic payment not made (EU and UK customers)",
      body: `
Dear ${await name(account_id)},

CoCalc no longer sells to individuals in the EU and the UK, so we did not make
your automatic payment. Anything you have already paid for keeps working until
it runs out.

To keep using a paid membership, please ask your university or organization to
purchase it (we work with institutions by invoice or purchase order). An
organization can also add its VAT number under Settings, then Payment Methods,
then Name and Address. Alternatively, you can host CoCalc yourself.

${await support()}
`,
    });
  } catch (err) {
    logger.warn("could not send the off-session refusal notice", { err });
  }
}

// The card countries of a customer's saved cards.
async function cardCountries(stripe, customer: string): Promise<string[]> {
  try {
    const { data } = await stripe.customers.listPaymentMethods(customer, {
      type: "card",
      limit: 10,
    });
    return (data ?? [])
      .map((pm) => `${pm?.card?.country ?? ""}`.toUpperCase())
      .filter(Boolean);
  } catch (err) {
    logger.warn("could not list payment methods for the VAT check", { err });
    return [];
  }
}

// Throws BusinessTaxIdRequiredError, after recording it, when the customer is
// in the EU or the UK without a valid VAT ID. Returns the status otherwise.
// For an automatic payment from a customer with no billing address, an EU or
// UK card counts as an EU or UK customer (William, Oct 21, 2026).
export async function assertBusinessTaxIdForPurchase({
  stripe,
  customer,
  account_id,
  path,
  amount,
}: {
  stripe;
  customer: string;
  account_id: string;
  // Where the purchase happens, e.g. "checkout" or the payment purpose.
  path: string;
  amount?: number | string | null;
}): Promise<BusinessTaxIdStatus> {
  if (isBusinessTaxIdExemptPurpose(path)) {
    return { required: false, country: "" };
  }
  const offSession = isOffSessionPurpose(path);
  const status = businessTaxIdStatus(
    await retrieveCustomerWithTaxIds(stripe, customer),
  );
  if (status.required && !status.ok) {
    await recordBusinessTaxIdRefusal({
      account_id,
      country: status.country,
      path,
      reason: status.reason,
      amount,
    });
    if (offSession) await sendOffSessionRefusalNotice(account_id);
    throw new BusinessTaxIdRequiredError(status);
  }
  if (!status.required && !status.country && offSession) {
    const card = (await cardCountries(stripe, customer)).find((c) =>
      requiresBusinessTaxId(c),
    );
    if (card) {
      const refused: BusinessTaxIdStatus = {
        required: true,
        ok: false,
        country: card,
        reason: "missing",
      };
      await recordBusinessTaxIdRefusal({
        account_id,
        country: card,
        path,
        reason: "card-country",
        amount,
      });
      await sendOffSessionRefusalNotice(account_id);
      throw new BusinessTaxIdRequiredError(refused);
    }
  }
  if (status.required && status.ok && status.verification !== "verified") {
    logger.warn("accepting a VAT ID that Stripe has not verified yet", {
      account_id,
      country: status.country,
      path,
      verification: status.verification,
    });
  }
  return status;
}
