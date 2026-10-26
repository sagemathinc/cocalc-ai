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
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
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

export const OFF_SESSION_NOTICE_DAYS = 7;

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
    // A retried automatic payment is one lost sale a day, not one per attempt
    // (unique index on account_id, path, refusal_day).
    await getPool().query(
      `INSERT INTO business_tax_id_refusals
         (id, account_id, country, path, reason, amount, created, refusal_day)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), (NOW() AT TIME ZONE 'UTC')::date)
       ON CONFLICT (account_id, path, refusal_day) DO NOTHING`,
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

const OFF_SESSION_NOTICE = {
  title: "Automatic payment not made: EU and UK customers",
  body_markdown: `CoCalc no longer sells to individuals in the EU and the UK, so your automatic payment was not made. Anything you have already paid for keeps working until it runs out.

To keep a paid membership, please ask your university or organization to purchase it (we work with institutions by invoice or purchase order). An organization can also add its VAT number under Settings, then Payment Methods, then Name and Address. Alternatively, you can host CoCalc yourself.`,
  severity: "warning",
  origin_label: "Billing",
  notice_type: "business_tax_id_required",
};

// Tells a customer that an automatic payment was refused, at most once every
// OFF_SESSION_NOTICE_DAYS: the claim in business_tax_id_notices and the
// account notice (delivered to the account's home bay) commit together, so
// concurrent refusals send exactly one notice.
export async function sendOffSessionRefusalNotice(
  account_id: string,
): Promise<boolean> {
  try {
    const home = await getClusterAccountById(account_id);
    if (home == null) {
      logger.warn("no account for the off-session refusal notice", {
        account_id,
      });
      return false;
    }
    const home_bay_id =
      `${home.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO business_tax_id_notices (account_id, notified_at)
         VALUES ($1, NOW())
         ON CONFLICT (account_id) DO UPDATE SET notified_at = NOW()
          WHERE business_tax_id_notices.notified_at
                < NOW() - make_interval(days => $2)
         RETURNING account_id`,
        [account_id, OFF_SESSION_NOTICE_DAYS],
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        return false;
      }
      await createNotificationEventGraphInTransaction({
        db: client,
        input: {
          kind: "account_notice",
          source_bay_id: getConfiguredBayId(),
          origin_kind: "system",
          payload_json: OFF_SESSION_NOTICE,
          targets: [
            {
              target_account_id: account_id,
              target_home_bay_id: home_bay_id,
              dedupe_key: `business-tax-id-required:${account_id}`,
              summary_json: OFF_SESSION_NOTICE,
            },
          ],
        },
      });
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.warn("could not send the off-session refusal notice", {
      account_id,
      err,
    });
    return false;
  }
}

// The renewal worker tells the customer about a refused membership renewal
// itself, naming the subscription and the date it is canceled
// (subscription-renewal-worker.ts), so the generic notice is not sent for it.
function sendsGenericNotice(path: string): boolean {
  return isOffSessionPurpose(path) && path !== SUBSCRIPTION_RENEWAL;
}

function cardCountry(card): string {
  return `${card?.country ?? ""}`.trim().toUpperCase();
}

// The countries of every card Stripe could charge for this customer: the
// default payment method, all saved card payment methods (every page) and
// legacy card sources, including the default source. Throws if any of it
// cannot be read, so the caller fails closed.
export async function chargeableCardCountries(
  stripe,
  customer: string,
): Promise<string[]> {
  const countries = new Set<string>();
  const add = (country: string) => country && countries.add(country);
  const c = await stripe.customers.retrieve(customer, {
    expand: ["sources", "invoice_settings.default_payment_method"],
  });
  if (c?.deleted) return [];
  add(cardCountry(c?.invoice_settings?.default_payment_method?.card));

  // Saved payment methods, every page.
  let starting_after: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 100) throw Error("too many payment methods to check");
    const list = await stripe.customers.listPaymentMethods(customer, {
      type: "card",
      limit: 100,
      ...(starting_after ? { starting_after } : {}),
    });
    const data = list?.data ?? [];
    for (const pm of data) add(cardCountry(pm?.card));
    if (!list?.has_more || data.length === 0) break;
    starting_after = data[data.length - 1].id;
  }

  // Legacy sources: cards have country on the card object (object "card") or
  // under .card (object "source").
  const legacy = (source) =>
    add(cardCountry(source?.object === "card" ? source : source?.card));
  const sources = c?.sources?.data ?? [];
  for (const source of sources) legacy(source);
  let sourcesAfter = c?.sources?.has_more
    ? sources[sources.length - 1]?.id
    : undefined;
  for (let page = 0; sourcesAfter; page++) {
    if (page >= 100) throw Error("too many payment sources to check");
    const list = await stripe.customers.listSources(customer, {
      limit: 100,
      starting_after: sourcesAfter,
    });
    const data = list?.data ?? [];
    for (const source of data) legacy(source);
    sourcesAfter = list?.has_more ? data[data.length - 1]?.id : undefined;
  }
  const defaultSource = c?.default_source;
  if (typeof defaultSource === "string" && defaultSource) {
    if (!sources.some((source) => source?.id === defaultSource)) {
      legacy(await stripe.customers.retrieveSource(customer, defaultSource));
    }
  } else if (defaultSource && typeof defaultSource === "object") {
    legacy(defaultSource);
  }
  return Array.from(countries);
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
    if (sendsGenericNotice(path)) await sendOffSessionRefusalNotice(account_id);
    throw new BusinessTaxIdRequiredError(status);
  }
  if (!status.required && !status.country && offSession) {
    let countries: string[];
    try {
      countries = await chargeableCardCountries(stripe, customer);
    } catch (err) {
      // Fail closed: without knowing where the card is from, do not charge.
      logger.warn("could not check card countries for the VAT check", {
        account_id,
        err,
      });
      throw Error(
        "CoCalc could not check this payment method, so the automatic payment was not made. It will be retried later.",
      );
    }
    const card = countries.find((c) => requiresBusinessTaxId(c));
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
      if (sendsGenericNotice(path))
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
