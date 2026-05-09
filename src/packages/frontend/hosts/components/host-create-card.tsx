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
import type { HostFieldId } from "../providers/registry";
import type { HostProvider } from "../types";
import { isBillableHostProvider } from "../utils/funding-mode";
import { HostCreateForm } from "./host-create-form";

type HostCreateCardProps = {
  vm: HostCreateViewModel;
};

export const HostCreateCard: React.FC<HostCreateCardProps> = ({ vm }) => {
  const { permissions, form, provider, billing, catalogRefresh } = vm;
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
  const watchedStorageMode = Form.useWatch("storage_mode", formInstance);
  const watchedDiskType = Form.useWatch("disk_type", formInstance);
  const watchedDisk = Form.useWatch("disk", formInstance);
  const watchedMachineType = Form.useWatch("machine_type", formInstance);
  const watchedGpuType = Form.useWatch("gpu_type", formInstance);
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
  const watchedZone = Form.useWatch("zone", formInstance);
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
  const watchedFundingMode = Form.useWatch("funding_mode", formInstance);
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
      typeof watchedDisk === "number" &&
      Number.isFinite(watchedDisk) &&
      watchedDisk > 0
    );
  }, [
    supportsCatalogPricing,
    watchedDisk,
    watchedDiskType,
    watchedMachineType,
    watchedRegion,
    watchedStorageMode,
  ]);
  const createDisabled =
    !canCreateHosts ||
    gcpRegionIncompatible ||
    gcpZoneIncompatible ||
    missingSelfHostTarget ||
    noFundingModes ||
    missingFundingMode;
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
              provider.selectedProvider !== "self-host" && (
                <Typography.Text type="secondary">
                  {provider.priceEstimate
                    ? `Estimated cost: ${provider.priceEstimate.hourly_label} · ${provider.priceEstimate.monthly_label}`
                    : supportsCatalogPricing
                      ? priceSelectionComplete
                        ? "Estimated cost unavailable for this region, machine type, or disk choice."
                        : "Estimated cost updates when region, machine type, pricing model, and disk are fully selected."
                      : "Catalog pricing is not wired for this provider yet."}
                </Typography.Text>
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
