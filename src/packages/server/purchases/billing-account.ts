/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import getPool from "@cocalc/database/pool";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { isValidUUID } from "@cocalc/util/misc";
import type { AutoBalanceConfig } from "@cocalc/util/db-schema/accounts";
import {
  USE_BALANCE_TOWARD_SUBSCRIPTIONS,
  USE_BALANCE_TOWARD_TEAM_LICENSES,
} from "@cocalc/util/db-schema/accounts";
import type { AccountLocalBillingPreferencesResult } from "@cocalc/conat/inter-bay/api";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import isAdminLocal from "@cocalc/server/accounts/is-admin";
import isValidAccountLocal from "@cocalc/server/accounts/is-valid-account";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { isBillingAuthorityEnabled } from "./billing-authority/config";

type Queryable = Pick<PoolClient, "query">;

export function billingAccountsTable(): "accounts" | "billing_accounts" {
  return centralBillingConfigured() ? "billing_accounts" : "accounts";
}

function centralBillingConfigured(): boolean {
  return multiBayConfigured() && isBillingAuthorityEnabled();
}

function multiBayConfigured(): boolean {
  // Some package-local tests provide a deliberately minimal cluster-config
  // mock. Treat an absent probe as the historical standalone topology.
  return (
    typeof isMultiBayCluster === "function" && isMultiBayCluster() === true
  );
}

export async function ensureBillingAccount(
  account_id: string,
  db: Queryable = getPool(),
): Promise<void> {
  if (!centralBillingConfigured()) return;
  if (!isValidUUID(account_id)) {
    throw Object.assign(new Error("invalid billing account id"), {
      code: 400,
      status: 400,
    });
  }
  const existing = await db.query(
    "SELECT 1 FROM billing_accounts WHERE account_id=$1",
    [account_id],
  );
  const account = await getClusterAccountById(account_id);
  if (!account && existing.rows.length === 0) {
    throw Object.assign(new Error("billing account does not exist"), {
      code: 404,
      status: 404,
    });
  }
  if (!account) return;
  // Preserve financial fields for accounts whose home is the seed. Attached
  // development bays are intentionally reset during this pre-production
  // cutover; no cross-database financial migration is supported or needed.
  await db.query(
    `INSERT INTO billing_accounts
       (account_id,home_bay_id,stripe_customer_id,stripe_customer,
        coupon_history,purchase_closing_day,balance,auto_balance,
        stripe_checkout_session,stripe_usage_subscription,monthly_collection,
        banned,banned_at,deleted,created_at,updated_at)
     SELECT account_id,$2,stripe_customer_id,stripe_customer,
            coupon_history,purchase_closing_day,balance,auto_balance,
            stripe_checkout_session,stripe_usage_subscription,
            monthly_collection,COALESCE(banned,FALSE),banned_at,
            COALESCE(deleted,FALSE),COALESCE(created,NOW()),clock_timestamp()
       FROM accounts
      WHERE account_id=$1
     ON CONFLICT (account_id) DO UPDATE
       SET home_bay_id=EXCLUDED.home_bay_id,
           banned=EXCLUDED.banned,
           banned_at=EXCLUDED.banned_at,
           deleted=EXCLUDED.deleted,
           updated_at=clock_timestamp()`,
    [account_id, account.home_bay_id],
  );
  await db.query(
    `INSERT INTO billing_accounts
       (account_id,home_bay_id,banned,deleted,created_at,updated_at)
     VALUES ($1,$2,$3,FALSE,clock_timestamp(),clock_timestamp())
     ON CONFLICT (account_id) DO UPDATE
       SET home_bay_id=EXCLUDED.home_bay_id,
           banned=EXCLUDED.banned,
           updated_at=clock_timestamp()`,
    [account_id, account.home_bay_id, account.banned === true],
  );
}

export async function ensureBillingAccounts(
  accountIds: string[],
): Promise<void> {
  if (!centralBillingConfigured()) return;
  for (const accountId of [...new Set(accountIds)]) {
    await ensureBillingAccount(accountId);
  }
}

export async function isValidBillingAccount(
  account_id: string,
  db?: Queryable,
): Promise<boolean> {
  if (!centralBillingConfigured()) {
    return await isValidAccountLocal(account_id, db as PoolClient | undefined);
  }
  if (!db) await ensureBillingAccount(account_id);
  const { rows } = await (db ?? getPool()).query(
    "SELECT 1 FROM billing_accounts WHERE account_id=$1",
    [account_id],
  );
  return rows.length > 0;
}

export async function isBillingAccountRestricted(
  account_id: string,
  db?: Queryable,
): Promise<boolean> {
  if (!centralBillingConfigured()) return false;
  if (!db) await ensureBillingAccount(account_id);
  const { rows } = await (db ?? getPool()).query<{
    banned: boolean;
    deleted: boolean;
  }>(`SELECT banned,deleted FROM billing_accounts WHERE account_id=$1`, [
    account_id,
  ]);
  return !rows[0] || rows[0].banned === true || rows[0].deleted === true;
}

export async function getBillingAccountProfile(account_id: string): Promise<{
  email_address?: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
}> {
  if (centralBillingConfigured()) {
    const account = await getClusterAccountById(account_id);
    if (!account) throw Error("billing account does not exist");
    return account;
  }
  const { rows } = await getPool().query(
    `SELECT email_address,display_name,first_name,last_name
       FROM accounts WHERE account_id=$1`,
    [account_id],
  );
  if (!rows[0]) throw Error("billing account does not exist");
  return rows[0];
}

export async function setBillingAutoBalance({
  account_id,
  auto_balance,
}: {
  account_id: string;
  auto_balance: AutoBalanceConfig;
}): Promise<void> {
  if (!centralBillingConfigured()) return;
  await ensureBillingAccount(account_id);
  const { rowCount } = await getPool().query(
    `UPDATE billing_accounts
        SET auto_balance=$2::JSONB, updated_at=clock_timestamp()
      WHERE account_id=$1`,
    [account_id, JSON.stringify(auto_balance)],
  );
  if (!rowCount) throw Error("no such billing account");
}

export async function updateBillingAccountLifecycle({
  account_id,
  home_bay_id,
  banned,
  deleted,
}: {
  account_id: string;
  home_bay_id?: string;
  banned?: boolean;
  deleted?: boolean;
}): Promise<void> {
  if (!centralBillingConfigured()) return;
  await ensureBillingAccount(account_id);
  await getPool().query(
    `UPDATE billing_accounts
        SET home_bay_id=COALESCE($2,home_bay_id),
            banned=COALESCE($3,banned),
            banned_at=CASE
              WHEN $3::BOOLEAN IS TRUE AND banned IS NOT TRUE
                THEN clock_timestamp()
              WHEN $3::BOOLEAN IS FALSE THEN NULL
              ELSE banned_at
            END,
            deleted=COALESCE($4,deleted),
            updated_at=clock_timestamp()
      WHERE account_id=$1`,
    [account_id, home_bay_id ?? null, banned ?? null, deleted ?? null],
  );
}

async function getLocalBillingPreferences(
  account_id: string,
): Promise<AccountLocalBillingPreferencesResult> {
  const { rows } = await getPool().query(
    `SELECT email_daily_statements,
            other_settings->>$2 AS use_balance_toward_subscriptions,
            other_settings->>$3 AS use_balance_toward_team_licenses
       FROM accounts
      WHERE account_id=$1 AND deleted IS NOT TRUE`,
    [
      account_id,
      USE_BALANCE_TOWARD_SUBSCRIPTIONS,
      USE_BALANCE_TOWARD_TEAM_LICENSES,
    ],
  );
  if (!rows[0]) throw Error("account not found");
  const optionalBoolean = (value: unknown): boolean | undefined =>
    value === "true" ? true : value === "false" ? false : undefined;
  return {
    email_daily_statements: rows[0].email_daily_statements === true,
    use_balance_toward_subscriptions: optionalBoolean(
      rows[0].use_balance_toward_subscriptions,
    ),
    use_balance_toward_team_licenses: optionalBoolean(
      rows[0].use_balance_toward_team_licenses,
    ),
  };
}

export async function getBillingAccountPreferences(
  account_id: string,
): Promise<AccountLocalBillingPreferencesResult> {
  if (!centralBillingConfigured())
    return await getLocalBillingPreferences(account_id);
  const account = await getClusterAccountById(account_id);
  if (!account) throw Error("account not found");
  const homeBayId = `${account.home_bay_id ?? ""}`.trim();
  if (!homeBayId) throw Error("account home bay is unavailable");
  if (homeBayId === getConfiguredBayId()) {
    return await getLocalBillingPreferences(account_id);
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  }).getBillingPreferences({ account_id });
}

export async function publishBillingAccountProjection({
  account_id,
  balance,
  balance_alert,
}: {
  account_id: string;
  balance?: number;
  balance_alert?: boolean;
}): Promise<void> {
  if (!centralBillingConfigured()) {
    if (typeof balance === "number" || typeof balance_alert === "boolean") {
      await getPool().query(
        `UPDATE accounts
            SET balance=COALESCE($2,balance),
                balance_alert=COALESCE($3,balance_alert)
          WHERE account_id=$1`,
        [
          account_id,
          typeof balance === "number" ? balance : null,
          typeof balance_alert === "boolean" ? balance_alert : null,
        ],
      );
    }
    return;
  }
  const account = await getClusterAccountById(account_id);
  if (!account) return;
  const homeBayId = `${account.home_bay_id ?? ""}`.trim();
  if (!homeBayId) return;
  if (homeBayId === getConfiguredBayId()) {
    if (typeof balance === "number" || typeof balance_alert === "boolean") {
      await getPool().query(
        `UPDATE accounts
            SET balance=COALESCE($2,balance),
                balance_alert=COALESCE($3,balance_alert)
          WHERE account_id=$1`,
        [
          account_id,
          typeof balance === "number" ? balance : null,
          typeof balance_alert === "boolean" ? balance_alert : null,
        ],
      );
    }
    return;
  }
  await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  }).setBillingProjection({ account_id, balance, balance_alert });
}

export async function isBillingAccountAdmin(
  account_id: string,
): Promise<boolean> {
  if (!centralBillingConfigured()) return await isAdminLocal(account_id);
  const account = await getClusterAccountById(account_id);
  const homeBayId = `${account?.home_bay_id ?? ""}`.trim();
  if (!homeBayId) return false;
  if (homeBayId === getConfiguredBayId()) return await isAdminLocal(account_id);
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  }).isAdmin({ account_id });
}

export async function requireBillingAccountDangerousAuth({
  account_id,
  browser_id,
  session_hash,
  require_second_factor = false,
  allow_actor_impersonation = true,
}: {
  account_id: string;
  browser_id?: string | null;
  session_hash?: string | null;
  require_second_factor?: boolean | "if_enabled";
  allow_actor_impersonation?: boolean;
}): Promise<void> {
  if (!centralBillingConfigured()) {
    await requireDangerousSessionAuth({
      account_id,
      browser_id,
      session_hash,
      require_second_factor,
      allow_actor_impersonation,
    });
    return;
  }
  const account = await getClusterAccountById(account_id);
  const homeBayId = `${account?.home_bay_id ?? ""}`.trim();
  if (!homeBayId) throw Error("account home bay is unavailable");
  if (homeBayId === getConfiguredBayId()) {
    await requireDangerousSessionAuth({
      account_id,
      browser_id,
      session_hash,
      require_second_factor,
      allow_actor_impersonation,
    });
    return;
  }
  await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  }).requireFreshAuth({
    account_id,
    browser_id,
    session_hash,
    require_second_factor,
    allow_actor_impersonation,
  });
}
