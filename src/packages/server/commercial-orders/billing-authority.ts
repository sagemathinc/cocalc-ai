/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { registerBillingAuthorityAccount } from "@cocalc/server/purchases/billing-authority/context";
import type { CommercialOrder } from "@cocalc/util/commercial-orders";

export async function registerCommercialOrderBillingAccount(
  order: Pick<CommercialOrder, "customer_account_id">,
  options: { allow_direct_execution?: boolean } = {},
): Promise<void> {
  const accountId = `${order.customer_account_id ?? ""}`.trim();
  if (accountId) await registerBillingAuthorityAccount(accountId, options);
}
