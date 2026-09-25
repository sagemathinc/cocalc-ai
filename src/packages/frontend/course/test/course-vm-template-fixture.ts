import type { ComputeCatalog } from "@cocalc/conat/hub/api/compute";
import type { CourseVmTemplate } from "@cocalc/util/course-vm-template";

export const template: CourseVmTemplate = {
  id: "notebook-cpu",
  label: "Notebook CPU",
  description: "Weekly notebook exercises",
  config: {
    provider: "gcp",
    operating_system: "linux",
    architecture: "x86_64",
    region: "us-west1",
    zone: "us-west1-a",
    machine_type: "e2-standard-2",
    gpu_count: 0,
    pricing_model: "on_demand",
    boot_disk_gb: 20,
  },
};
export const catalog: ComputeCatalog = {
  providers: ["gcp"],
  provider_catalogs: {
    gcp: {
      provider: "gcp",
      provider_capabilities: {},
      entries: [
        {
          kind: "regions",
          scope: "global",
          payload: [{ name: "us-west1", zones: ["us-west1-a"] }],
        },
        {
          kind: "zones",
          scope: "global",
          payload: [{ name: "us-west1-a", region: "us-west1" }],
        },
        {
          kind: "machine_types",
          scope: "zone/us-west1-a",
          payload: [
            { name: "e2-standard-2", guestCpus: 2, memoryMb: 8192 },
            { name: "e2-standard-4", guestCpus: 4, memoryMb: 16384 },
          ],
        },
        {
          kind: "prices",
          scope: "global",
          payload: {
            fetched_at: new Date().toISOString(),
            service_id: "compute",
            families: {
              e2: {
                cpu: { "us-west1": 0.02 },
                ram: { "us-west1": 0.003 },
                spot_cpu: {},
                spot_ram: {},
              },
            },
            gpus: {},
            disks: { "pd-balanced": { "us-west1": 0.0001 } },
          },
        },
      ],
    },
  },
  funding_modes: [
    { value: "account-prepaid", label: "Prepaid", allowed: true },
  ],
  default_funding_mode: "account-prepaid",
  operating_systems: [
    {
      value: "linux",
      label: "Linux",
      providers: ["gcp"],
      architectures: ["x86_64", "arm64"],
      versions: [],
      minimum_boot_disk_gb: 10,
      license_per_vcpu_hourly_usd: "0",
    },
  ],
  defaults: { ...template.config, zone: "us-west1-a" },
  limits: {
    max_active_per_account: 10,
    max_ttl_minutes: 525600,
    max_boot_disk_gb: 1000,
    max_volume_gb: 1000,
  },
};
