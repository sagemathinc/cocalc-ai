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
import { getClusterAccountByEmail } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

// Returns number of "recent" attempts to reset the password with this
// email from this ip address. By "recent" we mean, "in the last 10 minutes".
export async function recentAttemptsLocal(
  email_address: string,
  ip_address: string,
): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT COUNT(*)::INT FROM password_reset_attempts WHERE email_address=$1 AND ip_address=$2 AND time >= NOW() - INTERVAL '10 min'",
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

  // Record that there was an attempt:
  if (ip_address) {
    await pool.query(
      "INSERT INTO password_reset_attempts(id, email_address,ip_address,time,expire) VALUES($1::UUID,$2::TEXT,$3,NOW(),NOW() + INTERVAL '1 day')",
      [v4(), email_address, ip_address],
    );
  }

  // Create the expiring password reset token:
  const id = v4();
  await pool.query(
    "INSERT INTO password_reset(id,email_address,expire) VALUES($1::UUID,$2::TEXT,$3::TIMESTAMP)",
    [id, email_address, expireTime(ttl_s)],
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
}> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT email_address FROM password_reset WHERE expire > NOW() AND id=$1::UUID",
    [password_reset_id],
  );
  if (rows.length == 0) {
    throw Error("Password reset no longer valid.");
  }
  const email_address = `${rows[0].email_address ?? ""}`.trim().toLowerCase();
  await pool.query("UPDATE password_reset SET expire=NOW() WHERE id=$1::UUID", [
    password_reset_id,
  ]);
  return { email_address };
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
  const { email_address } = await redeemResetLocal(password_reset_id);
  const account = await getClusterAccountByEmail(email_address);
  const account_id = account?.account_id;
  if (!account_id) {
    throw Error("Password reset no longer valid.");
  }
  return {
    email_address,
    account_id,
    home_bay_id: account.home_bay_id ?? null,
  };
}
