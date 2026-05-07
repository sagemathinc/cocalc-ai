/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { lite } from "@cocalc/frontend/lite";
import ApiKeys from "./settings/api-keys";
import GlobalSSHKeys from "./ssh-keys/global-ssh-keys";

import type { IconName } from "@cocalc/frontend/components/icon";

// Icon constant for account preferences section
export const KEYS_ICON_NAME: IconName = "key";

export function AccountPreferencesSecurity() {
  return (
    <>
      {!lite && <GlobalSSHKeys />}
      <ApiKeys />
    </>
  );
}
