/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import api from "@cocalc/frontend/client/api";

export async function adminPurchase(opts: {
  comment?: string;
  interval?: "month" | "year";
  membership_class?: string;
  price: number;
  pricing_note?: string;
  product: "balance" | "membership";
  source: "credit" | "free";
  user_account_id: string;
  balance_user_note?: string;
  balance_admin_note?: string;
}): Promise<{
  purchase_id: number;
  credit_id?: number;
  expires_at?: Date | null;
  adjustment_amount?: number;
}> {
  return await api("purchases/admin-purchase", opts);
}
