/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import isAdmin from "@cocalc/server/accounts/is-admin";

export type ProductAccessTrustReason =
  | "admin"
  | "email_not_required"
  | "email_verified"
  | "registration_token";

export type ProductAccessTrustResult =
  | {
      trusted: true;
      reason: ProductAccessTrustReason;
    }
  | {
      trusted: false;
      reason: "account_not_found" | "email_unverified";
      email_address?: string;
    };

export class ProductAccessTrustError extends Error {
  code = "email_verification_required";
  constructor(message: string) {
    super(message);
    this.name = "ProductAccessTrustError";
  }
}

async function emailVerificationRequired(): Promise<boolean> {
  const settings = await getServerSettings();
  return (
    settings.verify_emails === true &&
    settings.email_enabled === true &&
    `${settings.email_backend ?? ""}`.trim() !== "none"
  );
}

function emailIsVerified({
  email_address,
  email_address_verified,
}: {
  email_address?: string | null;
  email_address_verified?: Record<string, unknown> | null;
}): boolean {
  const email = `${email_address ?? ""}`.trim().toLowerCase();
  if (!email || email_address_verified == null) return false;
  return email_address_verified[email] != null;
}

export async function getAccountProductAccessTrust(
  account_id: string,
): Promise<ProductAccessTrustResult> {
  if (!(await emailVerificationRequired())) {
    return { trusted: true, reason: "email_not_required" };
  }
  if (await isAdmin(account_id)) {
    return { trusted: true, reason: "admin" };
  }
  const { rows } = await getPool().query<{
    email_address: string | null;
    email_address_verified: Record<string, unknown> | null;
    trusted_product_access: boolean | null;
    trusted_product_access_reason: string | null;
  }>(
    `SELECT email_address, email_address_verified,
            trusted_product_access, trusted_product_access_reason
       FROM accounts
      WHERE account_id=$1 AND deleted IS NOT TRUE
      LIMIT 1`,
    [account_id],
  );
  const account = rows[0];
  if (!account) {
    return { trusted: false, reason: "account_not_found" };
  }
  if (
    account.trusted_product_access === true &&
    account.trusted_product_access_reason === "registration_token"
  ) {
    return { trusted: true, reason: "registration_token" };
  }
  if (emailIsVerified(account)) {
    return { trusted: true, reason: "email_verified" };
  }
  return {
    trusted: false,
    reason: "email_unverified",
    email_address: account.email_address ?? undefined,
  };
}

export async function assertAccountTrustedForProductAccess(
  account_id: string,
  action = "use this feature",
): Promise<void> {
  const trust = await getAccountProductAccessTrust(account_id);
  if (trust.trusted) return;
  if (trust.reason === "account_not_found") {
    throw new Error("account not found");
  }
  throw new ProductAccessTrustError(
    `Verify your email address before you ${action}.`,
  );
}
