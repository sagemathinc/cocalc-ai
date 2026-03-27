/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getTransactionClient } from "@cocalc/database/pool";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { isPurchaseAllowed } from "@cocalc/server/purchases/is-purchase-allowed";
import createVouchers from "@cocalc/server/vouchers/create-vouchers";
import { toDecimal } from "@cocalc/util/money";
import { MAX_VOUCHERS, MAX_VOUCHER_VALUE } from "@cocalc/util/vouchers";

export default async function handle(req, res) {
  try {
    res.json(await create(req));
  } catch (err) {
    res.json({ error: `${err.message}` });
  }
}

async function create(req) {
  const account_id = await getAccountId(req);
  if (account_id == null) {
    throw Error("must be signed in");
  }

  const { amount, count, title } = getParams(req);
  const amountValue = toDecimal(Number(amount ?? 0));
  const countValue = Number(count ?? 0);
  const titleValue = `${title ?? ""}`.trim();

  if (
    !Number.isFinite(amountValue.toNumber()) ||
    amountValue.lte(0) ||
    amountValue.gt(MAX_VOUCHER_VALUE)
  ) {
    throw Error(`amount must be positive and at most ${MAX_VOUCHER_VALUE}`);
  }
  if (
    !Number.isInteger(countValue) ||
    countValue < 1 ||
    countValue > MAX_VOUCHERS.now
  ) {
    throw Error(`count must be an integer between 1 and ${MAX_VOUCHERS.now}`);
  }
  if (!titleValue) {
    throw Error("title is required");
  }

  const totalCost = amountValue.mul(countValue);
  const client = await getTransactionClient();
  try {
    const purchase = await isPurchaseAllowed({
      account_id,
      client,
      cost: totalCost.toNumber(),
      service: "voucher",
    });
    const chargeAmount = toDecimal(purchase.chargeAmount ?? 0);
    if (!purchase.allowed || chargeAmount.gt(0)) {
      throw Error(purchase.reason ?? "payment required");
    }
    const result = await createVouchers({
      account_id,
      active: new Date(),
      amount: amountValue.toNumber(),
      cancelBy: null,
      client,
      expire: null,
      numVouchers: countValue,
      title: titleValue,
      whenPay: "now",
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
