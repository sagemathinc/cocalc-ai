/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { is_valid_username } from "@cocalc/backend/misc";
import {
  displayNameFromParts,
  normalizeDisplayName,
} from "@cocalc/util/accounts/display-name";
import { lower_email_address, uuid } from "@cocalc/util/misc";

import { _passport_key } from "./passport-key";
import type { CreateSsoAccountOpts, PostgreSQL } from "../types";

export async function createSsoAccount(
  db: PostgreSQL,
  opts: CreateSsoAccountOpts,
): Promise<string> {
  const dbg = db._dbg(
    `create_sso_account(${opts.display_name}, ${opts.lti_id}, ${opts.email_address}, ${opts.passport_strategy}, ${opts.passport_id}), ${opts.usage_intent}`,
  );
  dbg();

  const display_name =
    normalizeDisplayName(opts.display_name) ||
    displayNameFromParts({
      first_name: opts.first_name,
      last_name: opts.last_name,
    }) ||
    "Anonymous User";

  const displayNameTest = is_valid_username(display_name);
  if (displayNameTest != null) {
    throw `display_name not valid: ${displayNameTest}`;
  }

  for (const name of ["first_name", "last_name"] as const) {
    const value = opts[name];
    if (value) {
      const test = is_valid_username(value);
      if (test != null) {
        throw `${name} not valid: ${test}`;
      }
    }
  }

  const email_address = opts.email_address
    ? lower_email_address(opts.email_address)
    : undefined;

  const account_id = uuid();

  let passport_key: string | undefined;
  if (opts.passport_strategy != null) {
    db._create_account_passport_keys ??= {};
    passport_key = _passport_key({
      strategy: opts.passport_strategy,
      id: opts.passport_id as string,
    });
    const last = db._create_account_passport_keys[passport_key];
    if (last && new Date().getTime() - last.getTime() <= 60 * 1000) {
      throw "recent attempt to make account with this passport strategy";
    }
    db._create_account_passport_keys[passport_key] = new Date();
  }

  try {
    if (opts.passport_strategy != null) {
      dbg(
        `verify that no account with passport (strategy='${opts.passport_strategy}', id='${opts.passport_id}') already exists`,
      );
      const existing = await db.passport_exists({
        strategy: opts.passport_strategy,
        id: opts.passport_id as string,
      });
      if (existing) {
        throw `account with email passport strategy '${opts.passport_strategy}' and id '${opts.passport_id}' already exists`;
      }
    }

    dbg("create the actual account");
    await db.async_query({
      query: "INSERT INTO accounts",
      values: {
        "account_id     :: UUID": account_id,
        "first_name     :: TEXT": null,
        "last_name      :: TEXT": null,
        "lti_id         :: TEXT[]": opts.lti_id,
        "created        :: TIMESTAMP": new Date(),
        "created_by     :: INET": opts.created_by,
        "password_hash  :: CHAR(173)": opts.password_hash,
        "email_address  :: TEXT": email_address,
        "sign_up_usage_intent :: TEXT": opts.usage_intent,
      },
    });
    await db.async_query({
      query: `
        UPDATE accounts
           SET display_name = $1::TEXT,
               first_name = NULL,
               last_name = NULL
         WHERE account_id = $2::UUID
      `,
      params: [display_name, account_id],
    });

    if (opts.passport_strategy != null) {
      dbg("add passport authentication strategy");
      await db.create_passport({
        account_id,
        strategy: opts.passport_strategy,
        id: opts.passport_id as string,
        profile: opts.passport_profile,
      });
    }

    dbg("successfully created account");
    return account_id;
  } catch (err) {
    dbg(`error creating account -- ${err}`);
    throw err;
  }
}
