/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { publishAccountRowFeedEventsBestEffort } from "@cocalc/server/account/account-row-feed";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { updateClusterAccountEmailAddressVerified } from "@cocalc/server/inter-bay/account-directory-updates";

export interface AdminVerifyEmailAddressResult {
  account_id: string;
  already_verified: boolean;
  email_address: string;
  verified_at: Date;
}

export default async function adminVerifyEmailAddress({
  account_id,
}: {
  account_id: string;
}): Promise<AdminVerifyEmailAddressResult> {
  const result = await withAccountRehomeWriteFence({
    account_id,
    action: "admin verify email address",
    fn: async (db) => {
      const { rows } = await db.query(
        "SELECT email_address, email_address_verified FROM accounts WHERE account_id=$1",
        [account_id],
      );
      if (rows.length === 0) {
        throw Error("no such account");
      }
      const email_address = `${rows[0].email_address ?? ""}`
        .trim()
        .toLowerCase();
      if (!email_address) {
        throw Error("account does not have an email address");
      }

      const current = rows[0].email_address_verified ?? {};
      const already_verified = current[email_address] != null;
      const verified_at = already_verified
        ? new Date(current[email_address])
        : new Date();
      const next = {
        ...current,
        [email_address]: verified_at,
      };

      if (!already_verified) {
        await db.query(
          "UPDATE accounts SET email_address_verified=$1::JSONB WHERE account_id=$2",
          [next, account_id],
        );
      }
      return {
        account_id,
        already_verified,
        email_address,
        email_address_verified: next,
        verified_at,
      };
    },
  });

  await updateClusterAccountEmailAddressVerified({
    account_id,
    email_address_verified: true,
  });

  if (!result.already_verified) {
    await publishAccountRowFeedEventsBestEffort({
      account_id,
      patch: {
        email_address_verified: result.email_address_verified,
      },
    });
  }

  return {
    account_id: result.account_id,
    already_verified: result.already_verified,
    email_address: result.email_address,
    verified_at: result.verified_at,
  };
}
