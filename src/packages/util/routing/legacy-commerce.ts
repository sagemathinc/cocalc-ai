/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { NavigatePath } from "@cocalc/util/types/settings";

const BILLING_ROUTE_ALIASES: Record<string, NavigatePath> = {
  "": "settings/membership",
  cards: "settings/payment-methods",
  "payment-methods": "settings/payment-methods",
  subscriptions: "settings/membership",
  receipts: "settings/statements",
  "invoices-and-receipts": "settings/statements",
};

const STORE_ROUTE_ALIASES: Record<string, NavigatePath> = {
  "": "settings/membership",
  membership: "settings/membership",
  cart: "settings/membership",
  checkout: "settings/membership",
  processing: "settings/membership",
  congrats: "settings/membership",
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
