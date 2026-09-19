/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { v4 } from "uuid";
import getPool from "@cocalc/database/pool";
import { expireTime } from "@cocalc/database/pool/util";
import { createInterBayAccountDirectoryClient } from "@cocalc/conat/inter-bay/api";
import {
  getConfiguredClusterRole,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import {
  getClusterAccountByEmailDirect,
  getClusterAccountByIdDirect,
  getFinancialApprovalIdentityDirect,
} from "@cocalc/server/accounts/cluster-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

let bindingSchemaReady: Promise<void> | undefined;

async function ensurePasswordResetBindingSchema(): Promise<void> {
  bindingSchemaReady ??= getPool()
    .query(
      `
      ALTER TABLE password_reset
        ADD COLUMN IF NOT EXISTS account_id UUID,
        ADD COLUMN IF NOT EXISTS identity_generation BIGINT
    `,
    )
    .then(() => undefined)
    .catch((err) => {
      bindingSchemaReady = undefined;
      throw err;
    });
  await bindingSchemaReady;
}

// Returns number of "recent" attempts to reset the password with this
// email from this ip address. By "recent" we mean, "in the last 10 minutes".
export async function recentAttemptsLocal(
  email_address: string,
  ip_address: string,
): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `
      SELECT GREATEST(
        COUNT(*) FILTER (WHERE email_address=$1)::INT,
        COUNT(*) FILTER (WHERE ip_address=$2::INET)::INT
      ) AS count
        FROM password_reset_attempts
       WHERE time >= NOW() - INTERVAL '10 min'
         AND (email_address=$1 OR ip_address=$2::INET)
    `,
    [email_address, ip_address],
  );
  return rows[0].count;
}

export async function recentAttempts(
  email_address: string,
  ip_address: string,
): Promise<number> {
  if (isMultiBayCluster() && getConfiguredClusterRole() === "attached") {
    return (
      await createInterBayAccountDirectoryClient({
        client: getInterBayFabricClient(),
      }).recentPasswordResetAttempts({
        email_address,
        ip_address,
      })
    ).count;
  }
  return await recentAttemptsLocal(email_address, ip_address);
}

export async function createResetLocal(
  email_address: string,
  ip_address: string,
  ttl_s: number,
): Promise<string> {
  const pool = getPool();
  const email = `${email_address ?? ""}`.trim().toLowerCase();
  const account = await getClusterAccountByEmailDirect(email);
  if (!account?.account_id) {
    throw Error("Account not found.");
  }
  const identity = await getFinancialApprovalIdentityDirect({
    account_id: account.account_id,
    email_address: email,
  });

  await ensurePasswordResetBindingSchema();

  // Record that there was an attempt:
  if (ip_address) {
    await pool.query(
      "INSERT INTO password_reset_attempts(id, email_address,ip_address,time,expire) VALUES($1::UUID,$2::TEXT,$3,NOW(),NOW() + INTERVAL '1 day')",
      [v4(), email, ip_address],
    );
  }

  // Create the expiring password reset token:
  const id = v4();
  await pool.query(
    `INSERT INTO password_reset
       (id,email_address,account_id,identity_generation,expire)
     VALUES($1::UUID,$2::TEXT,$3::UUID,$4::BIGINT,$5::TIMESTAMP)`,
    [id, email, account.account_id, identity.generation, expireTime(ttl_s)],
  );

  return id;
}

export async function createReset(
  email_address: string,
  ip_address: string,
  ttl_s: number,
): Promise<string> {
  if (isMultiBayCluster() && getConfiguredClusterRole() === "attached") {
    return (
      await createInterBayAccountDirectoryClient({
        client: getInterBayFabricClient(),
      }).createPasswordReset({
        email_address,
        ip_address,
        ttl_s,
      })
    ).id;
  }
  return await createResetLocal(email_address, ip_address, ttl_s);
}

export async function redeemResetLocal(password_reset_id: string): Promise<{
  email_address: string;
  account_id: string;
}> {
  const pool = getPool();
  await ensurePasswordResetBindingSchema();
  const { rows } = await pool.query(
    `
      WITH valid AS (
        SELECT reset.id
          FROM password_reset reset
          JOIN financial_approval_identities identity
            ON identity.account_id=reset.account_id
           AND identity.email_address=reset.email_address
           AND identity.generation=reset.identity_generation
         WHERE reset.id=$1::UUID
           AND reset.account_id IS NOT NULL
           AND reset.identity_generation IS NOT NULL
           AND reset.expire > NOW()
         FOR UPDATE OF reset
         FOR SHARE OF identity
      )
      UPDATE password_reset reset
         SET expire=NOW()
        FROM valid
       WHERE reset.id=valid.id
       RETURNING reset.email_address, reset.account_id
    `,
    [password_reset_id],
  );
  if (rows.length == 0) {
    throw Error("Password reset no longer valid.");
  }
  const email_address = `${rows[0].email_address ?? ""}`.trim().toLowerCase();
  const account_id = `${rows[0].account_id ?? ""}`.trim();
  if (!account_id) {
    throw Error("Password reset no longer valid.");
  }
  return { email_address, account_id };
}

export async function redeemReset(password_reset_id: string): Promise<{
  email_address: string;
  account_id: string;
  home_bay_id?: string | null;
}> {
  if (isMultiBayCluster() && getConfiguredClusterRole() === "attached") {
    return await createInterBayAccountDirectoryClient({
      client: getInterBayFabricClient(),
    }).redeemPasswordReset({ password_reset_id });
  }
  const { email_address, account_id } =
    await redeemResetLocal(password_reset_id);
  const account = await getClusterAccountByIdDirect(account_id);
  if (
    !account?.account_id ||
    `${account.email_address ?? ""}`.trim().toLowerCase() !== email_address
  ) {
    throw Error("Password reset no longer valid.");
  }
  return {
    email_address,
    account_id,
    home_bay_id: account.home_bay_id ?? null,
  };
}
