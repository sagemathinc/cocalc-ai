import {
  Alert,
  Button,
  Card,
  Form,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { React, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import { IS_MOBILE } from "@cocalc/frontend/feature";
import { mapCountryRegionToR2Region } from "@cocalc/util/consts";
import { COLORS } from "@cocalc/util/theme";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import type { HostCreateViewModel } from "../hooks/use-host-create-view-model";
import {
  getAvailablePresets,
  type HostCreateDraft,
  type HostCreateDraftContext,
} from "../create/host-create-draft";
import { useHostCreateDraft } from "../create/use-host-create-draft";
import {
  getProviderPriceEstimate,
  type HostFieldId,
  type ProviderSelection,
} from "../providers/registry";
import type { HostProvider } from "../types";
import { isBillableHostProvider } from "../utils/funding-mode";
import { useHostPricingSettings } from "../hooks/use-host-pricing-settings";
import { HostCreateForm } from "./host-create-form";
import { HostPriceBreakdown } from "./host-price-breakdown";

const CARD_STYLES = {
  header: { minHeight: 34, padding: "6px 10px" },
  body: { padding: 10 },
} as const;

const labelFor = (value: unknown, fallback = "Not selected") =>
  value == null || `${value}`.trim() === "" ? fallback : `${value}`;

const formatCpuRamDiskSummary = ({
  machineOption,
  diskLabel,
}: {
  machineOption?: { meta?: unknown };
  diskLabel: string;
}) => {
  const meta = (machineOption?.meta ?? {}) as Record<string, any>;
  const cpu = meta.guestCpus ?? meta.vcpus ?? meta.cpu;
  const ram =
    meta.memory_gib ??
    meta.ram_gb ??
    meta.ram ??
    (meta.memoryMb != null ? Number(meta.memoryMb) / 1024 : undefined);
  const parts: string[] = [];
  if (typeof cpu === "number" && Number.isFinite(cpu)) {
    parts.push(`vCPU: ${cpu.toLocaleString()}`);
  }
  if (typeof ram === "number" && Number.isFinite(ram)) {
    parts.push(`RAM: ${ram.toLocaleString()} GB`);
  }
  parts.push(`Disk: ${diskLabel}`);
  return parts.join(", ");
};

const providerShortName = (value: string, label: string) => {
  if (value === "gcp") return "Google";
  if (value === "nebius") return "Nebius";
  if (value === "hyperstack") return "Hyperstack";
  if (value === "lambda") return "Lambda";
  if (value === "self-host") return "Self-hosted";
  return label;
};

const providerDescription = (value: string) => {
  if (value === "gcp") return "Broad regions, steady CPU and GPU capacity.";
  if (value === "nebius") return "High-end GPU and HPC hosts.";
  if (value === "hyperstack") return "Large CPU/RAM and GPU catalog.";
  if (value === "lambda") return "Compact GPU cloud catalog.";
  if (value === "self-host") return "Admin-only user-managed host.";
  return "Configure this provider.";
};

const providerBadgeStyle = (value: string): React.CSSProperties => {
  if (value === "gcp") {
    return {
      background:
        "conic-gradient(from 180deg, #4285f4, #34a853, #fbbc05, #ea4335, #4285f4)",
      color: "white",
    };
  }
  if (value === "nebius") {
    return {
      background: "linear-gradient(135deg, #101828, #0ea5e9)",
      color: "white",
    };
  }
  return {
    background: COLORS.BLUE_LLL,
    color: COLORS.BLUE_D,
  };
};

function SectionTitle({
  icon,
  title,
  subtitle,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  title: string;
  subtitle?: string;
}) {
  return (
    <Space size={8} align="center">
      <span
        style={{
          alignItems: "center",
          background: COLORS.BLUE_LLLL,
          borderRadius: 8,
          color: COLORS.BLUE_D,
          display: "inline-flex",
          height: 24,
          justifyContent: "center",
          width: 24,
        }}
      >
        <Icon name={icon} />
      </span>
      <span>
        <Typography.Text strong>{title}</Typography.Text>
        {subtitle && (
          <Typography.Text
            type="secondary"
            style={{ display: "block", fontSize: 12, lineHeight: 1.1 }}
          >
            {subtitle}
          </Typography.Text>
        )}
      </span>
    </Space>
  );
}

type HostCreateCardProps = {
  vm: HostCreateViewModel;
  initialDraft?: HostCreateDraft | null;
  sourceHost?: Pick<Host, "id" | "name"> | null;
  onInitialDraftConsumed?: () => void;
};

export const HostCreateCard: React.FC<HostCreateCardProps> = ({
  vm,
  initialDraft,
  sourceHost,
  onInitialDraftConsumed,
}) => {
  const { permissions, form, provider, billing, catalogRefresh } = vm;
  const pricingSettings = useHostPricingSettings();
  const { isAdmin, canCreateHosts } = permissions;
  const {
    form: formInstance,
    creating,
    onCreate,
    onCreated,
    runFreshAuthAction,
  } = form;
  const {
    refreshProviders,
    refreshProvider,
    setRefreshProvider,
    refreshCatalog,
    catalogRefreshing,
  } = catalogRefresh;
  const hasExternalProviders = refreshProviders.some(
    (entry) => entry.value !== "self-host",
  );
  const cloudflareCountry = useTypedRedux("customize", "country");
  const cloudflareRegionCode = useTypedRedux(
    "customize",
    "cloudflare_region_code",
  );
  const preferredRegion = React.useMemo(
    () => mapCountryRegionToR2Region(cloudflareCountry, cloudflareRegionCode),
    [cloudflareCountry, cloudflareRegionCode],
  );
  const draftContext = React.useMemo<HostCreateDraftContext>(
    () => ({
      enabledProviders: provider.providerOptions.map((option) => option.value),
      catalogByProvider: provider.catalog
        ? { [provider.selectedProvider]: provider.catalog }
        : {},
      preferredRegion,
      billing: {
        fundingModeOptions: billing.fundingModeOptions,
        defaultFundingMode: billing.defaultFundingMode,
      },
    }),
    [
      billing.defaultFundingMode,
      billing.fundingModeOptions,
      provider.catalog,
      provider.providerOptions,
      provider.selectedProvider,
      preferredRegion,
    ],
  );
  const draftState = useHostCreateDraft({
    form: formInstance,
    context: draftContext,
    initialDraft,
    onInitialDraftConsumed,
  });
  const onProviderChange = React.useCallback(
    (value: string) => {
      const nextProvider = value as HostProvider;
      draftState.setProvider(nextProvider);
      if (refreshProviders.some((entry) => entry.value === nextProvider)) {
        setRefreshProvider(nextProvider);
      }
    },
    [draftState, refreshProviders, setRefreshProvider],
  );
  const refreshCatalogAndNotify = async () => {
    await refreshCatalog(provider.selectedProvider);
  };
  const confirmCreateHost = async (start: boolean) => {
    try {
      const vals = await formInstance.validateFields();
      const runCreate = async () => {
        const created = await onCreate(vals, { start });
        if (!created) return;
        draftState.resetDefault();
        onCreated?.();
      };
      if (runFreshAuthAction) {
        await runFreshAuthAction(runCreate);
      } else {
        await runCreate();
      }
    } catch (err) {
      // validation errors are surfaced by the form; no extra handling needed here
    }
  };
  const watchedRegion = Form.useWatch("region", formInstance);
  const watchedZone = Form.useWatch("zone", formInstance);
  const watchedStorageMode = Form.useWatch("storage_mode", formInstance);
  const watchedDiskType = Form.useWatch("disk_type", formInstance);
  const watchedDisk = Form.useWatch("disk", formInstance);
  const watchedDiskGb = Form.useWatch("disk_gb", formInstance);
  const watchedMachineType = Form.useWatch("machine_type", formInstance);
  const watchedGpuType = Form.useWatch("gpu_type", formInstance);
  const watchedPricingModel = Form.useWatch("pricing_model", formInstance);
  const watchedPriceDisplay = Form.useWatch("price_display", formInstance);
  const watchedFundingMode = Form.useWatch("funding_mode", formInstance);
  const presets = React.useMemo(
    () => getAvailablePresets(draftState.draft, draftContext),
    [draftContext, draftState.draft],
  );
  const [selectedPresetId, setSelectedPresetId] = React.useState<
    (typeof presets)[number]["id"] | undefined
  >();
  const applyCreatePreset = React.useCallback(
    (presetId: (typeof presets)[number]["id"]) => {
      setSelectedPresetId(presetId);
      draftState.applyPreset(presetId);
    },
    [draftState],
  );
  const selectProvider = React.useCallback(
    (value: HostProvider) => {
      setSelectedPresetId(undefined);
      formInstance.setFieldsValue({ provider: value });
      onProviderChange?.(value);
    },
    [formInstance, onProviderChange],
  );
  const selectedDiskGb =
    typeof watchedDiskGb === "number" && Number.isFinite(watchedDiskGb)
      ? watchedDiskGb
      : typeof watchedDisk === "number" && Number.isFinite(watchedDisk)
        ? watchedDisk
        : undefined;
  const livePricingSelection = React.useMemo<ProviderSelection>(
    () => ({
      region: watchedRegion,
      zone: watchedZone,
      machine_type: watchedMachineType,
      gpu_type: watchedGpuType,
      funding_mode: watchedFundingMode,
      pricing_model: watchedPricingModel,
      storage_mode: watchedStorageMode,
      disk_type: watchedDiskType,
      disk_gb: selectedDiskGb,
      price_display: watchedPriceDisplay === "monthly" ? "monthly" : "hourly",
    }),
    [
      selectedDiskGb,
      watchedDiskType,
      watchedGpuType,
      watchedMachineType,
      watchedFundingMode,
      watchedPriceDisplay,
      watchedPricingModel,
      watchedRegion,
      watchedStorageMode,
      watchedZone,
    ],
  );
  const livePriceEstimate = React.useMemo(
    () =>
      provider.selectedProvider === "gcp" ||
      provider.selectedProvider === "nebius"
        ? getProviderPriceEstimate(
            provider.selectedProvider,
            provider.catalog,
            livePricingSelection,
            pricingSettings,
          )
        : undefined,
    [
      livePricingSelection,
      pricingSettings,
      provider.catalog,
      provider.selectedProvider,
    ],
  );
  const needsGcpPlacementCompatibility =
    provider.selectedProvider === "gcp" &&
    !!(
      (watchedGpuType && watchedGpuType !== "none") ||
      (watchedMachineType ?? "").trim()
    );
  const gcpRegionIncompatible = React.useMemo(() => {
    if (!needsGcpPlacementCompatibility) return false;
    const regionOption = (provider.fields.options.region ?? []).find(
      (opt) => opt.value === watchedRegion,
    );
    const meta = (regionOption?.meta ?? {}) as { compatible?: boolean };
    return meta.compatible === false;
  }, [
    needsGcpPlacementCompatibility,
    provider.fields.options.region,
    watchedRegion,
  ]);
  const gcpZoneIncompatible = React.useMemo(() => {
    if (!needsGcpPlacementCompatibility) return false;
    const zoneOption = (provider.fields.options.zone ?? []).find(
      (opt) => opt.value === watchedZone,
    );
    const meta = (zoneOption?.meta ?? {}) as { compatible?: boolean };
    return meta.compatible === false;
  }, [
    needsGcpPlacementCompatibility,
    provider.fields.options.zone,
    watchedZone,
  ]);
  const watchedSshTarget = Form.useWatch("self_host_ssh_target", formInstance);
  const missingSelfHostTarget =
    provider.selectedProvider === "self-host" &&
    !(watchedSshTarget ?? "").trim();
  const billableProvider = isBillableHostProvider(provider.selectedProvider);
  const noFundingModes =
    billableProvider && billing.fundingModeOptions.length === 0;
  const missingFundingMode = billableProvider && !watchedFundingMode;
  const supportsCatalogPricing =
    provider.selectedProvider === "gcp" ||
    provider.selectedProvider === "nebius";
  const priceSelectionComplete = React.useMemo(() => {
    if (!supportsCatalogPricing) return false;
    const machineType = `${watchedMachineType ?? ""}`.trim();
    const region = `${watchedRegion ?? ""}`.trim();
    if (!machineType || !region) return false;
    if ((watchedStorageMode ?? "persistent") === "ephemeral") return true;
    const diskType = `${watchedDiskType ?? ""}`.trim();
    return (
      !!diskType &&
      typeof selectedDiskGb === "number" &&
      Number.isFinite(selectedDiskGb) &&
      selectedDiskGb > 0
    );
  }, [
    supportsCatalogPricing,
    selectedDiskGb,
    watchedDiskType,
    watchedMachineType,
    watchedRegion,
    watchedStorageMode,
  ]);
  const selectionHasUnavailablePrice = React.useMemo(() => {
    const selectedOptions = [
      (provider.fields.options.region ?? []).find(
        (opt) => opt.value === watchedRegion,
      ),
      (provider.fields.options.zone ?? []).find(
        (opt) => opt.value === watchedZone,
      ),
      (provider.fields.options.machine_type ?? []).find(
        (opt) => opt.value === watchedMachineType,
      ),
    ];
    return selectedOptions.some(
      (opt) => opt?.stateLabel === "price unavailable",
    );
  }, [
    provider.fields.options.machine_type,
    provider.fields.options.region,
    provider.fields.options.zone,
    watchedMachineType,
    watchedRegion,
    watchedZone,
  ]);
  const catalogLoadingForProvider =
    provider.selectedProvider !== "none" &&
    provider.selectedProvider !== "self-host" &&
    !!provider.catalogLoading;
  const createDisabled =
    !canCreateHosts ||
    catalogLoadingForProvider ||
    gcpRegionIncompatible ||
    gcpZoneIncompatible ||
    missingSelfHostTarget ||
    noFundingModes ||
    missingFundingMode ||
    selectionHasUnavailablePrice ||
    (priceSelectionComplete && supportsCatalogPricing && !livePriceEstimate);
  const requiredCatalogFields = React.useMemo<HostFieldId[]>(
    () =>
      (["region", "machine_type", "size"] as HostFieldId[]).filter((field) =>
        provider.fields.schema.primary.includes(field),
      ),
    [provider.fields.schema.primary],
  );
  const catalogMissingForProvider = React.useMemo(() => {
    if (
      provider.selectedProvider === "none" ||
      provider.selectedProvider === "self-host"
    ) {
      return false;
    }
    if (!requiredCatalogFields.length) return false;
    return requiredCatalogFields.every(
      (field) => (provider.fields.options[field] ?? []).length === 0,
    );
  }, [
    provider.fields.options,
    provider.selectedProvider,
    requiredCatalogFields,
  ]);
  const showCatalogLoading = catalogLoadingForProvider;
  const showCatalogRefreshGate =
    !showCatalogLoading && catalogMissingForProvider && hasExternalProviders;
  const providerLabel =
    provider.providerOptions.find(
      (option) => option.value === provider.selectedProvider,
    )?.label ?? provider.selectedProvider;
  const selectedMode =
    watchedPricingModel === "spot" ? "Spot / interruptible" : "On-demand";
  const selectedDiskLabel =
    selectedDiskGb != null ? `${selectedDiskGb.toLocaleString()} GB` : "Disk";
  const selectedMachineOption = React.useMemo(
    () =>
      (provider.fields.options.machine_type ?? []).find(
        (opt) => opt.value === watchedMachineType,
      ),
    [provider.fields.options.machine_type, watchedMachineType],
  );
  const selectedResourceSummary = React.useMemo(
    () =>
      formatCpuRamDiskSummary({
        machineOption: selectedMachineOption,
        diskLabel: selectedDiskLabel,
      }),
    [selectedDiskLabel, selectedMachineOption],
  );
  const fullCreateForm = (
    <HostCreateForm
      form={formInstance}
      canCreateHosts={canCreateHosts}
      provider={provider}
      billing={billing}
      onProviderChange={onProviderChange}
      onValuesChange={draftState.onValuesChange}
      pricingSettings={pricingSettings}
      draftManaged
      hideProviderSelect
    />
  );
  const priceSummary =
    provider.selectedProvider !== "none" &&
    provider.selectedProvider !== "self-host" &&
    !livePriceEstimate ? (
      supportsCatalogPricing && priceSelectionComplete ? (
        <Alert
          type="warning"
          showIcon
          title="Configuration unavailable"
          description="Pricing is unavailable for this region, machine type, or disk choice, so CoCalc cannot provision it."
        />
      ) : (
        <Typography.Text type="secondary">
          {supportsCatalogPricing
            ? "Estimated cost updates when region, machine type, pricing model, and disk are fully selected."
            : "Catalog pricing is not wired for this provider yet."}
        </Typography.Text>
      )
    ) : livePriceEstimate ? (
      <HostPriceBreakdown
        compact
        displayMode={watchedPriceDisplay === "monthly" ? "monthly" : "hourly"}
        estimate={livePriceEstimate}
        title="Estimated cost"
      />
    ) : (
      <Typography.Text type="secondary">
        No cloud price estimate is needed for this host type.
      </Typography.Text>
    );
  const createActions = (
    <Space orientation="vertical" style={{ width: "100%" }} size="small">
      <Popconfirm
        title={
          <div>
            <div>Create this host without starting it?</div>
            <div>
              It will be saved in the host list, but no VM will be provisioned
              until you start it.
            </div>
          </div>
        }
        okText="Create"
        cancelText="Cancel"
        onConfirm={() => confirmCreateHost(false)}
        disabled={createDisabled}
      >
        <Button loading={creating} disabled={createDisabled} block>
          Create Server (don't start)
        </Button>
      </Popconfirm>
      <Popconfirm
        title={
          <div>
            <div>Create and start this host?</div>
            <div>
              {provider.selectedProvider === "self-host"
                ? "Setup may take a few minutes."
                : "Provisioning may take a few minutes and can incur costs."}
            </div>
          </div>
        }
        okText="Start"
        cancelText="Cancel"
        onConfirm={() => confirmCreateHost(true)}
        disabled={createDisabled}
      >
        <Button
          type="primary"
          loading={creating}
          disabled={createDisabled}
          block
        >
          Start Server
        </Button>
      </Popconfirm>
    </Space>
  );
  const adminTools =
    isAdmin && hasExternalProviders && !showCatalogRefreshGate ? (
      <Space orientation="vertical" style={{ width: "100%" }} size="small">
        <Typography.Text type="secondary">Admin tools</Typography.Text>
        <Space size="small" wrap>
          <Select
            size="small"
            value={refreshProvider}
            onChange={(value) => value && setRefreshProvider(value)}
            options={refreshProviders}
            style={{ width: 160 }}
          />
          <Button
            size="small"
            onClick={refreshCatalogAndNotify}
            loading={catalogRefreshing}
            disabled={!refreshProviders.length}
          >
            Refresh catalog
          </Button>
        </Space>
      </Space>
    ) : null;
  const presetsSection =
    provider.selectedProvider !== "none" &&
    provider.selectedProvider !== "self-host" ? (
      <Card
        size="small"
        title={<SectionTitle icon="bolt" title="Choose a starting point" />}
        styles={CARD_STYLES}
      >
        <div
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: IS_MOBILE
              ? "1fr"
              : "repeat(3, minmax(0, 1fr))",
          }}
        >
          {presets.map((preset) => {
            const active = !preset.disabled && selectedPresetId === preset.id;
            const accentColor =
              preset.id === "low-cost-spot" ? COLORS.BS_GREEN_D : COLORS.BLUE_D;
            return (
              <Button
                key={preset.id}
                htmlType="button"
                block
                disabled={preset.disabled}
                title={preset.disabledReason ?? preset.description}
                onClick={() => applyCreatePreset(preset.id)}
                style={{
                  background: preset.disabled
                    ? COLORS.GRAY_LLL
                    : active
                      ? COLORS.ANTD_BG_BLUE_L
                      : "white",
                  borderColor: active ? COLORS.BS_BLUE_BGRND : undefined,
                  borderRadius: 10,
                  boxShadow: active
                    ? `0 0 0 1px ${COLORS.BS_BLUE_BGRND} inset`
                    : undefined,
                  color: preset.disabled ? COLORS.GRAY : COLORS.GRAY_DD,
                  height: "auto",
                  justifyContent: "flex-start",
                  minHeight: 62,
                  padding: "8px 10px",
                  textAlign: "left",
                  whiteSpace: "normal",
                }}
              >
                <Space size={8} align="start">
                  <span
                    style={{
                      color: active ? COLORS.BS_BLUE_TEXT : accentColor,
                      fontSize: 16,
                      lineHeight: "18px",
                    }}
                  >
                    <Icon
                      name={
                        preset.id === "gpu-workstation"
                          ? "rocket"
                          : preset.id === "low-cost-spot"
                            ? "bolt"
                            : "server"
                      }
                    />
                  </span>
                  <span>
                    <Typography.Text strong>{preset.label}</Typography.Text>
                    <Typography.Text
                      type="secondary"
                      style={{
                        display: "block",
                        fontSize: 12,
                        lineHeight: 1.15,
                      }}
                    >
                      {preset.disabled
                        ? preset.disabledReason
                        : preset.description}
                    </Typography.Text>
                  </span>
                </Space>
              </Button>
            );
          })}
        </div>
      </Card>
    ) : null;
  const providerSection = (
    <Card
      size="small"
      title={<SectionTitle icon="cloud" title="Provider" />}
      styles={CARD_STYLES}
    >
      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: IS_MOBILE
            ? "1fr"
            : `repeat(${Math.min(provider.providerOptions.length || 1, 3)}, minmax(0, 1fr))`,
        }}
      >
        {provider.providerOptions.map((option) => {
          const selected = option.value === provider.selectedProvider;
          const label = providerShortName(option.value, option.label);
          return (
            <Button
              key={option.value}
              htmlType="button"
              type={selected ? "primary" : "default"}
              size="large"
              block
              onClick={() => selectProvider(option.value)}
              style={{
                height: "auto",
                justifyContent: "flex-start",
                minHeight: 72,
                padding: "10px 12px",
                textAlign: "left",
                whiteSpace: "normal",
              }}
            >
              <Space size={10} align="center">
                <span
                  style={{
                    alignItems: "center",
                    borderRadius: 12,
                    display: "inline-flex",
                    flex: "0 0 auto",
                    fontWeight: 800,
                    height: 36,
                    justifyContent: "center",
                    lineHeight: 1,
                    width: 36,
                    ...providerBadgeStyle(option.value),
                  }}
                >
                  {option.value === "gcp" ? "G" : label.slice(0, 1)}
                </span>
                <span style={{ minWidth: 0 }}>
                  <Typography.Text
                    strong
                    style={{ color: selected ? "white" : undefined }}
                  >
                    {label}
                  </Typography.Text>
                  <Typography.Text
                    style={{
                      color: selected ? "rgba(255,255,255,0.82)" : COLORS.GRAY,
                      display: "block",
                      fontSize: 12,
                      lineHeight: 1.2,
                    }}
                  >
                    {providerDescription(option.value)}
                  </Typography.Text>
                </span>
              </Space>
            </Button>
          );
        })}
      </div>
    </Card>
  );
  const catalogLoadingSection = (
    <Card
      size="small"
      title={<SectionTitle icon="cog" title="Configuration" />}
      styles={CARD_STYLES}
    >
      <Space size="small">
        <Spin size="small" />
        <Typography.Text type="secondary">
          Loading {providerLabel} catalog...
        </Typography.Text>
      </Space>
    </Card>
  );
  const summaryPanel = (
    <Card
      size="small"
      title={
        <SectionTitle
          icon="money-check"
          title="Summary"
          subtitle="Review cost and launch mode"
        />
      }
      style={{
        position: "sticky",
        top: 0,
        boxShadow: `0 8px 24px ${COLORS.GRAY_DDD}`,
      }}
      styles={CARD_STYLES}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size="small">
        <div
          style={{
            background: COLORS.GRAY_LLL,
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 10,
            padding: 10,
          }}
        >
          <Space direction="vertical" size={4} style={{ width: "100%" }}>
            <Space size={6} wrap>
              <Tag color="blue">{providerLabel}</Tag>
              <Tag color={watchedPricingModel === "spot" ? "green" : "default"}>
                {selectedMode}
              </Tag>
            </Space>
            <Typography.Text style={{ fontSize: 12 }}>
              {labelFor(watchedRegion, "Region")} /{" "}
              {labelFor(watchedZone, "Zone")}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {labelFor(watchedMachineType ?? watchedGpuType, "Machine")}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {selectedResourceSummary}
            </Typography.Text>
          </Space>
        </div>
        {noFundingModes && (
          <Alert
            type="warning"
            showIcon
            title="No billing mode available"
            description="This account cannot currently fund billable dedicated hosts with the selected provider."
          />
        )}
        {priceSummary}
        {createActions}
        {adminTools}
      </Space>
    </Card>
  );
  const renderShell = (main: React.ReactNode, summary: React.ReactNode) => (
    <Card bordered={false} styles={{ body: { padding: 0 } }}>
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.BLUE_LLLL}, white 62%, ${COLORS.GRAY_LLL})`,
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: 14,
          marginBottom: 10,
          padding: "10px 12px",
        }}
      >
        <Space align="center" size={12}>
          <span
            style={{
              alignItems: "center",
              background: COLORS.BLUE_D,
              borderRadius: 12,
              color: "white",
              display: "inline-flex",
              height: 34,
              justifyContent: "center",
              width: 34,
            }}
          >
            <Icon name="server" />
          </span>
          <span>
            <Typography.Title level={4} style={{ margin: 0 }}>
              Create host
            </Typography.Title>
            <Typography.Text type="secondary">
              Configure provider, placement, compute, storage, and launch mode.
            </Typography.Text>
          </span>
        </Space>
      </div>
      {!canCreateHosts && (
        <Alert
          type="info"
          showIcon
          title="Your membership does not allow creating project hosts."
          style={{ marginBottom: 12 }}
        />
      )}
      {sourceHost && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Creating a similar host"
          description={
            <>
              Based on {sourceHost.name || "host"}{" "}
              <Typography.Text code>
                {sourceHost.id.slice(0, 8)}
              </Typography.Text>
            </>
          }
        />
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: IS_MOBILE ? "1fr" : "minmax(0, 1fr) 300px",
          alignItems: "flex-start",
          gap: 14,
        }}
      >
        <Space
          orientation="vertical"
          size="middle"
          style={{ minWidth: 0, width: "100%" }}
        >
          {main}
        </Space>
        <div style={{ minWidth: 0 }}>{summary}</div>
      </div>
    </Card>
  );

  if (showCatalogLoading) {
    return renderShell(
      <>
        {providerSection}
        {catalogLoadingSection}
      </>,
      summaryPanel,
    );
  }

  if (showCatalogRefreshGate) {
    return renderShell(
      <>
        {providerSection}
        <Card size="small" title="Catalog">
          <Space orientation="vertical" style={{ width: "100%" }} size="middle">
            <Alert
              type="warning"
              showIcon
              title="Cloud catalog not loaded yet"
              description={
                catalogRefreshing
                  ? "Refreshing the provider catalog and waiting for regions and machine types to appear."
                  : "Before creating hosts for this provider, refresh its catalog to load regions and machine types. If you just refreshed and this message persists, reload the page."
              }
            />
            {isAdmin ? (
              <Button
                type="primary"
                size="large"
                block
                onClick={refreshCatalogAndNotify}
                loading={catalogRefreshing}
                disabled={!canCreateHosts}
              >
                Refresh catalog
              </Button>
            ) : (
              <Alert
                type="info"
                showIcon
                title="Contact an admin"
                description="Contact an admin to refresh the provider catalog before creating hosts."
              />
            )}
          </Space>
        </Card>
      </>,
      summaryPanel,
    );
  }

  return renderShell(
    <>
      {providerSection}
      {presetsSection}
      <Card
        size="small"
        title={<SectionTitle icon="cog" title="Configuration" />}
        styles={CARD_STYLES}
      >
        {fullCreateForm}
      </Card>
    </>,
    summaryPanel,
  );
};
