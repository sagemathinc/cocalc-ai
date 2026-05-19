import type {
  Host,
  HostCatalog,
  HostFundingMode,
  HostInterruptionRestorePolicy,
  HostPricingModel,
  HostSpotRecoveryPolicy,
} from "@cocalc/conat/hub/api/hosts";
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
};

export type HostCreateDraftContext = {
  enabledProviders: HostProvider[];
  catalogByProvider?: Partial<Record<HostProvider, HostCatalog | undefined>>;
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
const NEBIUS_IO_M3_INCREMENT_GB = 93;

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

const normalizeDiskSize = (
  provider: HostProvider,
  diskType: string | undefined,
  diskGb: unknown,
) => {
  const parsed = readPositiveInteger(diskGb) ?? DEFAULT_DISK_GB;
  if (provider === "nebius" && diskType === "ssd_io_m3") {
    return (
      Math.ceil(parsed / NEBIUS_IO_M3_INCREMENT_GB) * NEBIUS_IO_M3_INCREMENT_GB
    );
  }
  return parsed;
};

const getFieldOptions = (
  provider: HostProvider,
  draft: HostCreateDraft,
  context: HostCreateDraftContext,
) =>
  getProviderOptions(provider, getCatalog(provider, context), {
    ...draft,
    price_display: draft.price_display,
  } satisfies ProviderSelection);

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

export function buildDefaultDraft(
  context: HostCreateDraftContext,
): HostCreateDraft {
  return normalizeDraft(
    {
      name: DEFAULT_NAME,
      provider: firstEnabledProvider(context),
      start_after_create: true,
      region_preference: "balanced",
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
  return normalizeDraft(
    {
      name: similarName(host.name),
      provider,
      start_after_create: true,
      region_preference: "balanced",
      price_display: "hourly",
      funding_mode: host.funding_mode,
      cpu: readPositiveInteger(host.machine?.metadata?.cpu),
      ram_gb: readPositiveInteger(host.machine?.metadata?.ram_gb),
      disk_gb: disk,
      disk,
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
      input.region_preference === "closest" ||
      input.region_preference === "cheapest"
        ? input.region_preference
        : "balanced",
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
  } else {
    const diskTypeOptions = getDiskTypeOptions(provider);
    if (!draft.disk_type || !inOptions(draft.disk_type, diskTypeOptions)) {
      draft.disk_type = diskTypeOptions[0]?.value;
    }
    if (draft.storage_mode !== "ephemeral") {
      const diskGb = normalizeDiskSize(
        provider,
        draft.disk_type,
        draft.disk_gb,
      );
      draft.disk_gb = diskGb;
      draft.disk = diskGb;
    }
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
    /gpu|nvidia|a10|a40|a100|h100|l4/i.test(`${option.value} ${option.label}`)
  );
};

const selectFirstByPredicate = (
  options: HostFieldOption[] | undefined,
  predicate: (option: HostFieldOption) => boolean,
) => options?.find((option) => !option.disabled && predicate(option))?.value;

const setPrimaryComputeOption = (
  draft: HostCreateDraft,
  options: FieldOptionsMap,
  mode: "cpu" | "gpu",
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
    return;
  }
  const field = draft.provider === "hyperstack" ? "size" : "machine_type";
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
    setPrimaryComputeOption(draft, fieldOptions, "cpu");
  } else if (presetId === "low-cost-spot") {
    draft.pricing_model = "spot";
    draft.interruption_restore_policy = defaultRestorePolicy("spot");
    setPrimaryComputeOption(draft, fieldOptions, "cpu");
  } else {
    draft.pricing_model = "on_demand";
    draft.interruption_restore_policy = defaultRestorePolicy("on_demand");
    setPrimaryComputeOption(draft, fieldOptions, "gpu");
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
      : !!selectFirstByPredicate(
          fieldOptions[
            draft.provider === "hyperstack" ? "size" : "machine_type"
          ],
          optionLooksGpu,
        );
  const spotSupported =
    draft.provider !== "nebius" ||
    isNebiusSpotSupported(fieldOptions.machine_type, draft.machine_type);
  return [
    {
      id: "balanced-cpu",
      label: "Balanced CPU",
      description: "A general-purpose CPU host with on-demand pricing.",
    },
    {
      id: "low-cost-spot",
      label: "Low-cost spot",
      description: "Use interruptible capacity with automatic restore.",
      disabled: !isManagedProvider(draft.provider) || !spotSupported,
      disabledReason: !isManagedProvider(draft.provider)
        ? "Spot pricing is only available for managed cloud hosts."
        : !spotSupported
          ? "The selected instance type does not support spot pricing."
          : undefined,
    },
    {
      id: "gpu-workstation",
      label: "GPU workstation",
      description: "Pick the first valid GPU shape for this provider.",
      disabled: !hasGpuOption,
      disabledReason: hasGpuOption
        ? undefined
        : "No GPU shape is available in the loaded catalog.",
    },
  ];
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
