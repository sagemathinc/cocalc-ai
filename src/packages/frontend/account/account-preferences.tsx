/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useTypedRedux } from "@cocalc/frontend/app-framework";

import { AccountSettings } from "./settings/account-settings";
import TableError from "./table-error";

// Legacy component for backward compatibility - now just renders account settings
export const AccountPreferences: React.FC = () => {
  const account_id = useTypedRedux("account", "account_id");
  const display_name = useTypedRedux("account", "display_name");
  const first_name = useTypedRedux("account", "first_name");
  const last_name = useTypedRedux("account", "last_name");
  const email_address = useTypedRedux("account", "email_address");
  const email_address_verified = useTypedRedux(
    "account",
    "email_address_verified",
  );
  const passports = useTypedRedux("account", "passports");
  const created = useTypedRedux("account", "created");
  const strategies = useTypedRedux("account", "strategies");
  const unlisted = useTypedRedux("account", "unlisted");
  const email_enabled = useTypedRedux("customize", "email_enabled");
  const verify_emails = useTypedRedux("customize", "verify_emails");

  return (
    <div>
      <TableError />
      <AccountSettings
        account_id={account_id}
        display_name={display_name}
        first_name={first_name}
        last_name={last_name}
        email_address={email_address}
        email_address_verified={email_address_verified}
        passports={passports}
        email_enabled={email_enabled}
        verify_emails={verify_emails}
        created={created}
        strategies={strategies}
        unlisted={unlisted}
      />
    </div>
  );
};
