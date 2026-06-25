/*
Create account.  Doesn't do any checking that server allows
for this type of account, etc. -- that is assumed to have been
done before calling this.
*/

import getPool from "@cocalc/database/pool";
import passwordHash from "@cocalc/backend/auth/password-hash";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  displayNameFromParts,
  normalizeDisplayName,
} from "@cocalc/util/accounts/display-name";

const log = getLogger("server:accounts:create");

interface Params {
  email?: string;
  password?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  account_id: string;
  tags?: string[];
  signupReason?: string;
  owner_id?: string;
  home_bay_id?: string;
  ephemeral?: number;
  customize?: any;
  other_settings?: Record<string, unknown>;
  trusted_product_access?: boolean;
  trusted_product_access_reason?: string;
}

export default async function createAccount({
  email,
  password,
  displayName,
  firstName,
  lastName,
  account_id,
  tags,
  signupReason,
  owner_id,
  home_bay_id,
  ephemeral,
  customize,
  other_settings,
  trusted_product_access,
  trusted_product_access_reason,
}: Params): Promise<void> {
  if (!email) {
    throw Error("Email address is required for account creation.");
  }
  try {
    log.debug(
      "creating account",
      email,
      displayName,
      firstName,
      lastName,
      account_id,
      tags,
      signupReason,
    );
    const normalizedDisplayName =
      normalizeDisplayName(displayName) ||
      displayNameFromParts({ first_name: firstName, last_name: lastName }) ||
      "Anonymous User";
    const pool = getPool();
    await pool.query(
      "INSERT INTO accounts (email_address, password_hash, display_name, first_name, last_name, account_id, created, tags, sign_up_usage_intent, owner_id, ephemeral, customize, home_bay_id, other_settings, trusted_product_access, trusted_product_access_reason) VALUES($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT, $6::UUID, NOW(), $7::TEXT[], $8::TEXT, $9::UUID, $10::BIGINT, $11::JSONB, $12::TEXT, COALESCE($13::JSONB, '{}'::JSONB), $14::BOOL, $15::TEXT)",
      [
        email ? email : undefined, // can't insert "" more than once!
        password ? passwordHash(password) : undefined, // definitely don't set password_hash to hash of empty string, e.g., anonymous accounts can then NEVER switch to email/password.  This was a bug in production for a while.
        normalizedDisplayName,
        null,
        null,
        account_id,
        tags,
        signupReason,
        owner_id,
        ephemeral ?? null,
        customize ?? null,
        `${home_bay_id ?? ""}`.trim() || getConfiguredBayId(),
        other_settings ?? null,
        trusted_product_access === true,
        trusted_product_access === true
          ? `${trusted_product_access_reason ?? ""}`.trim() || null
          : null,
      ],
    );
  } catch (error) {
    log.error("Error creating account", error);
    throw error; // re-throw to bubble up to higher layers if needed
  }
}
