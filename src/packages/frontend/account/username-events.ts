/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { AccountUsername } from "@cocalc/conat/hub/api/personal-urls";

export const USERNAME_CHANGED_EVENT = "cocalc:username-changed";
export type UsernameChangedDetail = Pick<
  AccountUsername,
  "account_id" | "username"
>;

export function dispatchUsernameChanged(detail: UsernameChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<UsernameChangedDetail>(USERNAME_CHANGED_EVENT, {
      detail: { account_id: detail.account_id, username: detail.username },
    }),
  );
}
