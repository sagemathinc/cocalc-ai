import type {
  Host,
  HostCatalog,
  HostFundingMode,
  HostInterruptionRestorePolicy,
  HostPricingModel,
  HostSpotRecoveryPolicy,
} from "@cocalc/conat/hub/api/hosts";
import type { R2Region } from "@cocalc/util/consts";
import { MIN_PROJECT_HOST_DISK_GB } from "@cocalc/util/project-host-limits";
import { getDiskTypeOptions } from "../constants";
import type { HostProvider } from "../types";
import {
  HOST_FIELDS,
  buildCreateHostPayload,
  getProviderDescriptor,
  getProviderOptions,
  getProviderStorageSupport,
  isNebiusSpotSupported,
  type FieldOptionsMap,
  type HostFieldId,
  type HostFieldOption,
  type ProviderSelection,
} from "../providers/registry";
import {
  activeSpotRecoveryPolicy,
  defaultRestorePolicy,
} from "../utils/spot-recovery-policy";
import {
  markRecommendedRegionOption,
  sortRegionOptionsByPreference,
} from "../utils/region-ranking";

export type HostCreatePresetId =
  | "balanced-cpu"
  | "low-cost-spot"
  | "gpu-workstation";

export type HostCreatePreset = {
  id: HostCreatePresetId;
  label: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
};

export type HostCreateDraft = {
  name: string;
  provider: HostProvider;
  funding_mode?: HostFundingMode;
  start_after_create: boolean;
  region_preference: "balanced" | "closest" | "cheapest";
  price_display: "hourly" | "monthly";
  pricing_model: HostPricingModel;
  interruption_restore_policy: HostInterruptionRestorePolicy;
  spot_recovery_policy?: HostSpotRecoveryPolicy;
  storage_mode: "persistent" | "ephemeral";
  disk_gb?: number;
  disk?: number;
  disk_type?: string;
  shared_disk_gb?: number;
  shared_disk_type?: string;
  region?: string;
  zone?: string;
  machine_type?: string;
  gpu_type?: string;
  size?: string;
  gpu?: string;
  self_host_kind?: string;
  self_host_mode?: string;
  self_host_ssh_target?: string;
  cpu?: number;
  ram_gb?: number;
  auto_grow_enabled?: boolean;
  auto_grow_max_disk_gb?: number;
  auto_grow_growth_step_gb?: number;
  auto_grow_min_grow_interval_minutes?: number;
  shared_scratch_auto_grow_enabled?: boolean;
  shared_scratch_auto_grow_max_disk_gb?: number;
  shared_scratch_auto_grow_growth_step_gb?: number;
  shared_scratch_auto_grow_min_grow_interval_minutes?: number;
};

export type HostCreateDraftContext = {
  enabledProviders: HostProvider[];
  catalogByProvider?: Partial<Record<HostProvider, HostCatalog | undefined>>;
  preferredRegion?: R2Region;
  billing?: {
    fundingModeOptions?: Array<{ value: HostFundingMode }>;
    defaultFundingMode?: HostFundingMode;
  };
};

export type NormalizedHostCreateDraft = {
  draft: HostCreateDraft;
  fieldOptions: FieldOptionsMap;
  activeFields: HostFieldId[];
};

const DEFAULT_NAME = "My host";
const DEFAULT_DISK_GB = 100;
const MIN_DISK_GB = MIN_PROJECT_HOST_DISK_GB;
const NEBIUS_DISK_INCREMENT_GB = 93;
const GCP_SHARED_SCRATCH_MIN_GB = 10;

const MANAGED_PROVIDERS = new Set<HostProvider>([
  "gcp",
  "hyperstack",
  "lambda",
  "nebius",
]);

const isManagedProvider = (provider: HostProvider) =>
  MANAGED_PROVIDERS.has(provider);

const firstEnabledProvider = (context: HostCreateDraftContext): HostProvider =>
  context.enabledProviders[0] ?? "none";

const isEnabledProvider = (
  provider: HostProvider | undefined,
  context: HostCreateDraftContext,
) => !!provider && context.enabledProviders.includes(provider);

const getCatalog = (provider: HostProvider, context: HostCreateDraftContext) =>
  context.catalogByProvider?.[provider];

const firstSelectableValue = (options?: HostFieldOption[]) =>
  options?.find((option) => !option.disabled)?.value ?? options?.[0]?.value;

const inOptions = (value: string | undefined, options?: HostFieldOption[]) =>
  value != null && options?.some((option) => option.value === value);

const readPositiveInteger = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

const defaultDiskTypeForProvider = (provider: HostProvider) =>
  provider === "nebius" ? "ssd_io_m3" : getDiskTypeOptions(provider)[0]?.value;

const defaultSharedDiskTypeForProvider = (provider: HostProvider) =>
  provider === "nebius" ? "ssd" : provider === "gcp" ? "balanced" : undefined;

const normalizeDiskSize = (provider: HostProvider, diskGb: unknown) => {
  const parsed = readPositiveInteger(diskGb) ?? DEFAULT_DISK_GB;
  const size = Math.max(MIN_DISK_GB, parsed);
  if (provider === "nebius") {
    return (
      Math.ceil(size / NEBIUS_DISK_INCREMENT_GB) * NEBIUS_DISK_INCREMENT_GB
    );
  }
  return size;
};

const normalizeSharedDiskSize = (provider: HostProvider, diskGb: unknown) => {
  const parsed = readPositiveInteger(diskGb);
  if (parsed == null) return undefined;
  const min = provider === "gcp" ? GCP_SHARED_SCRATCH_MIN_GB : 1;
  const size = Math.max(min, parsed);
  if (provider === "nebius") {
    return (
      Math.ceil(size / NEBIUS_DISK_INCREMENT_GB) * NEBIUS_DISK_INCREMENT_GB
    );
  }
  return size;
};

const getFieldOptions = (
  provider: HostProvider,
  draft: HostCreateDraft,
  context: HostCreateDraftContext,
) => {
  const options = getProviderOptions(provider, getCatalog(provider, context), {
    ...draft,
    price_display: draft.price_display,
  } satisfies ProviderSelection);
  const regionOptions = options.region ?? [];
  if (regionOptions.length <= 1) return options;
  return {
    ...options,
    region: markRecommendedRegionOption(
      sortRegionOptionsByPreference({
        options: regionOptions,
        preference: draft.region_preference,
        preferredRegion: context.preferredRegion,
      }),
    ),
  };
};

const similarName = (name: string | undefined): string => {
  const base = (name ?? DEFAULT_NAME).trim() || DEFAULT_NAME;
  return /\s+\(similar\)$/i.test(base) ? base : `${base} (similar)`;
};

const readAutoGrow = (host: Host) => {
  const metadata = (host.machine?.metadata ?? {}) as Record<string, any>;
  const nested = (metadata.auto_grow ?? {}) as Record<string, any>;
  return {
    enabled:
      nested.enabled ??
      (typeof metadata.auto_grow_enabled === "boolean"
        ? metadata.auto_grow_enabled
        : false),
    max_disk_gb: readPositiveInteger(
      nested.max_disk_gb ?? metadata.auto_grow_max_disk_gb,
    ),
    growth_step_gb: readPositiveInteger(
      nested.growth_step_gb ?? metadata.auto_grow_growth_step_gb,
    ),
    min_grow_interval_minutes: readPositiveInteger(
      nested.min_grow_interval_minutes ??
        metadata.auto_grow_min_grow_interval_minutes,
    ),
  };
};

const readSharedScratchAutoGrow = (host: Host) => {
  const metadata = (host.machine?.metadata ?? {}) as Record<string, any>;
  const nested = (metadata.shared_scratch_auto_grow ?? {}) as Record<
    string,
    any
  >;
  return {
    enabled:
      nested.enabled ??
      (typeof metadata.shared_scratch_auto_grow_enabled === "boolean"
        ? metadata.shared_scratch_auto_grow_enabled
        : false),
    max_disk_gb: readPositiveInteger(
      nested.max_disk_gb ?? metadata.shared_scratch_auto_grow_max_disk_gb,
    ),
    growth_step_gb: readPositiveInteger(
      nested.growth_step_gb ?? metadata.shared_scratch_auto_grow_growth_step_gb,
    ),
    min_grow_interval_minutes: readPositiveInteger(
      nested.min_grow_interval_minutes ??
        metadata.shared_scratch_auto_grow_min_grow_interval_minutes,
    ),
  };
};

export function buildDefaultDraft(
  context: HostCreateDraftContext,
): HostCreateDraft {
  return normalizeDraft(
    {
      name: DEFAULT_NAME,
      provider: firstEnabledProvider(context),
      start_after_create: true,
      region_preference: "cheapest",
      price_display: "hourly",
      pricing_model: "on_demand",
      interruption_restore_policy: defaultRestorePolicy("on_demand"),
      storage_mode: "persistent",
      disk_gb: DEFAULT_DISK_GB,
      disk: DEFAULT_DISK_GB,
    },
    context,
  ).draft;
}

export function buildSimilarDraft(
  host: Host,
  context: HostCreateDraftContext,
): HostCreateDraft {
  const hostProvider = host.machine?.cloud as HostProvider | undefined;
  const provider = isEnabledProvider(hostProvider, context)
    ? hostProvider
    : firstEnabledProvider(context);
  const disk = readPositiveInteger(host.machine?.disk_gb);
  const pricingModel = host.pricing_model ?? "on_demand";
  const interruptionRestorePolicy =
    host.interruption_restore_policy ?? defaultRestorePolicy(pricingModel);
  const autoGrow = readAutoGrow(host);
  const sharedScratchAutoGrow = readSharedScratchAutoGrow(host);
  return normalizeDraft(
    {
      name: similarName(host.name),
      provider,
      start_after_create: true,
      region_preference: "cheapest",
      price_display: "hourly",
      funding_mode: host.funding_mode,
      cpu: readPositiveInteger(host.machine?.metadata?.cpu),
      ram_gb: readPositiveInteger(host.machine?.metadata?.ram_gb),
      disk_gb: disk,
      disk,
      shared_disk_gb: readPositiveInteger(host.machine?.shared_disk_gb),
      shared_disk_type: host.machine?.shared_disk_type ?? undefined,
      region: host.region ?? undefined,
      zone: host.machine?.zone ?? undefined,
      machine_type: host.machine?.machine_type ?? undefined,
      gpu_type: host.machine?.gpu_type ?? "none",
      size: host.machine?.machine_type ?? host.size ?? undefined,
      storage_mode: host.machine?.storage_mode ?? "persistent",
      disk_type: host.machine?.disk_type ?? undefined,
      pricing_model: pricingModel,
      interruption_restore_policy: interruptionRestorePolicy,
      spot_recovery_policy: activeSpotRecoveryPolicy({
        pricingModel,
        interruptionRestorePolicy,
        spotRecoveryPolicy: host.spot_recovery_policy,
      }),
      self_host_ssh_target:
        host.machine?.metadata?.self_host_ssh_target ?? undefined,
      auto_grow_enabled: autoGrow.enabled,
      auto_grow_max_disk_gb: autoGrow.max_disk_gb,
      auto_grow_growth_step_gb: autoGrow.growth_step_gb,
      auto_grow_min_grow_interval_minutes: autoGrow.min_grow_interval_minutes,
      shared_scratch_auto_grow_enabled: sharedScratchAutoGrow.enabled,
      shared_scratch_auto_grow_max_disk_gb: sharedScratchAutoGrow.max_disk_gb,
      shared_scratch_auto_grow_growth_step_gb:
        sharedScratchAutoGrow.growth_step_gb,
      shared_scratch_auto_grow_min_grow_interval_minutes:
        sharedScratchAutoGrow.min_grow_interval_minutes,
    },
    context,
  ).draft;
}

export function normalizeDraft(
  input: Partial<HostCreateDraft>,
  context: HostCreateDraftContext,
): NormalizedHostCreateDraft {
  const provider = isEnabledProvider(input.provider, context)
    ? input.provider!
    : firstEnabledProvider(context);
  const descriptor = getProviderDescriptor(provider);
  const activeFields = [
    ...descriptor.fields.primary,
    ...descriptor.fields.advanced,
  ];
  let draft: HostCreateDraft = {
    name: (input.name ?? DEFAULT_NAME).trim() || DEFAULT_NAME,
    provider,
    funding_mode: input.funding_mode,
    start_after_create: input.start_after_create !== false,
    region_preference:
      input.region_preference === "balanced" ||
      input.region_preference === "closest" ||
      input.region_preference === "cheapest"
        ? input.region_preference
        : "cheapest",
    price_display: input.price_display === "monthly" ? "monthly" : "hourly",
    pricing_model: input.pricing_model === "spot" ? "spot" : "on_demand",
    interruption_restore_policy:
      input.interruption_restore_policy === "none" ? "none" : "immediate",
    spot_recovery_policy: input.spot_recovery_policy,
    storage_mode:
      input.storage_mode === "ephemeral" ? "ephemeral" : "persistent",
    disk_gb: readPositiveInteger(input.disk_gb ?? input.disk),
    disk: readPositiveInteger(input.disk ?? input.disk_gb),
    disk_type: input.disk_type,
    shared_disk_gb: readPositiveInteger(input.shared_disk_gb),
    shared_disk_type: input.shared_disk_type,
    region: input.region,
    zone: input.zone,
    machine_type: input.machine_type,
    gpu_type: input.gpu_type,
    size: input.size,
    gpu: input.gpu,
    self_host_kind: input.self_host_kind,
    self_host_mode: input.self_host_mode,
    self_host_ssh_target: input.self_host_ssh_target,
    cpu: readPositiveInteger(input.cpu),
    ram_gb: readPositiveInteger(input.ram_gb),
    auto_grow_enabled: input.auto_grow_enabled,
    auto_grow_max_disk_gb: readPositiveInteger(input.auto_grow_max_disk_gb),
    auto_grow_growth_step_gb: readPositiveInteger(
      input.auto_grow_growth_step_gb,
    ),
    auto_grow_min_grow_interval_minutes: readPositiveInteger(
      input.auto_grow_min_grow_interval_minutes,
    ),
    shared_scratch_auto_grow_enabled: input.shared_scratch_auto_grow_enabled,
    shared_scratch_auto_grow_max_disk_gb: readPositiveInteger(
      input.shared_scratch_auto_grow_max_disk_gb,
    ),
    shared_scratch_auto_grow_growth_step_gb: readPositiveInteger(
      input.shared_scratch_auto_grow_growth_step_gb,
    ),
    shared_scratch_auto_grow_min_grow_interval_minutes: readPositiveInteger(
      input.shared_scratch_auto_grow_min_grow_interval_minutes,
    ),
  };

  // Provider options are dependent: for example region can determine zones,
  // zone can determine machine types, and GPU choice can filter machines.
  // Recompute after each batch of fallback selections so those dependencies
  // converge without React effects or timeouts. In practice this stabilizes in
  // one or two passes; the third pass is a guard against longer chains.
  for (let i = 0; i < 3; i++) {
    const options = getFieldOptions(provider, draft, context);
    const updates: Partial<HostCreateDraft> = {};
    const active = new Set(activeFields);
    for (const field of HOST_FIELDS) {
      if (!active.has(field)) {
        updates[field] = undefined;
      }
    }
    for (const field of activeFields) {
      const current = draft[field];
      const fieldOptions = options[field];
      if (fieldOptions?.length && !inOptions(current, fieldOptions)) {
        updates[field] = firstSelectableValue(fieldOptions);
      }
    }
    if (Object.keys(updates).length === 0) break;
    draft = { ...draft, ...updates };
  }

  const fieldOptions = getFieldOptions(provider, draft, context);
  const storageSupport = getProviderStorageSupport(
    provider,
    getCatalog(provider, context)?.provider_capabilities,
  );
  if (!storageSupport.supported) {
    draft.storage_mode = "ephemeral";
    draft.disk_gb = undefined;
    draft.disk = undefined;
    draft.disk_type = undefined;
    draft.auto_grow_enabled = false;
    draft.auto_grow_max_disk_gb = undefined;
    draft.auto_grow_growth_step_gb = undefined;
    draft.auto_grow_min_grow_interval_minutes = undefined;
  } else {
    const diskTypeOptions = getDiskTypeOptions(provider);
    if (!draft.disk_type || !inOptions(draft.disk_type, diskTypeOptions)) {
      draft.disk_type = defaultDiskTypeForProvider(provider);
    }
    if (draft.storage_mode !== "ephemeral") {
      const diskGb = normalizeDiskSize(provider, draft.disk_gb);
      draft.disk_gb = diskGb;
      draft.disk = diskGb;
    }
  }

  if (
    provider !== "gcp" ||
    draft.storage_mode === "ephemeral" ||
    !storageSupport.growable
  ) {
    draft.auto_grow_enabled = false;
    draft.auto_grow_max_disk_gb = undefined;
    draft.auto_grow_growth_step_gb = undefined;
    draft.auto_grow_min_grow_interval_minutes = undefined;
  } else if (draft.auto_grow_enabled) {
    const diskGb = draft.disk_gb ?? draft.disk ?? DEFAULT_DISK_GB;
    draft.auto_grow_max_disk_gb = Math.max(
      readPositiveInteger(draft.auto_grow_max_disk_gb) ?? 500,
      diskGb,
    );
    draft.auto_grow_growth_step_gb =
      readPositiveInteger(draft.auto_grow_growth_step_gb) ?? 50;
    draft.auto_grow_min_grow_interval_minutes =
      readPositiveInteger(draft.auto_grow_min_grow_interval_minutes) ?? 60;
  }

  if (provider !== "nebius" && provider !== "gcp") {
    draft.shared_disk_gb = undefined;
    draft.shared_disk_type = undefined;
  }

  const sharedDiskType = draft.shared_disk_gb
    ? (draft.shared_disk_type ?? defaultSharedDiskTypeForProvider(provider))
    : undefined;
  draft.shared_disk_type = sharedDiskType;
  draft.shared_disk_gb = normalizeSharedDiskSize(
    provider,
    draft.shared_disk_gb,
  );
  if (!draft.shared_disk_gb) {
    draft.shared_scratch_auto_grow_enabled = false;
    draft.shared_scratch_auto_grow_max_disk_gb = undefined;
    draft.shared_scratch_auto_grow_growth_step_gb = undefined;
    draft.shared_scratch_auto_grow_min_grow_interval_minutes = undefined;
  }

  if (provider === "nebius") {
    const spotSupported = isNebiusSpotSupported(
      fieldOptions.machine_type,
      draft.machine_type,
    );
    if (!spotSupported && draft.pricing_model === "spot") {
      draft.pricing_model = "on_demand";
      draft.interruption_restore_policy = "none";
      draft.spot_recovery_policy = undefined;
    }
  }

  if (isManagedProvider(provider)) {
    const fundingOptions = context.billing?.fundingModeOptions ?? [];
    const hasFundingMode = fundingOptions.some(
      (option) => option.value === draft.funding_mode,
    );
    draft.funding_mode = hasFundingMode
      ? draft.funding_mode
      : (context.billing?.defaultFundingMode ?? fundingOptions[0]?.value);
  } else {
    draft.funding_mode = undefined;
  }

  if (
    draft.interruption_restore_policy ==
    defaultRestorePolicy(draft.pricing_model === "spot" ? "on_demand" : "spot")
  ) {
    draft.interruption_restore_policy = defaultRestorePolicy(
      draft.pricing_model,
    );
  }

  return { draft, fieldOptions, activeFields };
}

const optionLooksGpu = (option: HostFieldOption) => {
  const meta = (option.meta ?? {}) as Record<string, any>;
  return (
    (typeof meta.gpus === "number" && meta.gpus > 0) ||
    (typeof meta.gpu_count === "number" && meta.gpu_count > 0) ||
    (typeof meta.gpu === "string" && meta.gpu !== "none") ||
    /gpu|nvidia|rtx|a10|a40|a100|h100|h200|b200|b300|l4/i.test(
      `${option.value} ${option.label}`,
    )
  );
};

const optionRamGiB = (option: HostFieldOption): number | undefined => {
  const meta = (option.meta ?? {}) as Record<string, any>;
  const value =
    meta.memory_gib ??
    meta.ram_gb ??
    meta.ram ??
    (meta.memoryMb != null ? Number(meta.memoryMb) / 1024 : undefined);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const optionIsAvailable = (option: HostFieldOption) => {
  const meta = (option.meta ?? {}) as Record<string, any>;
  return (
    !option.disabled &&
    option.stateLabel !== "unavailable" &&
    option.stateLabel !== "price unavailable" &&
    meta.compatible !== false
  );
};

const hostOptionTypeLabel = (option: HostFieldOption): string =>
  (
    option.selectionLabel ??
    option.mainLabel ??
    option.label ??
    option.value
  ).toLowerCase();

const compareHostOptionsByType = (
  left: HostFieldOption,
  right: HostFieldOption,
) =>
  hostOptionTypeLabel(left).localeCompare(
    hostOptionTypeLabel(right),
    undefined,
    {
      numeric: true,
      sensitivity: "base",
    },
  );

const compareHostOptionsByPrice = (
  left: HostFieldOption,
  right: HostFieldOption,
) => {
  const leftRate = left.hourlyRate;
  const rightRate = right.hourlyRate;
  const leftHasRate =
    typeof leftRate === "number" && Number.isFinite(leftRate) && leftRate >= 0;
  const rightHasRate =
    typeof rightRate === "number" &&
    Number.isFinite(rightRate) &&
    rightRate >= 0;
  if (leftHasRate && rightHasRate && leftRate !== rightRate) {
    return leftRate - rightRate;
  }
  if (leftHasRate !== rightHasRate) {
    return leftHasRate ? -1 : 1;
  }
  return compareHostOptionsByType(left, right);
};

const compareOptionalDescending = (
  left: number | undefined,
  right: number | undefined,
): number | undefined => {
  const leftHasValue =
    typeof left === "number" && Number.isFinite(left) && left > 0;
  const rightHasValue =
    typeof right === "number" && Number.isFinite(right) && right > 0;
  if (leftHasValue && rightHasValue) {
    if (left === right) return 0;
    return right - left;
  }
  if (leftHasValue !== rightHasValue) {
    return leftHasValue ? -1 : 1;
  }
  return undefined;
};

const compareHostOptionsByValue = (
  left: HostFieldOption,
  right: HostFieldOption,
) => {
  const benchmarkOrder = compareOptionalDescending(
    left.benchmarkValueScore,
    right.benchmarkValueScore,
  );
  if (benchmarkOrder != null && benchmarkOrder !== 0) {
    return benchmarkOrder;
  }
  return compareHostOptionsByPrice(left, right);
};

const availableOptionsWithAtLeast16GiBRam = (
  options: HostFieldOption[] | undefined,
) =>
  (options ?? []).filter((option) => {
    const ramGiB = optionRamGiB(option);
    return optionIsAvailable(option) && (ramGiB == null || ramGiB >= 16);
  });

const availableOptionsWithExactly16GiBRam = (
  options: HostFieldOption[] | undefined,
) =>
  (options ?? []).filter((option) => {
    const ramGiB = optionRamGiB(option);
    return optionIsAvailable(option) && ramGiB === 16;
  });

const selectFirstByPredicate = (
  options: HostFieldOption[] | undefined,
  predicate: (option: HostFieldOption) => boolean,
) => availableOptionsWithAtLeast16GiBRam(options).find(predicate)?.value;

const NEBIUS_HPC_MACHINE_TYPE = "128vcpu-512gb";

const selectExactOption = (
  options: HostFieldOption[] | undefined,
  value: string,
) =>
  options?.find(
    (option) => optionIsAvailable(option) && option.value === value,
  );

const selectNebiusCpuMachineType = (options: HostFieldOption[] | undefined) =>
  selectExactOption(options, NEBIUS_HPC_MACHINE_TYPE)?.value ??
  availableOptionsWithAtLeast16GiBRam(options).find(
    (option) => !optionLooksGpu(option),
  )?.value;

const selectNebiusGpuMachineType = (
  options: HostFieldOption[] | undefined,
  opts?: { requireSpot?: boolean },
) =>
  availableOptionsWithAtLeast16GiBRam(options)
    .filter(optionLooksGpu)
    .filter(
      (option) =>
        !opts?.requireSpot || isNebiusSpotSupported(options, option.value),
    )
    .sort(compareHostOptionsByPrice)[0]?.value;

const setPrimaryComputeOption = (
  draft: HostCreateDraft,
  options: FieldOptionsMap,
  mode: "cpu" | "gpu",
  context: HostCreateDraftContext,
) => {
  if (draft.provider === "gcp") {
    if (mode === "gpu") {
      const gpuType = selectFirstByPredicate(
        options.gpu_type,
        (option) => option.value !== "none",
      );
      if (gpuType) draft.gpu_type = gpuType;
    } else {
      draft.gpu_type = "none";
    }
    const zoneOptions = getFieldOptions("gcp", draft, context).zone ?? [];
    const requestedZone = draft.zone;
    const zones = [
      ...(requestedZone ? [requestedZone] : []),
      ...zoneOptions
        .map((option) => option.value)
        .filter((zone) => zone !== requestedZone),
    ];
    const candidateMachineTypes = availableOptionsWithExactly16GiBRam(
      getFieldOptions("gcp", { ...draft, zone: undefined }, context)
        .machine_type,
    )
      .filter(mode === "gpu" ? () => true : (option) => !optionLooksGpu(option))
      .sort(compareHostOptionsByValue);
    for (const machineOption of candidateMachineTypes) {
      let selected = false;
      for (const zone of zones) {
        const fieldOptions = getFieldOptions(
          "gcp",
          { ...draft, zone, machine_type: machineOption.value },
          context,
        );
        const availableInZone = selectFirstByPredicate(
          fieldOptions.machine_type,
          (option) => option.value === machineOption.value,
        );
        if (!availableInZone) continue;
        draft.zone = zone;
        draft.machine_type = machineOption.value;
        selected = true;
        break;
      }
      if (selected) break;
    }
    const finalZoneOptions = getFieldOptions("gcp", draft, context).zone ?? [];
    const selectedZoneOption = finalZoneOptions.find(
      (option) => option.value === draft.zone,
    );
    const currentMeta = (selectedZoneOption?.meta ?? {}) as {
      compatible?: boolean;
    };
    if (currentMeta.compatible === false) {
      const compatibleZone = finalZoneOptions.find((option) => {
        const meta = (option.meta ?? {}) as { compatible?: boolean };
        return meta.compatible === true;
      })?.value;
      if (compatibleZone) draft.zone = compatibleZone;
    }
    return;
  }
  const field = draft.provider === "hyperstack" ? "size" : "machine_type";
  if (draft.provider === "nebius") {
    const nebiusOptions =
      getFieldOptions("nebius", draft, context).machine_type ?? options[field];
    const selected =
      mode === "cpu"
        ? selectNebiusCpuMachineType(nebiusOptions)
        : selectNebiusGpuMachineType(nebiusOptions, {
            requireSpot: draft.pricing_model === "spot",
          });
    if (selected) draft[field] = selected;
    return;
  }
  const selected =
    mode === "gpu"
      ? selectFirstByPredicate(options[field], optionLooksGpu)
      : selectFirstByPredicate(
          options[field],
          (option) => !optionLooksGpu(option),
        );
  if (selected) draft[field] = selected;
};

export function applyPreset(
  presetId: HostCreatePresetId,
  current: Partial<HostCreateDraft>,
  context: HostCreateDraftContext,
): HostCreateDraft {
  let { draft, fieldOptions } = normalizeDraft(current, context);
  if (presetId === "balanced-cpu") {
    draft.pricing_model = "on_demand";
    draft.interruption_restore_policy = defaultRestorePolicy("on_demand");
    setPrimaryComputeOption(draft, fieldOptions, "cpu", context);
  } else if (presetId === "low-cost-spot") {
    draft.pricing_model = "spot";
    draft.interruption_restore_policy = defaultRestorePolicy("spot");
    setPrimaryComputeOption(
      draft,
      fieldOptions,
      draft.provider === "nebius" ? "gpu" : "cpu",
      context,
    );
  } else {
    draft.pricing_model = "on_demand";
    draft.interruption_restore_policy = defaultRestorePolicy("on_demand");
    setPrimaryComputeOption(draft, fieldOptions, "gpu", context);
  }
  return normalizeDraft(draft, context).draft;
}

export function getAvailablePresets(
  current: Partial<HostCreateDraft>,
  context: HostCreateDraftContext,
): HostCreatePreset[] {
  const { draft, fieldOptions } = normalizeDraft(current, context);
  const hasGpuOption =
    draft.provider === "gcp"
      ? !!selectFirstByPredicate(
          fieldOptions.gpu_type,
          (option) => option.value !== "none",
        )
      : draft.provider === "nebius"
        ? !!selectNebiusGpuMachineType(fieldOptions.machine_type)
        : !!selectFirstByPredicate(
            fieldOptions[
              draft.provider === "hyperstack" ? "size" : "machine_type"
            ],
            optionLooksGpu,
          );
  const nebiusSpotOption = selectNebiusGpuMachineType(
    fieldOptions.machine_type,
    { requireSpot: true },
  );
  const spotSupported = draft.provider !== "nebius" || nebiusSpotOption != null;
  const presets: HostCreatePreset[] = [
    {
      id: "balanced-cpu",
      label: draft.provider === "nebius" ? "HPC" : "Balanced CPU",
      description:
        draft.provider === "nebius"
          ? "A high-value CPU/RAM host with on-demand pricing."
          : "A general-purpose CPU host with on-demand pricing.",
    },
    {
      id: "low-cost-spot",
      label:
        draft.provider === "nebius" ? "Low cost Spot GPU" : "Low-cost spot",
      description:
        draft.provider === "nebius"
          ? "Use interruptible GPU capacity with automatic restore."
          : "Use interruptible capacity with automatic restore.",
      disabled: !isManagedProvider(draft.provider) || !spotSupported,
      disabledReason: !isManagedProvider(draft.provider)
        ? "Spot pricing is only available for managed cloud hosts."
        : !spotSupported
          ? "The selected instance type does not support spot pricing."
          : undefined,
    },
    {
      id: "gpu-workstation",
      label: draft.provider === "nebius" ? "Standard GPU" : "GPU workstation",
      description:
        draft.provider === "nebius"
          ? "Use an on-demand GPU host."
          : "Pick the first valid GPU shape for this provider.",
      disabled: !hasGpuOption,
      disabledReason: hasGpuOption
        ? undefined
        : "No GPU shape is available in the loaded catalog.",
    },
  ];
  if (draft.provider === "nebius") {
    return [presets[2], presets[1], presets[0]];
  }
  return presets;
}

export function buildCreateHostPayloadFromDraft(
  current: HostCreateDraft,
  context: HostCreateDraftContext,
): Record<string, any> & { start_after_create: boolean } {
  const { draft, fieldOptions } = normalizeDraft(current, context);
  return {
    ...buildCreateHostPayload(draft, {
      fieldOptions,
      catalog: getCatalog(draft.provider, context),
    }),
    start_after_create: draft.start_after_create,
  };
}

export function buildSubmitDraft(
  formValues: Partial<HostCreateDraft>,
  canonicalDraft: HostCreateDraft,
  context: HostCreateDraftContext,
): HostCreateDraft {
  const formDisk = readPositiveInteger(formValues.disk);
  const formDiskGb = readPositiveInteger(formValues.disk_gb);
  const formSharedDiskGb = readPositiveInteger(formValues.shared_disk_gb);
  return normalizeDraft(
    {
      ...formValues,
      ...canonicalDraft,
      // Preserve fast user input from the form, but keep provider-dependent
      // fields from the normalized draft so hidden stale form state cannot
      // submit the wrong cloud provider.
      name:
        typeof formValues.name === "string"
          ? formValues.name
          : canonicalDraft.name,
      disk: formDisk ?? canonicalDraft.disk,
      disk_gb: formDiskGb ?? canonicalDraft.disk_gb,
      shared_disk_gb: formSharedDiskGb ?? canonicalDraft.shared_disk_gb,
      shared_disk_type:
        formValues.shared_disk_type ?? canonicalDraft.shared_disk_type,
    },
    context,
  ).draft;
}
