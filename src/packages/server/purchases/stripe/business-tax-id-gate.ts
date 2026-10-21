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
import {
  BUSINESS_TAX_ID_REQUIRED_MESSAGE,
  businessTaxIdStatus,
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
    await getPool().query(
      `INSERT INTO business_tax_id_refusals
         (id, account_id, country, path, reason, amount, created)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
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

// Throws BusinessTaxIdRequiredError, after recording it, when the customer is
// in the EU or the UK without a valid VAT ID. Returns the status otherwise.
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
    throw new BusinessTaxIdRequiredError(status);
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
