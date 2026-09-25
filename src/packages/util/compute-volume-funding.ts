/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { ComputeVmFundingSource } from "./compute-vm-funding";

// Public projection only. The volume owning bay and payer home authorize all
// mutations; attaching to a VM never changes this independent funding policy.
// createVolume.funding_source selects this volume's independent source.
// createVm.home_volume attaches without transferring payer or deletion policy.
// resizeVolume pins expected_funding_version and idempotency_key; added storage
// is reserved before growth. Protected storage cannot attach or grow. Personal
// extension requires separate approval, never setVolumeFundingMode.
// Public sources retain pool/grant identity but may redact the payer UUID.
export interface ComputeVolumeFundingStatus {
  source: ComputeVmFundingSource;
  payer_account_id?: string;
  label: string;
  state: string;
  funding_version: string;
  as_of: string;
  lane?: "prepaid" | "postpaid";
  spent_usd?: string;
  committed_usd?: string;
  remaining_usd?: string;
  protected_storage_usd?: string;
  authorized_until?: string;
  stop_at?: string;
  storage_delete_at?: string;
}

export const SPONSORED_VOLUME_UNSUPPORTED =
  "Course-funded home volumes are unavailable on this server. No personal funding fallback is permitted.";

export function requireSponsoredHomeVolumes(catalog: {
  sponsored_home_volumes?: boolean;
}): void {
  if (catalog.sponsored_home_volumes !== true)
    throw Error(SPONSORED_VOLUME_UNSUPPORTED);
}

export function requireVolumeFundingVersion(
  funding: ComputeVolumeFundingStatus | undefined,
  now = Date.now(),
): string {
  const asOf = Date.parse(funding?.as_of ?? "");
  const until = Date.parse(funding?.authorized_until ?? "");
  const stopAt = funding?.stop_at;
  const source = funding?.source;
  const version = funding?.funding_version;
  if (
    !version ||
    version.length > 512 ||
    /[\r\n\0]/.test(version) ||
    !Number.isFinite(asOf) ||
    asOf > now + 5_000 ||
    now - asOf > 45_000 ||
    !Number.isFinite(until) ||
    until <= now ||
    (stopAt != null &&
      (!Number.isFinite(Date.parse(stopAt)) || Date.parse(stopAt) <= now)) ||
    !["running", "active", "ready"].includes(funding?.state ?? "") ||
    !(source?.kind === "course"
      ? source.pool_id && source.grant_id
      : source?.kind === "personal" && source.consent_id)
  )
    throw Error(
      "Volume funding is unavailable or out of date. Reload its funding status before attaching or enlarging it.",
    );
  return version;
}
