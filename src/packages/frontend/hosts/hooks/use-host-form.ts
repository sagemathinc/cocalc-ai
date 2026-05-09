import {
  useEffect,
  useMemo,
  useRef,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import type { FormInstance } from "antd";
import type { HostCatalog } from "@cocalc/conat/hub/api/hosts";
import { mapCountryRegionToR2Region } from "@cocalc/util/consts";
import type { HostProvider, HostRecommendation } from "../types";
import { buildCatalogSummary } from "../utils/normalize-catalog";
import {
  HOST_FIELDS,
  buildRecommendationUpdate,
  getProviderDescriptor,
  getProviderPriceEstimate,
  getProviderStorageSupport,
  getProviderOptions,
  filterFieldSchemaForCaps,
  type HostFieldId,
  type ProviderSelection,
  type FieldOptionsMap,
  type ProviderFieldSchema,
  type ProviderPriceEstimate,
} from "../providers/registry";
import {
  markRecommendedRegionOption,
  sortRegionOptionsByPreference,
  type RegionPreference,
} from "../utils/region-ranking";
import { useHostPricingSettings } from "./use-host-pricing-settings";

type SelectOption = { value: string; disabled?: boolean };

type UseHostFormArgs = {
  form: FormInstance;
  catalog?: HostCatalog;
  selectedProvider?: HostProvider;
  selectedRegion?: string;
  selectedZone?: string;
  selectedMachineType?: string;
  selectedGpuType?: string;
  selectedPricingModel?: string;
  selectedDiskType?: string;
  selectedDiskGb?: number;
  selectedSelfHostKind?: string;
  selectedSelfHostMode?: string;
  selectedSize?: string;
  selectedGpu?: string;
  selectedStorageMode?: string;
  selectedRegionPreference?: string;
  selectedPriceDisplay?: string;
  enabledProviders: HostProvider[];
};

const FIELD_LABELS: Record<HostFieldId, string> = {
  region: "Region",
  zone: "Zone",
  machine_type: "Machine type",
  gpu_type: "GPU",
  self_host_kind: "Host type",
  self_host_mode: "Connectivity",
  size: "Size",
  gpu: "GPU",
};

const inOptions = (value: string | undefined, options?: SelectOption[]) =>
  value !== undefined &&
  value !== null &&
  !!options?.some((opt) => opt.value === value);

const firstValue = (options?: SelectOption[]) =>
  options?.find((opt) => !opt.disabled)?.value ?? options?.[0]?.value;

export const useHostForm = ({
  form,
  catalog,
  selectedProvider,
  selectedRegion,
  selectedZone,
  selectedMachineType,
  selectedGpuType,
  selectedPricingModel,
  selectedDiskType,
  selectedDiskGb,
  selectedSelfHostKind,
  selectedSelfHostMode,
  selectedSize,
  selectedGpu,
  selectedStorageMode,
  selectedRegionPreference,
  selectedPriceDisplay,
  enabledProviders,
}: UseHostFormArgs) => {
  const prevProviderRef = useRef<HostProvider | undefined>(undefined);
  const provider =
    selectedProvider ?? enabledProviders[0] ?? ("none" as HostProvider);
  const cloudflareCountry = useTypedRedux("customize", "country");
  const cloudflareRegionCode = useTypedRedux(
    "customize",
    "cloudflare_region_code",
  );
  const preferredR2Region = useMemo(
    () => mapCountryRegionToR2Region(cloudflareCountry, cloudflareRegionCode),
    [cloudflareCountry, cloudflareRegionCode],
  );
  const providerCaps = useMemo(() => {
    if (!catalog?.provider_capabilities) return undefined;
    return catalog.provider_capabilities[provider];
  }, [catalog, provider]);
  const fieldSchema: ProviderFieldSchema = useMemo(
    () =>
      filterFieldSchemaForCaps(
        getProviderDescriptor(provider).fields,
        providerCaps,
      ),
    [provider, providerCaps],
  );
  const pricingSettings = useHostPricingSettings();
  const selection: ProviderSelection = useMemo(
    () => ({
      region: selectedRegion,
      zone: selectedZone,
      machine_type: selectedMachineType,
      gpu_type: selectedGpuType,
      pricing_model: selectedPricingModel,
      storage_mode: selectedStorageMode,
      disk_type: selectedDiskType,
      disk_gb: selectedDiskGb,
      self_host_kind: selectedSelfHostKind,
      self_host_mode: selectedSelfHostMode,
      size: selectedSize,
      gpu: selectedGpu,
      price_display: selectedPriceDisplay === "monthly" ? "monthly" : "hourly",
      pricing_settings: pricingSettings,
    }),
    [
      selectedRegion,
      selectedZone,
      selectedMachineType,
      selectedGpuType,
      selectedPricingModel,
      selectedStorageMode,
      selectedDiskType,
      selectedDiskGb,
      selectedSelfHostKind,
      selectedSelfHostMode,
      selectedSize,
      selectedGpu,
      selectedPriceDisplay,
      pricingSettings,
    ],
  );
  const regionPreference: RegionPreference =
    selectedRegionPreference === "closest" ||
    selectedRegionPreference === "cheapest"
      ? selectedRegionPreference
      : "balanced";
  const fieldOptions: FieldOptionsMap = useMemo(() => {
    const options = getProviderOptions(provider, catalog, selection);
    const regionOptions = options.region ?? [];
    if (regionOptions.length <= 1) return options;
    const sortedRegionOptions = markRecommendedRegionOption(
      sortRegionOptionsByPreference({
        options: regionOptions,
        preference: regionPreference,
        preferredRegion: preferredR2Region,
      }),
    );
    return {
      ...options,
      region: sortedRegionOptions,
    };
  }, [provider, catalog, selection, preferredR2Region, regionPreference]);
  const fieldLabels = useMemo(
    () => ({
      ...FIELD_LABELS,
      ...(fieldSchema.labels ?? {}),
    }),
    [fieldSchema],
  );
  const fieldTooltips = useMemo(
    () => fieldSchema.tooltips ?? {},
    [fieldSchema],
  );

  const storageSupport = useMemo(
    () => getProviderStorageSupport(provider, catalog?.provider_capabilities),
    [provider, catalog],
  );
  const supportsPersistentStorage = storageSupport.supported;
  const persistentGrowable = storageSupport.growable ?? true;
  const persistentOption = {
    value: "persistent",
    label: persistentGrowable
      ? "Persistent (growable disk)"
      : "Persistent (fixed size)",
  };
  const storageModeOptions = !supportsPersistentStorage
    ? [{ value: "ephemeral", label: "Ephemeral (local)" }]
    : provider === "gcp"
      ? [
          ...(selectedStorageMode === "ephemeral"
            ? [
                {
                  value: "ephemeral",
                  label:
                    "Ephemeral (legacy local, not offered for new GCP hosts)",
                  disabled: true,
                },
              ]
            : []),
          persistentOption,
        ]
      : [{ value: "ephemeral", label: "Ephemeral (local)" }, persistentOption];
  const showDiskFields =
    supportsPersistentStorage && selectedStorageMode !== "ephemeral";
  const priceEstimate: ProviderPriceEstimate | undefined = useMemo(
    () =>
      getProviderPriceEstimate(provider, catalog, selection, pricingSettings),
    [provider, catalog, pricingSettings, selection],
  );

  const catalogSummary = useMemo(
    () =>
      buildCatalogSummary({
        catalog,
        enabledProviders,
      }),
    [catalog, enabledProviders],
  );

  useEffect(() => {
    const currentStorageMode = form.getFieldValue("storage_mode");
    if (!supportsPersistentStorage) {
      if (currentStorageMode !== "ephemeral") {
        form.setFieldsValue({ storage_mode: "ephemeral" });
      }
      return;
    }
    if (
      !currentStorageMode ||
      !storageModeOptions.some((opt) => opt.value === currentStorageMode)
    ) {
      const nextStorageMode = firstValue(storageModeOptions);
      if (nextStorageMode) {
        form.setFieldsValue({ storage_mode: nextStorageMode });
      }
    }
  }, [supportsPersistentStorage, storageModeOptions, form]);

  useEffect(() => {
    if (!selectedProvider || selectedProvider === "none") return;
    const updates: Record<string, any> = {};
    const providerChanged = provider !== prevProviderRef.current;
    if (providerChanged) {
      prevProviderRef.current = provider;
    }

    if (providerChanged) {
      const activeFields = new Set<HostFieldId>([
        ...fieldSchema.primary,
        ...fieldSchema.advanced,
      ]);
      for (const field of HOST_FIELDS) {
        if (!activeFields.has(field)) {
          updates[field] = undefined;
        }
      }
    }

    const ensureValue = (
      field: string,
      value: string | undefined,
      options?: SelectOption[],
      fallback?: string,
    ) => {
      if (!options?.length) return;
      if (inOptions(value, options)) return;
      updates[field] = fallback ?? firstValue(options);
    };

    const currentValues: Record<HostFieldId, string | undefined> = {
      region: selectedRegion,
      zone: selectedZone,
      machine_type: selectedMachineType,
      gpu_type: selectedGpuType,
      self_host_kind: selectedSelfHostKind,
      self_host_mode: selectedSelfHostMode,
      size: selectedSize,
      gpu: selectedGpu,
    };

    for (const field of [...fieldSchema.primary, ...fieldSchema.advanced]) {
      ensureValue(field, currentValues[field], fieldOptions[field]);
    }

    if (Object.keys(updates).length > 0) {
      form.setFieldsValue(updates);
    }
  }, [
    form,
    provider,
    selectedRegion,
    selectedZone,
    selectedMachineType,
    selectedGpuType,
    selectedSelfHostKind,
    selectedSelfHostMode,
    selectedSize,
    selectedGpu,
    fieldSchema,
    fieldOptions,
  ]);

  const applyRecommendation = (rec: HostRecommendation) => {
    const next = buildRecommendationUpdate(rec);
    if (Object.keys(next).length === 0) return;
    form.setFieldsValue(next);
  };

  return {
    providerCaps,
    fieldSchema,
    fieldOptions,
    fieldLabels,
    fieldTooltips,
    supportsPersistentStorage,
    persistentGrowable,
    storageModeOptions,
    showDiskFields,
    priceEstimate,
    catalogSummary,
    applyRecommendation,
  };
};
