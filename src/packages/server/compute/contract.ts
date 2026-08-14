/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ComputeVmRow, ComputeVolumeRow } from "./types";

// The v2 rollout intentionally leaves pre-v2 rows and provider resources
// untouched. These predicates are both contract checks and the migration
// boundary: inventory still sees legacy rows so orphan cleanup protects them.
export const COMPUTE_VM_V2_SQL = `
  public_hostname IS NOT NULL
  AND bootstrap_revision IS NOT NULL
  AND funding_mode IN ('site-funded', 'account-prepaid', 'account-postpaid')
`;

export const COMPUTE_VOLUME_V2_SQL = `
  role = 'home'
  AND funding_mode IN ('site-funded', 'account-prepaid', 'account-postpaid')
`;

export function isComputeVmV2(
  vm: Partial<ComputeVmRow> | undefined,
): vm is ComputeVmRow {
  return !!(
    vm?.public_hostname &&
    Number.isInteger(vm.bootstrap_revision) &&
    ["site-funded", "account-prepaid", "account-postpaid"].includes(
      `${vm.funding_mode ?? ""}`,
    )
  );
}

export function isComputeVolumeV2(
  volume: Partial<ComputeVolumeRow> | undefined,
): volume is ComputeVolumeRow {
  return !!(
    volume?.role === "home" &&
    ["site-funded", "account-prepaid", "account-postpaid"].includes(
      `${volume.funding_mode ?? ""}`,
    )
  );
}
