/*
Stripe Customer information.  This called "customer" because that is waht stripe calls it.

It's the stripe name, address and email for now, but later could support updating tax id, etc.
*/

import getConn from "@cocalc/server/stripe/connection";
import { getStripeCustomerId } from "./util";
import getName from "@cocalc/server/accounts/get-name";
import { businessTaxIdType } from "@cocalc/util/stripe/business-tax-id";

const VAT_ID_TYPES = new Set(["eu_vat", "gb_vat"]);

function normalizeVatId(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, "").toUpperCase();
}

// The customer's EU or UK VAT ID (the first, if there are several).
export function customerVatId(
  customer,
): { value: string; type: string; status: string | null } | null {
  const ids = customer?.tax_ids?.data ?? [];
  const id = ids.find((x) => VAT_ID_TYPES.has(x?.type));
  return id == null
    ? null
    : {
        value: id.value,
        type: id.type,
        status: id.verification?.status ?? null,
      };
}

// Sets (or, with an empty value, removes) the customer's EU or UK VAT ID.
// The type follows the billing country, so Stripe verifies it with VIES or
// HMRC.
async function setCustomerVatId({
  stripe,
  customer_id,
  vat_id,
  country,
}: {
  stripe;
  customer_id: string;
  vat_id: string | null;
  country: string | undefined;
}): Promise<void> {
  const value = normalizeVatId(vat_id);
  if (value.length > 32 || !/^[A-Z0-9.-]*$/.test(value)) {
    throw Error("invalid VAT number");
  }
  const type = businessTaxIdType(country);
  if (value && type == null) {
    throw Error(
      "A VAT number can only be added for a billing address in the EU or the UK.",
    );
  }
  const existing = (
    await stripe.customers.listTaxIds(customer_id, { limit: 100 })
  ).data.filter((id) => VAT_ID_TYPES.has(id.type));
  if (
    value &&
    existing.some(
      (id) => id.type === type && normalizeVatId(id.value) === value,
    )
  ) {
    // Unchanged: keep it, with its verification. Remove any others.
    for (const id of existing) {
      if (!(id.type === type && normalizeVatId(id.value) === value)) {
        await stripe.customers.deleteTaxId(customer_id, id.id);
      }
    }
    return;
  }
  if (value) {
    // Create first, so an invalid number leaves the old one in place.
    await stripe.customers.createTaxId(customer_id, { type, value });
  }
  for (const id of existing) {
    await stripe.customers.deleteTaxId(customer_id, id.id);
  }
}

export function customerHasUsableBillingDetails(customer): boolean {
  if (customer?.deleted) {
    return false;
  }
  const address = customer?.address ?? {};
  return (
    !!`${customer?.name ?? ""}`.trim() &&
    !!`${address.country ?? ""}`.trim() &&
    !!`${address.postal_code ?? ""}`.trim()
  );
}

export async function setCustomer(
  account_id,
  changes: { name?: string; address?; email?: string; vat_id?: string | null },
) {
  const customer_id = await getStripeCustomerId({ account_id, create: true });
  if (!customer_id) {
    throw Error("unable to get stripe customer id");
  }
  const stripe = await getConn();
  const updated = await stripe.customers.update(customer_id, {
    // NOTE: be a little paranoid in case user passes in some extra fields!
    name: changes.name,
    address: changes.address,
    email: changes.email,
  });
  if (changes.vat_id !== undefined) {
    await setCustomerVatId({
      stripe,
      customer_id,
      vat_id: changes.vat_id,
      country: changes.address?.country ?? updated?.address?.country,
    });
  }
}

export async function hasBillingDetails(account_id: string): Promise<boolean> {
  const customer_id = await getStripeCustomerId({ account_id, create: false });
  if (!customer_id) {
    return false;
  }
  const stripe = await getConn();
  const customer = await stripe.customers.retrieve(customer_id);
  return customerHasUsableBillingDetails(customer);
}

export async function getCustomer(account_id) {
  const customer_id = await getStripeCustomerId({ account_id, create: false });
  if (!customer_id) {
    return {};
  }
  const stripe = await getConn();
  const customer = await stripe.customers.retrieve(customer_id, {
    expand: ["tax_ids"],
  });
  if (customer.deleted) {
    return {};
  }
  // obviously, don't return *everything*.  Later may return more.
  // Bizarelly stripe's api absolutely can return customer.address === null, e.g., it does
  // that for Andrey's admin account!  But if you leave that, then the frontend gives
  // the error "defaultValues.address should be an object. You specified: null" and it crashes!
  return {
    name: customer.name ?? (await getName(account_id)),
    address: customer.address ?? {},
    phone: customer.phone ?? undefined,
    vat_id: customerVatId(customer),
  };
}
