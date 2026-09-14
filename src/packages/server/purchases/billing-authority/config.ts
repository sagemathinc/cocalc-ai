/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const BILLING_AUTHORITY_ENABLE_ENV = "COCALC_BILLING_AUTHORITY_ENABLED";

export function isBillingAuthorityEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ["1", "true", "yes"].includes(
    `${env[BILLING_AUTHORITY_ENABLE_ENV] ?? ""}`.trim().toLowerCase(),
  );
}
