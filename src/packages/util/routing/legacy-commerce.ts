/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NavigatePath } from "@cocalc/util/types/settings";

const BILLING_ROUTE_ALIASES: Record<string, NavigatePath> = {
  "": "settings/subscriptions",
  cards: "settings/payment-methods",
  "payment-methods": "settings/payment-methods",
  subscriptions: "settings/subscriptions",
  receipts: "settings/statements",
  "invoices-and-receipts": "settings/statements",
};

const STORE_ROUTE_ALIASES: Record<string, NavigatePath> = {
  "": "settings/store",
  membership: "settings/store",
  cart: "settings/store",
  checkout: "settings/store",
  processing: "settings/store",
  congrats: "settings/store",
  vouchers: "settings/store",
};

export function getLegacyCommerceTargetPath(
  input?: string,
): NavigatePath | undefined {
  if (!input) return undefined;
  const normalized = input.replace(/^\/+/, "").split(/[?#]/, 1)[0] ?? "";
  if (!normalized) return undefined;
  const [section = "", page = ""] = normalized.split("/");
  switch (section) {
    case "billing":
      return BILLING_ROUTE_ALIASES[page];
    case "store":
      return STORE_ROUTE_ALIASES[page];
    default:
      return undefined;
  }
}
