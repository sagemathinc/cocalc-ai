/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { getClient, type PoolClient } from "@cocalc/database/pool";
import { recordAccountAdminAuditEvent } from "@cocalc/server/accounts/admin-audit";
import isValidAccount from "@cocalc/server/accounts/is-valid-account";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import {
  assertAccountNotRehoming,
  assertAccountWriteOnHomeBay,
} from "@cocalc/server/accounts/rehome-fence";
import {
  createMembershipPackage,
  resolveAdminMembershipPackageQuote,
  setMembershipPackagePurchaseId,
} from "@cocalc/server/membership/packages";
import type { MembershipPackageQuote } from "@cocalc/conat/hub/api/purchases";
import {
  ensureCreditCoversPurchase,
  maybeCreateFundingCredit,
} from "@cocalc/server/purchases/admin-purchase";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import { refreshAccountBalanceAndPublishBestEffort } from "@cocalc/server/purchases/refresh-balance";
import createPaymentIntent from "@cocalc/server/purchases/stripe/create-payment-intent";
import { MAX_COST } from "@cocalc/util/db-schema/purchases";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import { moneyRound2Up, moneyToCurrency, toDecimal } from "@cocalc/util/money";
import {
  resolveAdminCourseProjectQuoteContext,
  resolveLockedLocalAdminCourseProjectQuoteContext,
} from "./admin-course-project";

export type AdminMembershipPackageSource = "card" | "credit" | "free";

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
  if (!trusted_admin && !(await userIsInGroup(admin_account_id, "admin"))) {
    throw Error("must be an admin");
  }
  if (!(await isValidAccount(user_account_id))) {
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

function normalizeRequiredText(
  value: string | undefined,
  name: string,
  maxLength: number,
): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) {
    throw Error(`${name} is required`);
  }
  if (normalized.length > maxLength) {
    throw Error(`${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeDate(value: Date | string | undefined, name: string): Date {
  const date = value instanceof Date ? value : new Date(`${value ?? ""}`);
  if (!Number.isFinite(date.valueOf())) {
    throw Error(`${name} must be a valid date`);
  }
  return date;
}

async function resolveValidatedPackageQuote({
  client,
  product,
}: {
  client: PoolClient;
  product: MembershipPackageProduct;
}): Promise<{
  quote: MembershipPackageQuote;
  starts_at: Date;
  expires_at: Date;
}> {
  const courseProject = await resolveLockedLocalAdminCourseProjectQuoteContext({
    client,
    product,
  });
  const quote = await resolveAdminMembershipPackageQuote(
    product,
    client,
    courseProject,
  );
  const starts_at = product.starts_at
    ? normalizeDate(product.starts_at, "starts_at")
    : quote.starts_at;
  const expires_at = product.expires_at
    ? normalizeDate(product.expires_at, "expires_at")
    : quote.expires_at;
  if (!(starts_at instanceof Date) || !Number.isFinite(starts_at.valueOf())) {
    throw Error("starts_at is required");
  }
  if (!(expires_at instanceof Date) || !Number.isFinite(expires_at.valueOf())) {
    throw Error("expires_at is required");
  }
  if (expires_at <= starts_at) {
    throw Error("expires_at must be after starts_at");
  }
  return { quote, starts_at, expires_at };
}

function invoiceId(adminAccountId: string, idempotencyKey: string): string {
  return `admin-membership-package:${adminAccountId}:${idempotencyKey}`;
}

async function getExistingPurchase({
  account_id,
  invoice_id,
  client,
}: {
  account_id: string;
  invoice_id: string;
  client?: PoolClient;
}): Promise<AdminMembershipPackagePurchaseResult | undefined> {
  const { rows } = await (client ?? getPool("medium")).query(
    `SELECT id, cost, description, period_start, period_end
       FROM purchases
      WHERE account_id=$1 AND invoice_id=$2 AND service='membership'
      LIMIT 1`,
    [account_id, invoice_id],
  );
  const row = rows[0];
  const description = row?.description;
  if (!row) return undefined;
  if (
    description?.type !== "membership-package" ||
    !`${description?.package_id ?? ""}`.trim()
  ) {
    throw Error("idempotency key belongs to an incompatible purchase");
  }
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

async function fundPurchaseFromCard({
  account_id,
  admin_account_id,
  amount,
  client,
  idempotency_key,
}: {
  account_id: string;
  admin_account_id: string;
  amount: number;
  client: PoolClient;
  idempotency_key: string;
}): Promise<{
  credit_id: number;
  payment_intent_id: string;
  hosted_invoice_url: string;
}> {
  const { payment_intent, hosted_invoice_url } = await createPaymentIntent({
    account_id,
    purpose: "admin-membership-package-purchase",
    description: "Custom CoCalc membership package",
    lineItems: [
      {
        amount,
        description: "Custom CoCalc membership package",
      },
    ],
    metadata: {
      admin_account_id,
      admin_purchase_idempotency_key: idempotency_key,
    },
    force: true,
    requireAddress: true,
    processImmediately: true,
    idempotencyKeyPrefix: `admin-membership-package:${admin_account_id}:${idempotency_key}`,
    allowedPaymentMethodTypes: ["card"],
  });
  const { rows } = await client.query(
    `SELECT id, -cost AS amount
       FROM purchases
      WHERE account_id=$1
        AND invoice_id=$2
        AND service='credit'
      LIMIT 1`,
    [account_id, payment_intent],
  );
  const credit = rows[0];
  if (!credit || toDecimal(credit.amount ?? 0).lt(amount)) {
    throw Error(
      `The saved card could not be charged automatically. Complete the invoice and retry: ${hosted_invoice_url}`,
    );
  }
  return {
    credit_id: Number(credit.id),
    payment_intent_id: payment_intent,
    hosted_invoice_url,
  };
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
  if (!trusted_admin && !(await userIsInGroup(admin_account_id, "admin"))) {
    throw Error("must be an admin");
  }
  if (!(await isValidAccount(user_account_id))) {
    throw Error("target account is not valid");
  }
  if (product?.type !== "membership-package" || product.package_id) {
    throw Error("product must create a new membership package");
  }
  if (source !== "card" && source !== "credit" && source !== "free") {
    throw Error("source must be card, credit, or free");
  }
  const normalizedReason = normalizeRequiredText(reason, "reason", 4000);
  const idempotencyKey = normalizeRequiredText(
    idempotency_key,
    "idempotency_key",
    120,
  );
  const customPrice = moneyRound2Up(toDecimal(price));
  if (!Number.isFinite(customPrice.toNumber()) || customPrice.lt(0)) {
    throw Error("price must be a finite nonnegative number");
  }
  if (customPrice.gt(MAX_COST)) {
    throw Error(
      `price exceeds the maximum allowed cost of ${moneyToCurrency(MAX_COST)}`,
    );
  }

  const invoice_id = invoiceId(admin_account_id, idempotencyKey);
  const existing = await getExistingPurchase({
    account_id: user_account_id,
    invoice_id,
  });
  if (existing) return existing;
  // Use a dedicated session rather than consuming the bounded application
  // pool while Stripe and its fulfillment callbacks use ordinary clients.
  const sessionClient = getClient();
  await sessionClient.connect();
  const client = sessionClient as unknown as PoolClient;
  const courseProjectId =
    product.kind === "course"
      ? `${product.course_project_id ?? ""}`.trim()
      : undefined;
  let accountFenceLocked = false;
  let projectFenceLocked = false;
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1::text), hashtext($2::text))",
      ["account-rehome", user_account_id],
    );
    accountFenceLocked = true;
    if (courseProjectId) {
      await client.query(
        "SELECT pg_advisory_lock(hashtext($1::text), hashtext($2::text))",
        ["project-rehome", courseProjectId],
      );
      projectFenceLocked = true;
    }

    // Validate before contacting Stripe, but do not hold a database
    // transaction open across provider I/O. The session locks still prevent
    // account or project rehome while funding is in flight.
    await client.query("BEGIN");
    await assertAccountNotRehoming({
      db: client,
      account_id: user_account_id,
      action: "create admin membership package purchase",
    });
    await assertAccountWriteOnHomeBay({
      db: client,
      account_id: user_account_id,
      action: "create admin membership package purchase",
    });
    await resolveValidatedPackageQuote({
      client,
      product,
    });
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
      ["admin-membership-package", invoice_id],
    );
    const existing = await getExistingPurchase({
      account_id: user_account_id,
      invoice_id,
      client,
    });
    if (existing) {
      await client.query("COMMIT");
      return existing;
    }
    await client.query("COMMIT");

    const cardFunding =
      source === "card" && customPrice.gt(0)
        ? await fundPurchaseFromCard({
            account_id: user_account_id,
            admin_account_id,
            amount: customPrice.toNumber(),
            client,
            idempotency_key: idempotencyKey,
          })
        : undefined;

    // Revalidate after provider funding and keep the final course row lock
    // through fulfillment. If the process died after funding, the same key
    // recovers the existing invoice credit on retry.
    await client.query("BEGIN");
    await assertAccountNotRehoming({
      db: client,
      account_id: user_account_id,
      action: "create admin membership package purchase",
    });
    await assertAccountWriteOnHomeBay({
      db: client,
      account_id: user_account_id,
      action: "create admin membership package purchase",
    });
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
      ["admin-membership-package", invoice_id],
    );
    const existingAfterFunding = await getExistingPurchase({
      account_id: user_account_id,
      invoice_id,
      client,
    });
    if (existingAfterFunding) {
      await client.query("COMMIT");
      return existingAfterFunding;
    }
    const { quote, starts_at, expires_at } = await resolveValidatedPackageQuote(
      { client, product },
    );

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
          quote.seat_count > 0
            ? customPrice.div(quote.seat_count).toNumber()
            : 0,
        total_price: customPrice.toNumber(),
        standard_seat_price: quote.seat_price,
        standard_total_price: quote.total_price,
        starts_at,
        expires_at,
        interval: quote.interval,
        metadata,
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
    await recordAccountAdminAuditEvent({
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
    await client.query("COMMIT");
    await refreshAccountBalanceAndPublishBestEffort({
      account_id: user_account_id,
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
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) {
      const existing = await getExistingPurchase({
        account_id: user_account_id,
        invoice_id,
      });
      if (existing) return existing;
    }
    throw err;
  } finally {
    if (projectFenceLocked) {
      await sessionClient
        .query(
          "SELECT pg_advisory_unlock(hashtext($1::text), hashtext($2::text))",
          ["project-rehome", courseProjectId],
        )
        .catch(() => undefined);
    }
    if (accountFenceLocked) {
      await sessionClient
        .query(
          "SELECT pg_advisory_unlock(hashtext($1::text), hashtext($2::text))",
          ["account-rehome", user_account_id],
        )
        .catch(() => undefined);
    }
    await sessionClient.end();
  }
}
