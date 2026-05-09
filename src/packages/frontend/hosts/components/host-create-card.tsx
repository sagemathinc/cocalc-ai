import {
  Alert,
  Button,
  Card,
  Divider,
  Form,
  Popconfirm,
  Select,
  Space,
  Spin,
  Typography,
} from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import type { HostCreateViewModel } from "../hooks/use-host-create-view-model";
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

type HostCreateCardProps = {
  vm: HostCreateViewModel;
};

export const HostCreateCard: React.FC<HostCreateCardProps> = ({ vm }) => {
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
  const onProviderChange = React.useCallback(
    (value: string) => {
      const nextProvider = value as HostProvider;
      formInstance.setFieldsValue({ provider: nextProvider });
      if (refreshProviders.some((entry) => entry.value === nextProvider)) {
        setRefreshProvider(nextProvider);
      }
    },
    [formInstance, refreshProviders, setRefreshProvider],
  );
  const refreshCatalogAndNotify = async () => {
    await refreshCatalog(provider.selectedProvider);
  };
  const confirmCreateHost = async () => {
    try {
      const vals = await formInstance.validateFields();
      const runCreate = async () => {
        const created = await onCreate(vals);
        if (!created) return;
        formInstance.resetFields();
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
  const createDisabled =
    !canCreateHosts ||
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
  const showCatalogLoading =
    provider.selectedProvider !== "none" &&
    provider.selectedProvider !== "self-host" &&
    !!provider.catalogLoading;
  const showCatalogRefreshGate =
    !showCatalogLoading && catalogMissingForProvider && hasExternalProviders;

  return (
    <Card
      title={
        <span>
          <Icon name="plus" /> Create host
        </span>
      }
    >
      {!canCreateHosts && (
        <Alert
          type="info"
          showIcon
          title="Your membership does not allow creating project hosts."
          style={{ marginBottom: 12 }}
        />
      )}
      {showCatalogLoading ? (
        <>
          <HostCreateForm
            form={formInstance}
            canCreateHosts={canCreateHosts}
            provider={provider}
            billing={billing}
            onProviderChange={onProviderChange}
            showOnlyProviderSelect
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Spin size="small" />
            <Typography.Text type="secondary">
              Loading cloud catalog...
            </Typography.Text>
          </div>
        </>
      ) : showCatalogRefreshGate ? (
        <>
          <HostCreateForm
            form={formInstance}
            canCreateHosts={canCreateHosts}
            provider={provider}
            billing={billing}
            onProviderChange={onProviderChange}
            showOnlyProviderSelect
          />
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            title="Cloud catalog not loaded yet"
            description="Before creating hosts for this provider, refresh its catalog to load regions and machine types."
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
        </>
      ) : (
        <>
          <HostCreateForm
            form={formInstance}
            canCreateHosts={canCreateHosts}
            provider={provider}
            billing={billing}
            onProviderChange={onProviderChange}
          />
          {noFundingModes && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              title="No billing mode available for this host"
              description="This account cannot currently fund billable dedicated hosts with the selected provider."
            />
          )}
          <Divider style={{ margin: "8px 0" }} />
          <Space orientation="vertical" style={{ width: "100%" }} size="small">
            {provider.selectedProvider !== "none" &&
              provider.selectedProvider !== "self-host" &&
              !livePriceEstimate &&
              (supportsCatalogPricing && priceSelectionComplete ? (
                <Alert
                  type="warning"
                  showIcon
                  title="This configuration is not available for purchase"
                  description="Pricing is unavailable for this region, machine type, or disk choice, so CoCalc cannot provision it."
                />
              ) : (
                <Typography.Text type="secondary">
                  {supportsCatalogPricing
                    ? "Estimated cost updates when region, machine type, pricing model, and disk are fully selected."
                    : "Catalog pricing is not wired for this provider yet."}
                </Typography.Text>
              ))}
            {livePriceEstimate && (
              <HostPriceBreakdown
                displayMode={
                  watchedPriceDisplay === "monthly" ? "monthly" : "hourly"
                }
                estimate={livePriceEstimate}
              />
            )}
            <Popconfirm
              title={
                <div>
                  <div>Create this host?</div>
                  <div>
                    {provider.selectedProvider === "self-host"
                      ? "Setup may take a few minutes."
                      : "Provisioning may take a few minutes and can incur costs."}
                  </div>
                </div>
              }
              okText="Create"
              cancelText="Cancel"
              onConfirm={confirmCreateHost}
              disabled={createDisabled}
            >
              <Button
                type="primary"
                loading={creating}
                disabled={createDisabled}
                block
              >
                Create host
              </Button>
            </Popconfirm>
          </Space>
        </>
      )}
      {isAdmin && hasExternalProviders && !showCatalogRefreshGate && (
        <>
          <Divider style={{ margin: "12px 0" }} />
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
        </>
      )}
    </Card>
  );
};
