/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getCurrentAuthSession } from "@cocalc/server/auth/auth-sessions";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import adminPurchase from "@cocalc/server/purchases/admin-purchase";

export default async function handle(req, res) {
  try {
    const account_id = await getAccountId(req);
    if (account_id == null) {
      throw Error("must be signed in");
    }
    const session = await getCurrentAuthSession({ req, account_id });
    await requireDangerousSessionAuth({
      account_id,
      session_hash: session.session_hash,
      require_second_factor: true,
    });
    const {
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
    } = getParams(req);
    res.json(
      await adminPurchase({
        admin_account_id: account_id,
        comment,
        interval,
        membership_class,
        price: Number(price ?? 0),
        pricing_note,
        product,
        source,
        user_account_id,
        voucher_amount: Number(voucher_amount ?? 0),
        voucher_count: Number(voucher_count ?? 0),
        voucher_title,
      }),
    );
  } catch (err) {
    res.json({
      error: `${err.message}`,
      ...(err?.code != null ? { code: err.code } : {}),
    });
  }
}
