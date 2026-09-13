/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import { resolveMembershipPackageQuote } from "@cocalc/server/membership/packages";
import type { MembershipPackageQuote } from "@cocalc/conat/hub/api/purchases";
import { toDecimal } from "@cocalc/util/money";
import type { MoneyValue } from "@cocalc/util/money";
import { ADMIN_MEMBERSHIP_PACKAGE_PURCHASE } from "@cocalc/util/db-schema/purchases";
import { lockAccountSpending } from "./lock-account-spending";
import type { AdminMembershipPackagePurchaseOptions } from "./admin-membership-package";

type Request = Omit<
  AdminMembershipPackagePurchaseOptions,
  "trusted_admin" | "admin_account_id" | "user_account_id" | "idempotency_key"
>;
export interface AdminMembershipOrder {
  id: string;
  account_id: string;
  admin_account_id: string;
  idempotency_key: string;
  request: Request;
  quote: MembershipPackageQuote;
  dispatched_at: Date | null;
  payment_intent_id: string | null;
  stripe_invoice_id: string | null;
}

async function transaction<T>(
  account_id: string,
  f: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getTransactionClient();
  try {
    await lockAccountSpending(client, account_id);
    const result = await f(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Internal only: the caller validates the administrator and normalizes input.
 * Store the quote once so delayed card completion cannot change package terms.
 */
export async function prepareAdminMembershipOrder(
  opts: AdminMembershipPackagePurchaseOptions,
): Promise<AdminMembershipOrder> {
  const request = JSON.stringify({
    product: opts.product,
    price: opts.price,
    source: opts.source,
    reason: opts.reason,
    pricing_note: opts.pricing_note,
  });
  return transaction(opts.user_account_id, async (client) => {
    const {
      rows: [existing],
    } = await client.query<AdminMembershipOrder & { matches: boolean }>(
      `SELECT *, (account_id=$3 AND request=$4::jsonb) AS matches
         FROM admin_membership_orders WHERE admin_account_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [
        opts.admin_account_id,
        opts.idempotency_key,
        opts.user_account_id,
        request,
      ],
    );
    if (existing) {
      if (!existing.matches)
        throw Error(
          "Membership order terms changed; use a new idempotency key",
        );
      return existing;
    }
    if (opts.source === "card" && opts.price > 0) {
      const { rows: legacy } = await client.query(
        `SELECT p.id FROM purchases p
          WHERE p.account_id=$1 AND p.service='credit'
            AND p.description->>'purpose'=$2
            AND p.description->>'refund_purchase_id' IS NULL
            AND NOT EXISTS (SELECT 1 FROM payment_fulfillments f WHERE f.payment_id=p.invoice_id)
            AND NOT EXISTS (SELECT 1 FROM purchases m WHERE m.account_id=p.account_id
              AND m.service='membership' AND m.description->>'admin_payment_intent_id'=p.invoice_id)
          LIMIT 1`,
        [opts.user_account_id, ADMIN_MEMBERSHIP_PACKAGE_PURCHASE],
      );
      if (legacy.length)
        throw Error(
          "An earlier custom membership payment needs reconciliation before charging this account again",
        );
    }
    const quote = await resolveMembershipPackageQuote(opts.product, client);
    const starts_at = new Date(opts.product.starts_at ?? quote.starts_at ?? "");
    const expires_at = new Date(
      opts.product.expires_at ?? quote.expires_at ?? "",
    );
    if (
      !Number.isFinite(starts_at.valueOf()) ||
      !Number.isFinite(expires_at.valueOf()) ||
      expires_at <= starts_at
    ) {
      throw Error("Membership order requires valid start and expiry dates");
    }
    const {
      rows: [order],
    } = await client.query<AdminMembershipOrder>(
      `INSERT INTO admin_membership_orders (id,account_id,admin_account_id,idempotency_key,request,quote)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING *`,
      [
        randomUUID(),
        opts.user_account_id,
        opts.admin_account_id,
        opts.idempotency_key,
        request,
        JSON.stringify({ ...quote, starts_at, expires_at }),
      ],
    );
    return order;
  });
}

export async function getAdminMembershipOrder(
  account_id: string,
  id: string,
  client?: PoolClient,
): Promise<AdminMembershipOrder> {
  const {
    rows: [order],
  } = await (client ?? getPool()).query<AdminMembershipOrder>(
    "SELECT * FROM admin_membership_orders WHERE id=$1 AND account_id=$2",
    [id, account_id],
  );
  if (!order)
    throw Error("Membership payment order not found for this account");
  return order;
}

/** A persisted dispatch identity prevents a new charge after Stripe's key TTL.
 * If a payment is already bound, callers only inspect/process that payment.
 */
export async function beginAdminMembershipCardDispatch(
  order: AdminMembershipOrder,
): Promise<AdminMembershipOrder> {
  return transaction(order.account_id, async (client) => {
    const {
      rows: [current],
    } = await client.query<AdminMembershipOrder & { retry_allowed: boolean }>(
      `SELECT *, (dispatched_at IS NULL OR dispatched_at > clock_timestamp()-INTERVAL '23 hours') AS retry_allowed
         FROM admin_membership_orders WHERE id=$1 AND account_id=$2 FOR UPDATE`,
      [order.id, order.account_id],
    );
    if (
      !current ||
      current.request.source !== "card" ||
      current.request.price <= 0
    )
      throw Error("Not a card-funded membership order");
    if (current.payment_intent_id) return current;
    if (!current.retry_allowed)
      throw Error(
        "Membership payment retry window expired; reconcile the existing invoice before retrying",
      );
    const {
      rows: [bound],
    } = await client.query<AdminMembershipOrder>(
      "UPDATE admin_membership_orders SET dispatched_at=COALESCE(dispatched_at,clock_timestamp()) WHERE id=$1 RETURNING *",
      [current.id],
    );
    return bound;
  });
}

export async function bindAdminMembershipPayment(opts: {
  account_id: string;
  order_id: string;
  payment_intent_id: string;
  stripe_invoice_id: string;
  amount: MoneyValue;
}): Promise<void> {
  if (
    !opts.payment_intent_id?.startsWith("pi_") ||
    !opts.stripe_invoice_id?.startsWith("in_")
  )
    throw Error("Invalid membership payment identity");
  await transaction(opts.account_id, async (client) => {
    const order = await getAdminMembershipOrder(
      opts.account_id,
      opts.order_id,
      client,
    );
    if (
      order.request.source !== "card" ||
      !order.dispatched_at ||
      order.request.price <= 0 ||
      !toDecimal(opts.amount).eq(order.request.price)
    )
      throw Error("Membership payment does not match its order");
    if (
      order.payment_intent_id &&
      (order.payment_intent_id !== opts.payment_intent_id ||
        order.stripe_invoice_id !== opts.stripe_invoice_id)
    )
      throw Error("Membership order already has a different payment");
    await client.query(
      "UPDATE admin_membership_orders SET payment_intent_id=$2,stripe_invoice_id=$3 WHERE id=$1",
      [order.id, opts.payment_intent_id, opts.stripe_invoice_id],
    );
  });
}

export async function verifyAdminMembershipPayment(
  opts: {
    account_id: string;
    order_id: string;
    payment_intent_id: string;
    amount: MoneyValue;
  },
  client?: PoolClient,
): Promise<AdminMembershipOrder> {
  const order = await getAdminMembershipOrder(
    opts.account_id,
    opts.order_id,
    client,
  );
  if (
    order.request.source !== "card" ||
    order.payment_intent_id !== opts.payment_intent_id ||
    !toDecimal(opts.amount).eq(order.request.price)
  )
    throw Error("Captured membership payment does not match its order");
  return order;
}
