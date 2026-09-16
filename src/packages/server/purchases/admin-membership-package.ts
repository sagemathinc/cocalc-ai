/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import {
  ensureAccountAdminAuditLogSchema,
  recordAccountAdminAuditEventInTransaction,
} from "@cocalc/server/accounts/admin-audit";
import { isValidBillingAccount } from "./billing-account";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { lockAccountSpending } from "./lock-account-spending";
import {
  createMembershipPackage,
  resolveAdminMembershipPackageQuote,
  setMembershipPackagePurchaseId,
} from "@cocalc/server/membership/packages";
import {
  ensureCreditCoversPurchase,
  maybeCreateFundingCredit,
} from "@cocalc/server/purchases/admin-purchase";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import { refreshAccountBalanceAndPublishBestEffort } from "@cocalc/server/purchases/refresh-balance";
import createPaymentIntent from "@cocalc/server/purchases/stripe/create-payment-intent";
import processPaymentIntents from "./stripe/process-payment-intents";
import getStripe from "@cocalc/server/stripe/connection";
import { ADMIN_MEMBERSHIP_PACKAGE_PURCHASE } from "@cocalc/util/db-schema/purchases";
import {
  beginAdminMembershipCardDispatch,
  prepareAdminMembershipOrder,
  verifyAdminMembershipPayment,
} from "./admin-membership-orders";
import type { AdminMembershipOrder } from "./admin-membership-orders";
import type { MoneyValue } from "@cocalc/util/money";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import { toDecimal } from "@cocalc/util/money";

import {
  resolveAdminCourseProjectQuoteContext,
  resolveLockedLocalAdminCourseProjectQuoteContext,
} from "./admin-course-project";
import {
  adminMembershipPackageBusinessIdentityHash,
  adminMembershipPackageInvoiceId,
  legacyAdminMembershipPackageRequestHash,
  normalizeAdminMembershipPackageBusinessIdentity,
  normalizeAdminMembershipPackageProduct,
  normalizeAdminMembershipPackageUuid,
} from "./admin-membership-package-identity";
import type { AdminMembershipPackageSource } from "./admin-membership-package-identity";

export type { AdminMembershipPackageSource } from "./admin-membership-package-identity";

import type { MembershipPackageQuote } from "@cocalc/conat/hub/api/purchases";
import { registerBillingAuthorityAccount } from "./billing-authority/context";

export interface AdminMembershipPackagePurchaseOptions {
  admin_account_id: string;
  user_account_id: string;
  product: MembershipPackageProduct;
  price: number;
  source: AdminMembershipPackageSource;
  reason: string;
  idempotency_key: string;
  pricing_note?: string;
  trusted_admin?: boolean;
  accepted_request_hashes?: readonly string[];
}

export interface AdminMembershipPackagePurchaseResult {
  package_id: string;
  purchase_id: number;
  credit_id?: number;
  payment_intent_id?: string;
  hosted_invoice_url?: string;
  price: number;
  standard_price: number;
  starts_at: Date;
  expires_at: Date;
  existing: boolean;
}

export async function adminGetMembershipPackageQuote({
  admin_account_id,
  user_account_id,
  product,
  trusted_admin = false,
}: {
  admin_account_id: string;
  user_account_id: string;
  product: MembershipPackageProduct;
  trusted_admin?: boolean;
}): Promise<MembershipPackageQuote> {
  admin_account_id = normalizeAdminMembershipPackageUuid(
    admin_account_id,
    "admin_account_id",
  );
  user_account_id = normalizeAdminMembershipPackageUuid(
    user_account_id,
    "user_account_id",
  );
  product = normalizeAdminMembershipPackageProduct(product);
  if (!trusted_admin && !(await userIsInGroup(admin_account_id, "admin"))) {
    throw Error("must be an admin");
  }
  if (!(await isValidBillingAccount(user_account_id))) {
    throw Error("target account is not valid");
  }
  if (product?.type !== "membership-package" || product.package_id) {
    throw Error("product must create a new membership package");
  }
  const courseProject = await resolveAdminCourseProjectQuoteContext({
    admin_account_id,
    product,
  });
  return await resolveAdminMembershipPackageQuote(
    product,
    undefined,
    courseProject,
  );
}

function normalizeDate(value: Date | string | undefined, name: string): Date {
  const date = value instanceof Date ? value : new Date(`${value ?? ""}`);
  if (!Number.isFinite(date.valueOf())) {
    throw Error(`${name} must be a valid date`);
  }
  return date;
}

function invoiceId(adminAccountId: string, idempotencyKey: string): string {
  return adminMembershipPackageInvoiceId(adminAccountId, idempotencyKey);
}

async function getExistingPurchase({
  account_id,
  invoice_id,
  client,
  accepted_request_hashes,
}: {
  account_id: string;
  accepted_request_hashes?: readonly string[];
  invoice_id: string;
  client?: PoolClient;
}): Promise<AdminMembershipPackagePurchaseResult | undefined> {
  const { rows } = await (client ?? getPool("medium")).query(
    `SELECT id, account_id, service, cost, description, period_start, period_end
       FROM purchases
      WHERE invoice_id=$1
      LIMIT 1`,
    [invoice_id],
  );
  const row = rows[0];
  const description = row?.description;
  if (!row) return undefined;
  if (
    row.service !== "membership" ||
    `${row.account_id}`.toLowerCase() !== account_id.toLowerCase() ||
    description?.type !== "membership-package" ||
    !`${description?.package_id ?? ""}`.trim()
  ) {
    throw Error("idempotency key belongs to an incompatible purchase");
  }
  if (
    accepted_request_hashes &&
    description.admin_request_hash &&
    !accepted_request_hashes.includes(description.admin_request_hash)
  )
    throw Error("idempotency key belongs to a different package request");
  return {
    package_id: `${description.package_id}`,
    purchase_id: Number(row.id),
    credit_id:
      Number.isInteger(Number(description.admin_funding_credit_id)) &&
      Number(description.admin_funding_credit_id) > 0
        ? Number(description.admin_funding_credit_id)
        : undefined,
    payment_intent_id:
      `${description.admin_payment_intent_id ?? ""}`.trim() || undefined,
    hosted_invoice_url:
      `${description.admin_hosted_invoice_url ?? ""}`.trim() || undefined,
    price: Number(row.cost),
    standard_price: Number(description.standard_total_price ?? row.cost),
    starts_at: new Date(row.period_start),
    expires_at: new Date(row.period_end),
    existing: true,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

async function fundPurchaseFromCard(
  order: AdminMembershipOrder,
): Promise<AdminMembershipPackagePurchaseResult> {
  const current = await beginAdminMembershipCardDispatch(order);
  let hosted_invoice_url: string | undefined;
  if (current.payment_intent_id) {
    await processPaymentIntents({
      account_id: current.account_id,
      payment_intent_id: current.payment_intent_id,
    });
    const existing = await getExistingPurchase({
      account_id: current.account_id,
      invoice_id: invoiceId(current.admin_account_id, current.idempotency_key),
    });
    if (existing) return existing;
    if (current.stripe_invoice_id) {
      hosted_invoice_url =
        (await (await getStripe()).invoices.retrieve(current.stripe_invoice_id))
          .hosted_invoice_url ?? undefined;
    }
  } else {
    ({ hosted_invoice_url } = await createPaymentIntent({
      account_id: current.account_id,
      purpose: ADMIN_MEMBERSHIP_PACKAGE_PURCHASE,
      description: "Custom CoCalc membership package",
      lineItems: [
        {
          amount: current.request.price,
          description: "Custom CoCalc membership package",
        },
      ],
      metadata: {
        admin_account_id: current.admin_account_id,
        admin_membership_order_id: current.id,
      },
      force: true,
      requireAddress: true,
      processImmediately: true,
      idempotencyKeyPrefix: `admin-membership-order:${current.id}`,
      allowedPaymentMethodTypes: ["card"],
    }));
    const existing = await getExistingPurchase({
      account_id: current.account_id,
      invoice_id: invoiceId(current.admin_account_id, current.idempotency_key),
    });
    if (existing) return { ...existing, existing: false };
  }
  throw Error(
    `The saved card purchase has not completed. If payment is required, complete the invoice and retry; do not submit a new purchase: ${hosted_invoice_url ?? "contact support to inspect the existing payment"}`,
  );
}

export default async function adminCreateMembershipPackagePurchase({
  admin_account_id,
  user_account_id,
  product,
  price,
  source,
  reason,
  idempotency_key,
  pricing_note,
  trusted_admin = false,
}: AdminMembershipPackagePurchaseOptions): Promise<AdminMembershipPackagePurchaseResult> {
  const legacyProduct = product;
  admin_account_id = normalizeAdminMembershipPackageUuid(
    admin_account_id,
    "admin_account_id",
  );
  user_account_id = normalizeAdminMembershipPackageUuid(
    user_account_id,
    "user_account_id",
  );
  product = normalizeAdminMembershipPackageProduct(product);
  if (!trusted_admin && !(await userIsInGroup(admin_account_id, "admin"))) {
    throw Error("must be an admin");
  }
  if (!(await isValidBillingAccount(user_account_id))) {
    throw Error("target account is not valid");
  }
  if (product?.type !== "membership-package" || product.package_id) {
    throw Error("product must create a new membership package");
  }
  const businessIdentity = normalizeAdminMembershipPackageBusinessIdentity({
    admin_account_id,
    user_account_id,
    product,
    price,
    source,
    reason,
    idempotency_key,
    pricing_note,
  });
  product = businessIdentity.product;
  source = businessIdentity.source;
  const normalizedReason = businessIdentity.reason;
  const normalizedPricingNote = businessIdentity.pricing_note ?? undefined;
  const idempotencyKey = businessIdentity.idempotency_key;
  const customPrice = toDecimal(businessIdentity.custom_price);
  const request_hash =
    adminMembershipPackageBusinessIdentityHash(businessIdentity);
  const accepted_request_hashes = [
    request_hash,
    legacyAdminMembershipPackageRequestHash({
      admin_account_id,
      user_account_id,
      product: legacyProduct,
      custom_price: businessIdentity.custom_price,
      source,
      reason: normalizedReason,
      pricing_note: normalizedPricingNote,
    }),
  ];
  await registerBillingAuthorityAccount(user_account_id);
  const invoice_id = invoiceId(admin_account_id, idempotencyKey);
  const existing = await getExistingPurchase({
    account_id: user_account_id,
    invoice_id,
    accepted_request_hashes,
  });
  if (existing) return existing;

  await ensureAccountAdminAuditLogSchema();
  const order = await prepareAdminMembershipOrder({
    admin_account_id,
    user_account_id,
    product,
    price: customPrice.toNumber(),
    source,
    reason: normalizedReason,
    idempotency_key: idempotencyKey,
    pricing_note: normalizedPricingNote,
    accepted_request_hashes,
  });
  if (source === "card" && customPrice.gt(0))
    return fundPurchaseFromCard(order);
  const client = await getTransactionClient();
  try {
    await lockAccountSpending(client, user_account_id);
    const result = await fulfillAdminMembershipOrder(order, client);
    await client.query("COMMIT");
    await refreshAccountBalanceAndPublishBestEffort({
      account_id: user_account_id,
    });
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) {
      const existing = await getExistingPurchase({
        account_id: user_account_id,
        invoice_id,
        accepted_request_hashes,
      });
      if (existing) return existing;
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Called only inside verified captured-payment fulfillment, with its account
 * lock and payment hold. No provider calls or transaction boundaries here.
 */
export async function fulfillAdminMembershipCardPayment(
  opts: {
    account_id: string;
    order_id: string;
    payment_intent_id: string;
    amount: MoneyValue;
    credit_id: number;
    hosted_invoice_url?: string;
    minimumPayment: number;
  },
  client: PoolClient,
): Promise<AdminMembershipPackagePurchaseResult> {
  const order = await verifyAdminMembershipPayment(opts, client);
  return fulfillAdminMembershipOrder(order, client, {
    credit_id: opts.credit_id,
    payment_intent_id: opts.payment_intent_id,
    hosted_invoice_url: opts.hosted_invoice_url,
    minimumPayment: opts.minimumPayment,
  });
}

async function fulfillAdminMembershipOrder(
  order: AdminMembershipOrder,
  client: PoolClient,
  cardFunding?: {
    credit_id: number;
    payment_intent_id: string;
    hosted_invoice_url?: string;
    minimumPayment: number;
  },
): Promise<AdminMembershipPackagePurchaseResult> {
  const {
    account_id: user_account_id,
    admin_account_id,
    idempotency_key: idempotencyKey,
  } = order;
  const {
    product,
    price,
    source,
    reason: normalizedReason,
    pricing_note,
  } = order.request;
  const customPrice = toDecimal(price);
  const invoice_id = invoiceId(admin_account_id, idempotencyKey);
  const existing = await getExistingPurchase({
    account_id: user_account_id,
    invoice_id,
    client,
  });
  if (existing) {
    if (
      cardFunding &&
      existing.payment_intent_id !== cardFunding.payment_intent_id
    )
      throw Error("Membership purchase belongs to another payment");
    return existing;
  }

  // Fulfillment can arrive asynchronously after the initial quote transaction.
  // Reacquire the project rehome fence before committing the package locally.
  await resolveLockedLocalAdminCourseProjectQuoteContext({ client, product });

  const quote = order.quote;
  const starts_at = product.starts_at
    ? normalizeDate(product.starts_at, "starts_at")
    : normalizeDate(quote.starts_at, "starts_at");
  const expires_at = product.expires_at
    ? normalizeDate(product.expires_at, "expires_at")
    : normalizeDate(quote.expires_at, "expires_at");
  if (!(starts_at instanceof Date) || !Number.isFinite(starts_at.valueOf())) {
    throw Error("starts_at is required");
  }
  if (!(expires_at instanceof Date) || !Number.isFinite(expires_at.valueOf())) {
    throw Error("expires_at is required");
  }
  if (expires_at <= starts_at) {
    throw Error("expires_at must be after starts_at");
  }

  const notes = [
    `Admin-assisted membership package created by account \`${admin_account_id}\`.`,
    `Source of funds: **${source}**.`,
    pricing_note?.trim() ? `Pricing note: ${pricing_note.trim()}` : "",
    `Reason: ${normalizedReason}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  let credit_id: number | undefined = cardFunding?.credit_id;
  if (source === "free") {
    credit_id = await maybeCreateFundingCredit({
      account_id: user_account_id,
      admin_account_id,
      amount: customPrice.toNumber(),
      client,
      notes,
    });
  } else if (customPrice.gt(0)) {
    await ensureCreditCoversPurchase({
      account_id: user_account_id,
      client,
      cost: customPrice.toNumber(),
      service: "membership",
      minimumPayment: cardFunding?.minimumPayment,
    });
  }

  const metadata = {
    ...(quote.metadata ?? {}),
    ...(product.metadata ?? {}),
    admin_custom_price: customPrice.toNumber(),
    standard_total_price: quote.total_price,
  };
  const package_id = await createMembershipPackage(
    {
      owner_account_id: user_account_id,
      kind: quote.kind,
      membership_class: quote.membership_class,
      seat_count: quote.seat_count,
      starts_at,
      expires_at,
      metadata,
    },
    client,
  );
  const purchase_id = await createPurchase({
    account_id: user_account_id,
    client,
    cost: customPrice.toNumber(),
    unrounded_cost: customPrice.toNumber(),
    description: {
      type: "membership-package",
      package_id,
      kind: quote.kind,
      membership_class: quote.membership_class,
      seat_count: quote.seat_count,
      seat_price:
        quote.seat_count > 0 ? customPrice.div(quote.seat_count).toNumber() : 0,
      total_price: customPrice.toNumber(),
      standard_seat_price: quote.seat_price,
      standard_total_price: quote.total_price,
      starts_at,
      expires_at,
      interval: quote.interval,
      metadata,
      admin_request_hash: adminMembershipPackageBusinessIdentityHash(
        normalizeAdminMembershipPackageBusinessIdentity({
          ...order.request,
          admin_account_id,
          user_account_id,
          idempotency_key: idempotencyKey,
        }),
      ),
      admin_assigned: true,
      assigned_by: admin_account_id,
      admin_funding_credit_id: credit_id,
      admin_payment_intent_id: cardFunding?.payment_intent_id,
      admin_hosted_invoice_url: cardFunding?.hosted_invoice_url,
    } as any,
    invoice_id,
    notes,
    period_start: starts_at,
    period_end: expires_at,
    service: "membership",
    tag: "admin-membership-package",
  });
  await setMembershipPackagePurchaseId({ package_id, purchase_id }, client);
  await recordAccountAdminAuditEventInTransaction({
    account_id: user_account_id,
    action: "membership-package-purchase",
    actor_account_id: admin_account_id,
    client,
    reason: normalizedReason,
    metadata: {
      package_id,
      purchase_id,
      credit_id: credit_id ?? null,
      payment_intent_id: cardFunding?.payment_intent_id ?? null,
      source,
      custom_price: customPrice.toNumber(),
      standard_price: quote.total_price,
      kind: quote.kind,
      membership_class: quote.membership_class,
      seat_count: quote.seat_count,
      starts_at: starts_at.toISOString(),
      expires_at: expires_at.toISOString(),
      idempotency_key: idempotencyKey,
    },
  });
  return {
    package_id,
    purchase_id,
    credit_id,
    payment_intent_id: cardFunding?.payment_intent_id,
    hosted_invoice_url: cardFunding?.hosted_invoice_url,
    price: customPrice.toNumber(),
    standard_price: quote.total_price,
    starts_at,
    expires_at,
    existing: false,
  };
}
