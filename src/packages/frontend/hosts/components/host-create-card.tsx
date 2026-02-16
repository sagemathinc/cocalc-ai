import { Alert, Button, Card, Divider, Form, Popconfirm, Select, Space, Spin, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import type { HostCreateViewModel } from "../hooks/use-host-create-view-model";
import type { HostFieldId } from "../providers/registry";
import type { HostProvider } from "../types";
import { HostCreateForm } from "./host-create-form";

type HostCreateCardProps = {
  vm: HostCreateViewModel;
};

export const HostCreateCard: React.FC<HostCreateCardProps> = ({ vm }) => {
  const { permissions, form, provider, catalogRefresh } = vm;
  const { isAdmin, canCreateHosts } = permissions;
  const {
    form: formInstance,
    creating,
    onCreate,
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
      await onCreate(vals);
      formInstance.resetFields();
    } catch (err) {
      // validation errors are surfaced by the form; no extra handling needed here
    }
  };
  const watchedRegion = Form.useWatch("region", formInstance);
  const watchedGpuType = Form.useWatch("gpu_type", formInstance);
  const gcpRegionIncompatible = React.useMemo(() => {
    if (provider.selectedProvider !== "gcp") return false;
    if (!watchedGpuType || watchedGpuType === "none") return false;
    const regionOption = (provider.fields.options.region ?? []).find(
      (opt) => opt.value === watchedRegion,
    );
    const meta = (regionOption?.meta ?? {}) as { compatible?: boolean };
    return meta.compatible === false;
  }, [
    provider.fields.options.region,
    provider.selectedProvider,
    watchedGpuType,
    watchedRegion,
  ]);
  const watchedZone = Form.useWatch("zone", formInstance);
  const gcpZoneIncompatible = React.useMemo(() => {
    if (provider.selectedProvider !== "gcp") return false;
    if (!watchedGpuType || watchedGpuType === "none") return false;
    const zoneOption = (provider.fields.options.zone ?? []).find(
      (opt) => opt.value === watchedZone,
    );
    const meta = (zoneOption?.meta ?? {}) as { compatible?: boolean };
    return meta.compatible === false;
  }, [
    provider.fields.options.zone,
    provider.selectedProvider,
    watchedGpuType,
    watchedZone,
  ]);
  const watchedSshTarget = Form.useWatch("self_host_ssh_target", formInstance);
  const missingSelfHostTarget =
    provider.selectedProvider === "self-host" &&
    !(watchedSshTarget ?? "").trim();
  const createDisabled =
    !canCreateHosts ||
    gcpRegionIncompatible ||
    gcpZoneIncompatible ||
    missingSelfHostTarget;
  const requiredCatalogFields = React.useMemo<HostFieldId[]>(
    () =>
      (["region", "machine_type", "size"] as HostFieldId[]).filter(
        (field) => provider.fields.schema.primary.includes(field),
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
  }, [provider.fields.options, provider.selectedProvider, requiredCatalogFields]);
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
          title="Your membership does not allow creating workspace hosts."
          style={{ marginBottom: 12 }}
        />
      )}
      {showCatalogLoading ? (
        <>
          <HostCreateForm
            form={formInstance}
            canCreateHosts={canCreateHosts}
            provider={provider}
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
            onProviderChange={onProviderChange}
          />
          <Divider style={{ margin: "8px 0" }} />
          <Space orientation="vertical" style={{ width: "100%" }} size="small">
            {provider.selectedProvider !== "self-host" && (
              <Typography.Text type="secondary">
                Cost estimate (placeholder): updates with size/region
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
