import type { ComputeCatalog } from "@cocalc/conat/hub/api/compute";
import type { CourseVmTemplateConfig } from "@cocalc/util/course-vm-template";
import {
  gcpMachineArchitecture,
  gcpMachineGpu,
  gcpMinimumBootDiskGb,
} from "@cocalc/util/project-host-pricing";
import {
  getProviderOptions,
  getProviderPriceEstimate,
  getNebiusPlacementOptions,
  getNebiusMinimumBootDiskGb,
} from "@cocalc/frontend/hosts/providers/registry";
import type {
  HostFieldOption,
  ProviderSelection,
} from "@cocalc/frontend/hosts/providers/registry";

export function templateOptionAvailable(option: HostFieldOption): boolean {
  return (
    !option.disabled &&
    (option.meta as { compatible?: boolean } | undefined)?.compatible !== false
  );
}

export function templateSelection(
  config: Partial<CourseVmTemplateConfig>,
  fundingMode = "account-prepaid",
  pricingSettings?: ProviderSelection["pricing_settings"],
): ProviderSelection {
  return {
    ...config,
    storage_mode: "persistent",
    disk_type: config.provider === "nebius" ? "ssd" : "balanced",
    disk_gb: config.boot_disk_gb,
    funding_mode: fundingMode,
    pricing_settings: pricingSettings,
    price_display: "hourly",
  };
}

export function templateMachineChoices(
  catalog: ComputeCatalog,
  config: Partial<CourseVmTemplateConfig>,
): Array<{ value: string; label: string; config: CourseVmTemplateConfig }> {
  const provider = config.provider ?? "gcp";
  if (!catalog.providers.includes(provider)) return [];
  const host = catalog.provider_catalogs[provider];
  const selection = templateSelection(config);
  if (provider === "nebius") {
    return (["gpu", "cpu"] as const)
      .flatMap((kind) => getNebiusPlacementOptions(host, selection, kind))
      .filter((option) => !config.region || option.region === config.region)
      .map((option) => ({
        value: option.key,
        label: `${option.platformLabel}: ${option.machineType} (${option.region})`,
        config: {
          provider,
          operating_system: "linux",
          architecture: "x86_64",
          region: option.region,
          machine_type: option.machineType,
          provider_platform: option.platform,
          gpu_type: option.gpuLabel,
          gpu_count: option.gpuCount,
          pricing_model: config.pricing_model ?? "on_demand",
          boot_disk_gb: Math.max(
            config.boot_disk_gb ?? 40,
            getNebiusMinimumBootDiskGb(host, {
              ...selection,
              region: option.region,
              machine_type: option.machineType,
            }),
          ),
        } satisfies CourseVmTemplateConfig,
      }));
  }
  return (
    getProviderOptions(provider, host, {
      ...selection,
      machine_type: undefined,
    }).machine_type ?? []
  )
    .filter(
      (option) =>
        templateOptionAvailable(option) &&
        gcpMachineArchitecture(option.value) ===
          (config.architecture ?? "x86_64") &&
        (config.operating_system !== "windows" || !gcpMachineGpu(option.value)),
    )
    .map((option) => {
      const gpu = gcpMachineGpu(option.value);
      return {
        value: option.value,
        label: option.label,
        config: {
          provider,
          operating_system: config.operating_system ?? "linux",
          architecture: config.architecture ?? "x86_64",
          region: config.region ?? "",
          zone: config.zone,
          machine_type: option.value,
          gpu_type: gpu?.type,
          gpu_count: gpu?.count ?? 0,
          pricing_model: config.pricing_model ?? "on_demand",
          boot_disk_gb: Math.max(
            config.boot_disk_gb ?? 20,
            config.operating_system === "windows"
              ? 50
              : gcpMinimumBootDiskGb(option.value),
          ),
        } satisfies CourseVmTemplateConfig,
      };
    });
}

export function quoteCourseVmTemplate(
  catalog: ComputeCatalog,
  config: CourseVmTemplateConfig,
  fundingMode?: string,
  pricingSettings?: ProviderSelection["pricing_settings"],
) {
  const selection = templateSelection(config, fundingMode, pricingSettings);
  const host = catalog.provider_catalogs[config.provider];
  const choices = templateMachineChoices(catalog, config);
  const machine = choices.find(
    (option) =>
      option.config.machine_type === config.machine_type &&
      option.config.region === config.region &&
      option.config.provider_platform === config.provider_platform &&
      option.config.gpu_count === config.gpu_count,
  );
  const options = getProviderOptions(config.provider, host, {
    ...selection,
    machine_type: undefined,
  });
  const available =
    !!machine &&
    catalog.operating_systems.some(
      (os) =>
        os.value === config.operating_system &&
        os.providers.includes(config.provider) &&
        os.architectures.includes(config.architecture),
    ) &&
    machine.config.operating_system === config.operating_system &&
    machine.config.architecture === config.architecture &&
    machine.config.gpu_type === config.gpu_type &&
    (options.region ?? []).some(
      (option) =>
        option.value === config.region && templateOptionAvailable(option),
    ) &&
    (!config.zone ||
      (options.zone ?? []).some(
        (option) =>
          option.value === config.zone && templateOptionAvailable(option),
      )) &&
    config.boot_disk_gb >= (machine?.config.boot_disk_gb ?? 0) &&
    config.boot_disk_gb <= catalog.limits.max_boot_disk_gb;
  const price = available
    ? getProviderPriceEstimate(
        config.provider,
        host,
        selection,
        pricingSettings,
      )
    : undefined;
  let alternatives = choices.filter((option) => option !== machine);
  if (!available && !alternatives.length) {
    if (config.provider === "nebius") {
      alternatives = templateMachineChoices(catalog, {
        ...config,
        region: undefined,
      });
    } else {
      // Check a bounded set of nearby placements, then CPU alternatives when a
      // GPU family disappears. These remain explicit, freshly quoted choices.
      for (const gpu_type of [...new Set([config.gpu_type, undefined])]) {
        const base = {
          ...config,
          machine_type: undefined,
          region: undefined,
          zone: undefined,
          gpu_type,
        };
        const regions = (
          getProviderOptions("gcp", host, templateSelection(base)).region ?? []
        ).filter(templateOptionAvailable);
        regions.sort(
          (a, b) =>
            Number(b.value === config.region) -
            Number(a.value === config.region),
        );
        for (const region of regions.slice(0, 3)) {
          const regional = { ...base, region: region.value };
          const zones = (
            getProviderOptions("gcp", host, templateSelection(regional)).zone ??
            []
          ).filter(templateOptionAvailable);
          const zone =
            zones.find((item) => item.value === config.zone)?.value ??
            zones[0]?.value;
          alternatives.push(
            ...templateMachineChoices(catalog, { ...regional, zone }),
          );
          if (alternatives.length >= 5) break;
        }
        if (alternatives.length) break;
      }
    }
  }
  return { available, price, alternatives: alternatives.slice(0, 5) };
}

// Explicitly clear obsolete hardware fields without importing any financial,
// identity, SSH, attachment or deadline fields into the VM form.
export function templateHardwarePatch(
  config: CourseVmTemplateConfig,
): CourseVmTemplateConfig {
  return {
    provider: config.provider,
    operating_system: config.operating_system,
    architecture: config.architecture,
    region: config.region,
    zone: config.zone,
    machine_type: config.machine_type,
    provider_platform: config.provider_platform,
    gpu_type: config.gpu_type,
    gpu_count: config.gpu_count,
    pricing_model: config.pricing_model,
    boot_disk_gb: config.boot_disk_gb,
  };
}
