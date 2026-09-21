import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
} from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";

const CO_RESIDENT_ADVISORY_MODE = "co-resident-advisory";

export function isCoResidentFundingAdvisoryMode(): boolean {
  return process.env.COCALC_FUNDING_ROLLOUT_MODE === CO_RESIDENT_ADVISORY_MODE;
}

export function assertCoResidentFundingAdvisoryTopology(): void {
  if (!isCoResidentFundingAdvisoryMode()) return;
  const local = getConfiguredBayId();
  if (
    isMultiBayCluster() ||
    getConfiguredClusterBayCatalog().some((bay) => bay.bay_id !== local)
  ) {
    throw Error(
      "Co-resident advisory funding mode is limited to one-bay deployments.",
    );
  }
}
