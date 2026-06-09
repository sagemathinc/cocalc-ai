/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface StripeBillingConfiguration {
  stripe_publishable_key?: string | null;
  stripe_secret_key?: string | null;
}

export function hasStripeBillingConfiguration({
  stripe_publishable_key,
  stripe_secret_key,
}: StripeBillingConfiguration): boolean {
  return (
    `${stripe_publishable_key ?? ""}`.trim().length > 0 &&
    `${stripe_secret_key ?? ""}`.trim().length > 0
  );
}
