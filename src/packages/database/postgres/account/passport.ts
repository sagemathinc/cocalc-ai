/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "crypto";
import { to_json } from "@cocalc/util/misc";
import {
  set_account_info_if_different,
  set_account_info_if_not_set,
  set_email_address_verified,
} from "./queries";
import {
  CreatePassportOpts,
  PassportExistsOpts,
  PostgreSQL,
  UpdateAccountInfoAndPassportOpts,
} from "../types";
import { _passport_key } from "./passport-key";

function passportKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

async function logPassportLink(db: PostgreSQL, opts: CreatePassportOpts) {
  const key = _passport_key(opts);
  try {
    await (db.log({
      event: "sso_passport_linked",
      value: {
        account_id: opts.account_id,
        strategy: opts.strategy,
        passport_key_hash: passportKeyHash(key),
        email_domain: `${opts.email_address ?? ""}`
          .trim()
          .toLowerCase()
          .split("@")[1],
      },
    }) as any);
  } catch (err) {
    db._dbg("create_passport")(`failed to log passport link: ${err}`);
  }
}

export async function create_passport(
  db: PostgreSQL,
  opts: CreatePassportOpts,
): Promise<void> {
  const dbg = db._dbg("create_passport");
  dbg({ id: opts.id, strategy: opts.strategy, profile: to_json(opts.profile) });

  try {
    dbg("setting the passport for the account");
    await db.async_query({
      query: "UPDATE accounts",
      jsonb_set: {
        passports: { [_passport_key(opts)]: opts.profile },
      },
      where: {
        "account_id = $::UUID": opts.account_id,
      },
    });

    dbg(
      `setting other account info ${opts.account_id}: ${opts.email_address}, ${opts.first_name}, ${opts.last_name}`,
    );
    await set_account_info_if_not_set({
      db: db,
      account_id: opts.account_id,
      email_address: opts.email_address,
      first_name: opts.first_name,
      last_name: opts.last_name,
    });
    // we still record that email address as being verified
    if (opts.email_address != null) {
      await set_email_address_verified({
        db,
        account_id: opts.account_id,
        email_address: opts.email_address,
      });
    }
    await logPassportLink(db, opts);
    opts.cb?.(undefined); // all good
  } catch (err) {
    if (opts.cb != null) {
      opts.cb(err);
    } else {
      throw err;
    }
  }
}

export async function passport_exists(
  db: PostgreSQL,
  opts: PassportExistsOpts,
): Promise<string | undefined> {
  try {
    const result = await db.async_query({
      query: "SELECT account_id FROM accounts",
      where: [
        // this uses the corresponding index to only scan a subset of all accounts!
        "passports IS NOT NULL",
        { "(passports->>$::TEXT) IS NOT NULL": _passport_key(opts) },
      ],
    });
    const account_id = result?.rows[0]?.account_id;
    if (opts.cb != null) {
      opts.cb(null, account_id);
    } else {
      return account_id;
    }
  } catch (err) {
    if (opts.cb != null) {
      opts.cb(err);
    } else {
      throw err;
    }
  }
}

export async function update_account_and_passport(
  db: PostgreSQL,
  opts: UpdateAccountInfoAndPassportOpts,
) {
  // we deliberately do not update the email address, because if the SSO
  // strategy sends a different one, this would break the "link".
  // rather, if the email (and hence most likely the email address) changes on the
  // SSO side, this would equal to creating a new account.
  const dbg = db._dbg("update_account_and_passport");
  dbg(
    `updating account info ${to_json({
      first_name: opts.first_name,
      last_name: opts.last_name,
    })}`,
  );
  await set_account_info_if_different({
    db: db,
    account_id: opts.account_id,
    first_name: opts.first_name,
    last_name: opts.last_name,
  });
  const key = _passport_key(opts);
  dbg(`updating passport ${to_json({ key, profile: opts.profile })}`);
  await db.async_query({
    query: "UPDATE accounts",
    jsonb_set: {
      passports: { [key]: opts.profile },
    },
    where: {
      "account_id = $::UUID": opts.account_id,
    },
  });
}
