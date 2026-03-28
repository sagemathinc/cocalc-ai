/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import dayjs from "dayjs";

import { getTransactionClient } from "@cocalc/database/pool";
import isValidAccount from "@cocalc/server/accounts/is-valid-account";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import {
  getMembershipPrice,
  getMembershipTiers,
} from "@cocalc/server/membership/tiers";
import createCredit from "@cocalc/server/purchases/create-credit";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import { isPurchaseAllowed } from "@cocalc/server/purchases/is-purchase-allowed";
import createVouchers from "@cocalc/server/vouchers/create-vouchers";
import { MAX_COST } from "@cocalc/util/db-schema/purchases";
import { moneyRound2Up, moneyToCurrency, toDecimal } from "@cocalc/util/money";
import { MAX_VOUCHERS, MAX_VOUCHER_VALUE } from "@cocalc/util/vouchers";

type Product = "membership" | "voucher";
type Source = "credit" | "free";

export interface AdminPurchaseOptions {
  admin_account_id: string;
  comment?: string;
  interval?: "month" | "year";
  membership_class?: string;
  price: number;
  pricing_note?: string;
  product: Product;
  source: Source;
  user_account_id: string;
  voucher_amount?: number;
  voucher_count?: number;
  voucher_title?: string;
}

export interface AdminPurchaseResult {
  purchase_id: number;
  credit_id?: number;
  expires_at?: Date | null;
  voucher_codes?: string[];
  voucher_id?: number;
}

function buildNotes({
  admin_account_id,
  comment,
  pricing_note,
  source,
}: {
  admin_account_id: string;
  comment?: string;
  pricing_note?: string;
  source: Source;
}): string {
  const lines = [
    `Admin-assisted purchase created by account \`${admin_account_id}\`.`,
    `Source of funds: **${source}**.`,
  ];
  if (pricing_note?.trim()) {
    lines.push(`Pricing note: ${pricing_note.trim()}`);
  }
  if (comment?.trim()) {
    lines.push(`Comment: ${comment.trim()}`);
  }
  return lines.join("\n\n");
}

async function ensureAdminAssignedMembership({
  admin_account_id,
  client,
  expires_at,
  membership_class,
  notes,
  user_account_id,
}: {
  admin_account_id: string;
  client;
  expires_at: Date | null;
  membership_class: string;
  notes: string;
  user_account_id: string;
}) {
  await client.query(
    `INSERT INTO admin_assigned_memberships
       (account_id, membership_class, assigned_by, assigned_at, expires_at, notes)
     VALUES ($1,$2,$3,NOW(),$4,$5)
     ON CONFLICT (account_id)
     DO UPDATE SET
       membership_class=EXCLUDED.membership_class,
       assigned_by=EXCLUDED.assigned_by,
       assigned_at=EXCLUDED.assigned_at,
       expires_at=EXCLUDED.expires_at,
       notes=EXCLUDED.notes`,
    [user_account_id, membership_class, admin_account_id, expires_at, notes],
  );
}

async function maybeCreateFundingCredit({
  account_id,
  admin_account_id,
  amount,
  client,
  notes,
}: {
  account_id: string;
  admin_account_id: string;
  amount: number;
  client;
  notes: string;
}) {
  const amountValue = moneyRound2Up(toDecimal(amount));
  if (amountValue.lte(0)) {
    return undefined;
  }
  return await createCredit({
    account_id,
    amount: amountValue.toNumber(),
    client,
    description: {
      description: `Admin-assisted purchase funding from ${admin_account_id}`,
      purpose: "admin-purchase",
    },
    notes,
    tag: "admin-purchase-free",
  });
}

async function ensureCreditCoversPurchase({
  account_id,
  client,
  cost,
  service,
}: {
  account_id: string;
  client;
  cost: number;
  service: "membership" | "voucher";
}) {
  const purchase = await isPurchaseAllowed({
    account_id,
    client,
    cost,
    service,
  });
  const chargeAmount = toDecimal(purchase.chargeAmount ?? 0);
  if (!purchase.allowed || chargeAmount.gt(0)) {
    throw Error(purchase.reason ?? "payment required");
  }
}

export default async function adminPurchase({
  admin_account_id,
  comment,
  interval,
  membership_class,
  price,
  pricing_note,
  product,
  source,
  user_account_id,
  voucher_amount,
  voucher_count,
  voucher_title,
}: AdminPurchaseOptions): Promise<AdminPurchaseResult> {
  if (!(await userIsInGroup(admin_account_id, "admin"))) {
    throw Error("must be an admin");
  }
  if (!(await isValidAccount(user_account_id))) {
    throw Error("target account is not valid");
  }

  const priceValue = moneyRound2Up(toDecimal(price ?? 0));
  if (!Number.isFinite(priceValue.toNumber()) || priceValue.lt(0)) {
    throw Error("price must be a finite nonnegative number");
  }
  if (priceValue.gt(MAX_COST)) {
    throw Error(
      `price exceeds the maximum allowed cost of ${moneyToCurrency(MAX_COST)}`,
    );
  }

  const notes = buildNotes({
    admin_account_id,
    comment,
    pricing_note,
    source,
  });

  const client = await getTransactionClient();
  try {
    let credit_id: number | undefined;
    if (source === "free") {
      credit_id = await maybeCreateFundingCredit({
        account_id: user_account_id,
        admin_account_id,
        amount: priceValue.toNumber(),
        client,
        notes,
      });
    } else if (priceValue.gt(0)) {
      await ensureCreditCoversPurchase({
        account_id: user_account_id,
        client,
        cost: priceValue.toNumber(),
        service: product === "membership" ? "membership" : "voucher",
      });
    }

    if (product === "membership") {
      if (!membership_class) {
        throw Error("membership_class is required");
      }
      if (interval !== "month" && interval !== "year") {
        throw Error("interval must be month or year");
      }

      const tiers = await getMembershipTiers({
        client,
        includeDisabled: true,
      });
      const tier = tiers.find((candidate) => candidate.id === membership_class);
      if (!tier || tier.disabled) {
        throw Error(`membership tier "${membership_class}" is not available`);
      }
      getMembershipPrice(tier, interval);

      const period_start = new Date();
      const expires_at =
        interval === "month"
          ? dayjs(period_start).add(1, "month").toDate()
          : dayjs(period_start).add(1, "year").toDate();

      await ensureAdminAssignedMembership({
        admin_account_id,
        client,
        expires_at,
        membership_class,
        notes,
        user_account_id,
      });

      const purchase_id = await createPurchase({
        account_id: user_account_id,
        client,
        cost: priceValue.toNumber(),
        description: {
          type: "membership",
          class: membership_class,
          interval,
          admin_assigned: true,
          assigned_by: admin_account_id,
        } as any,
        notes,
        period_end: expires_at,
        period_start,
        service: "membership",
        tag: "admin-purchase",
      });

      await client.query("COMMIT");
      return { credit_id, expires_at, purchase_id };
    }

    const amountValue = toDecimal(voucher_amount ?? 0);
    const count = Number(voucher_count ?? 0);
    const title = `${voucher_title ?? ""}`.trim();
    if (
      !Number.isFinite(amountValue.toNumber()) ||
      amountValue.lte(0) ||
      amountValue.gt(MAX_VOUCHER_VALUE)
    ) {
      throw Error(
        `voucher amount must be positive and at most ${MAX_VOUCHER_VALUE}`,
      );
    }
    if (!Number.isInteger(count) || count < 1 || count > MAX_VOUCHERS.admin) {
      throw Error(
        `voucher count must be an integer between 1 and ${MAX_VOUCHERS.admin}`,
      );
    }
    if (!title) {
      throw Error("voucher_title is required");
    }

    const result = await createVouchers({
      account_id: user_account_id,
      active: new Date(),
      amount: amountValue.toNumber(),
      cancelBy: null,
      client,
      credit_id,
      expire: null,
      numVouchers: count,
      purchaseCost: priceValue.toNumber(),
      title,
      whenPay: "now",
    });

    if (result.purchase_id != null) {
      await client.query("UPDATE purchases SET notes=$1, tag=$2 WHERE id=$3", [
        notes,
        "admin-purchase",
        result.purchase_id,
      ]);
    }

    await client.query("COMMIT");
    return {
      credit_id,
      purchase_id: result.purchase_id ?? 0,
      voucher_codes: result.codes,
      voucher_id: result.id,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
