/*
 *  This file is part of CoCalc: Copyright © 2025-2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { account_exists } from "./basic";
import type { PostgreSQL } from "../types";

interface ChangeEmailAddressOptions {
  account_id: string;
  email_address: string;
  stripe: any;
}

/**
 * Change the email address for an account.
 *
 * Throws "email_already_taken" error (string) if the email is already in use.
 *
 * NOTE: Matches CoffeeScript behavior but fixes bug where undefined account
 * would crash when accessing stripe_customer_id.
 */
export async function changeEmailAddress(
  db: PostgreSQL,
  opts: ChangeEmailAddressOptions,
): Promise<void> {
  // Validate options
  const valid = db._validate_opts(opts);
  if (!valid) {
    throw new Error("Invalid options");
  }

  // Step 1: Check if email is already taken
  const exists = await account_exists(db, {
    email_address: opts.email_address,
  });

  if (exists) {
    // Match CoffeeScript behavior: throw string, not Error
    throw "email_already_taken";
  }

  // Step 2: Update email address in database
  await db.async_query({
    query: "UPDATE accounts",
    set: { email_address: opts.email_address },
    where: { "account_id = $::UUID": opts.account_id },
  });
}
