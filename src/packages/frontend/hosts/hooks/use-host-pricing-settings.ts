import { useMemo, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { DedicatedHostSurchargeSettings } from "@cocalc/util/project-host-pricing";

export function useHostPricingSettings(): DedicatedHostSurchargeSettings {
  const gcp = useTypedRedux("customize", "project_hosts_gcp_surcharge_percent");
  const nebius = useTypedRedux(
    "customize",
    "project_hosts_nebius_surcharge_percent",
  );
  return useMemo(
    () => ({
      project_hosts_gcp_surcharge_percent: gcp,
      project_hosts_nebius_surcharge_percent: nebius,
    }),
    [gcp, nebius],
  );
}
