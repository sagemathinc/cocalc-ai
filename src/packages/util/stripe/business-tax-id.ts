/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
SageMath, Inc. sells to organizations only in the EU and the UK: VAT on digital
services sold there to individuals applies from the first euro or pound, while
a sale to a business with a valid VAT number is reverse charged. Every Stripe
purchase from a customer whose billing country is in the EU or the UK must
therefore carry a valid VAT ID.

Northern Ireland addresses have country GB in Stripe (XI is only a VAT number
prefix), so GB covers them.
*/

export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

export const BUSINESS_TAX_ID_REQUIRED_MESSAGE =
  "For customers in the EU and UK, CoCalc sells only to organizations with a VAT number. Please add your organization's VAT number, or ask your institution to purchase.";

function normalizeCountry(country: unknown): string {
  return `${country ?? ""}`.trim().toUpperCase();
}

export function requiresBusinessTaxId(country: unknown): boolean {
  const c = normalizeCountry(country);
  return c === "GB" || EU_COUNTRIES.has(c);
}

// The Stripe tax ID type a customer in this country needs, if any.
export function businessTaxIdType(
  country: unknown,
): "eu_vat" | "gb_vat" | undefined {
  const c = normalizeCountry(country);
  if (c === "GB") return "gb_vat";
  if (EU_COUNTRIES.has(c)) return "eu_vat";
  return undefined;
}

// The fields of a Stripe customer tax ID this check reads.
export interface StripeTaxIdLike {
  type?: string | null;
  value?: string | null;
  verification?: { status?: string | null } | null;
}

export interface StripeCustomerLike {
  address?: { country?: string | null } | null;
  tax_ids?: { data?: StripeTaxIdLike[] | null } | StripeTaxIdLike[] | null;
}

export type BusinessTaxIdStatus =
  // The billing country does not need a VAT ID (including unknown country).
  | { required: false; country: string }
  // A VAT ID that Stripe verified, or has not finished verifying.
  | {
      required: true;
      ok: true;
      country: string;
      verification: "verified" | "pending" | "unavailable";
    }
  | {
      required: true;
      ok: false;
      country: string;
      reason: "missing" | "unverified";
    };

function customerTaxIds(customer: StripeCustomerLike): StripeTaxIdLike[] {
  const ids = customer.tax_ids;
  if (Array.isArray(ids)) return ids;
  return ids?.data ?? [];
}

// Stripe verification statuses: verified, pending, unavailable (the
// VIES/HMRC service could not be reached) and unverified. Pending and
// unavailable are accepted, since Stripe has not decided yet; callers log them.
const ACCEPTED: ReadonlyArray<"verified" | "pending" | "unavailable"> = [
  "verified",
  "pending",
  "unavailable",
];

export function businessTaxIdStatus(
  customer: StripeCustomerLike | null | undefined,
): BusinessTaxIdStatus {
  const country = normalizeCountry(customer?.address?.country);
  const type = businessTaxIdType(country);
  if (type == null) {
    return { required: false, country };
  }
  const matching = customerTaxIds(customer ?? {}).filter(
    (id) => id?.type === type && `${id.value ?? ""}`.trim(),
  );
  if (matching.length === 0) {
    return { required: true, ok: false, country, reason: "missing" };
  }
  for (const accepted of ACCEPTED) {
    if (matching.some((id) => id.verification?.status === accepted)) {
      return { required: true, ok: true, country, verification: accepted };
    }
  }
  return { required: true, ok: false, country, reason: "unverified" };
}

export const BILLING_ADDRESS_REQUIRED_MESSAGE =
  "Please enter your billing name and address before checkout.";

// Whether a customer without a saved billing address must enter one before
// checkout, given the country Cloudflare reports for the request: yes in the
// EU and UK, and when the location is unknown (XX), Tor (T1) or missing.
export function billingAddressRequiredBeforeCheckout(
  requestCountry: unknown,
): boolean {
  const c = normalizeCountry(requestCountry);
  if (!/^[A-Z]{2}$/.test(c) || c === "XX" || c === "T1") return true;
  return requiresBusinessTaxId(c);
}
