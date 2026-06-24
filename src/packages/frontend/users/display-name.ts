/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";

function userRecordField(user: any, key: string): string | null | undefined {
  const value = user?.get?.(key) ?? user?.[key];
  return value == null ? value : `${value}`;
}

export function displayNameFromUserRecord(user?: any): string {
  return displayNameFromAccount({
    display_name: userRecordField(user, "display_name"),
    first_name: userRecordField(user, "first_name"),
    last_name: userRecordField(user, "last_name"),
  });
}
