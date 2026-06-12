/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { PurchaseInfo } from "@cocalc/util/purchases/quota/types";
import { getDays } from "@cocalc/util/stripe/timecalcs";

export function getProductName(info: PurchaseInfo): string {
  // Similar to getProductId, but meant to be human readable.
  // This name is what customers see on invoices,
  // so it's very valuable as it reflects what they bought clearly.
  if (info.subscription == "no") {
    const days = getDays(info);
    return `${days} Day Quota`;
  }
  const interval = info.subscription == "monthly" ? "Monthly" : "Yearly";
  return `${interval} Quota Subscription`;
}
