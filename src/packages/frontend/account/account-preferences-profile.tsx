/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { IconName } from "@cocalc/frontend/components/icon";

import { useTypedRedux } from "@cocalc/frontend/app-framework";

import { AvatarSettings } from "./avatar-settings";
import { SecuritySettings } from "./security-settings";
import { AccountSettings } from "./settings/account-settings";

// Icon constant for account preferences section
export const ACCOUNT_PROFILE_ICON_NAME: IconName = "address-card";

export const ACCOUNT_PREFERENCES_ICON_NAME: IconName = "cogs";

export function AccountPreferencesProfile() {
  const account_id = useTypedRedux("account", "account_id");
  const first_name = useTypedRedux("account", "first_name");
  const last_name = useTypedRedux("account", "last_name");
  const email_address = useTypedRedux("account", "email_address");
  const email_address_verified = useTypedRedux(
    "account",
    "email_address_verified",
  );
  const passports = useTypedRedux("account", "passports");
  const strategies = useTypedRedux("account", "strategies");
  const unlisted = useTypedRedux("account", "unlisted");
  const email_enabled = useTypedRedux("customize", "email_enabled");
  const verify_emails = useTypedRedux("customize", "verify_emails");

  return (
    <>
      <AccountSettings
        account_id={account_id}
        first_name={first_name}
        last_name={last_name}
        email_address={email_address}
        email_address_verified={email_address_verified}
        passports={passports}
        email_enabled={email_enabled}
        verify_emails={verify_emails}
        strategies={strategies}
        unlisted={unlisted}
      />
      <SecuritySettings
        email_address={email_address}
        first_name={first_name}
        last_name={last_name}
      />
      <AvatarSettings email_address={email_address} />
    </>
  );
}
