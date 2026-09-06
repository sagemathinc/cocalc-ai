import type { ComputeCatalog } from "@cocalc/conat/hub/api/compute";

// Form scaffolding only: never use this to authorize creation or quote prices.
// Empty inventories prevent presenting example machines as available capacity.
export const VM_PREVIEW_CATALOG: ComputeCatalog = {
  providers: [],
  provider_catalogs: {},
  funding_modes: [],
  default_funding_mode: "account-prepaid",
  operating_systems: [],
  defaults: {
    provider: "gcp",
    operating_system: "linux",
    architecture: "x86_64",
    region: "",
    zone: "",
    machine_type: "",
    boot_disk_gb: 20,
  },
  limits: {
    max_active_per_account: 0,
    max_ttl_minutes: 24 * 60,
    max_boot_disk_gb: 10_000,
    max_volume_gb: 10_000,
  },
};
