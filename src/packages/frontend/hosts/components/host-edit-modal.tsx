import {
  Alert,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
} from "antd";
import { React, useTypedRedux } from "@cocalc/frontend/app-framework";
import type {
  Host,
  HostAutoGrowConfig,
  HostCatalog,
} from "@cocalc/conat/hub/api/hosts";
import type { HostProvider } from "../types";
import { getDiskTypeOptions } from "../constants";
import { HostCreateForm } from "./host-create-form";
import { useHostForm } from "../hooks/use-host-form";
import { useHostFormValues } from "../hooks/use-host-form-values";
import {
  filterFieldSchemaForCaps,
  getProviderDescriptor,
  getProviderOptions,
  getProviderStorageSupport,
} from "../providers/registry";
import type { HostFieldId, ProviderSelection } from "../providers/registry";
import { SshTargetLabel } from "./ssh-target-help";

const NEBIUS_IO_M3_GB = 93;

type HostEditModalProps = {
  open: boolean;
  host?: Host;
  catalog?: HostCatalog;
  providerOptions?: Array<{ value: HostProvider; label: string }>;
  catalogError?: string;
  saving?: boolean;
  onCancel: () => void;
  onSave: (
    id: string,
    values: {
      name: string;
      provider?: HostProvider;
      cpu?: number;
      ram_gb?: number;
      disk_gb?: number;
      disk_type?: string;
      machine_type?: string;
      gpu_type?: string;
      storage_mode?: string;
      region?: string;
      zone?: string;
      self_host_ssh_target?: string;
      auto_grow_enabled?: boolean;
      auto_grow_max_disk_gb?: number;
      auto_grow_growth_step_gb?: number;
      auto_grow_min_grow_interval_minutes?: number;
    },
  ) => Promise<void> | void;
  onProviderChange?: (provider: HostProvider) => void;
};

export const HostEditModal: React.FC<HostEditModalProps> = ({
  open,
  host,
  catalog,
  providerOptions = [],
  catalogError,
  saving,
  onCancel,
  onSave,
  onProviderChange,
}) => {
  const [form] = Form.useForm();
  const isSelfHost = host?.machine?.cloud === "self-host";
  const isDeprovisioned = host?.status === "deprovisioned";
  const isStopped = host?.status === "off";
  const canEditMachine = isDeprovisioned || isStopped;
  const lockRegionZone = isStopped && !isDeprovisioned;
  const watchedProvider = Form.useWatch("provider", form) as
    | HostProvider
    | undefined;
  const hostProviderId = (host?.machine?.cloud ?? "none") as HostProvider;
  const providerId = isDeprovisioned
    ? (watchedProvider ?? hostProviderId)
    : hostProviderId;
  const enabledProviders = React.useMemo(
    () => providerOptions.map((option) => option.value),
    [providerOptions],
  );
  const {
    selectedRegion,
    selectedZone,
    selectedMachineType,
    selectedGpuType,
    selectedSelfHostKind,
    selectedSelfHostMode,
    selectedGpu,
    selectedSize,
    selectedStorageMode,
  } = useHostFormValues(form);
  const selfHostKind = (selectedSelfHostKind ??
    host?.machine?.metadata?.self_host_kind ??
    "direct") as string;
  const isDirect = selfHostKind === "direct";
  const selfHostAlphaEnabled = !!useTypedRedux(
    "customize",
    "project_hosts_self_host_alpha_enabled",
  );
  const {
    fieldSchema: createFieldSchema,
    fieldOptions: createFieldOptions,
    fieldLabels: createFieldLabels,
    fieldTooltips: createFieldTooltips,
    supportsPersistentStorage,
    persistentGrowable,
    storageModeOptions,
    showDiskFields: createShowDiskFields,
  } = useHostForm({
    form,
    catalog,
    selectedProvider: providerId,
    selectedRegion,
    selectedZone,
    selectedMachineType,
    selectedGpuType,
    selectedSelfHostKind,
    selectedSelfHostMode,
    selectedSize,
    selectedGpu,
    selectedStorageMode,
    enabledProviders,
  });
  const createProviderVm = React.useMemo(
    () => ({
      providerOptions,
      selectedProvider: providerId ?? providerOptions[0]?.value ?? "none",
      fields: {
        schema: createFieldSchema,
        options: createFieldOptions,
        labels: createFieldLabels,
        tooltips: createFieldTooltips,
      },
      storage: {
        storageModeOptions,
        supportsPersistentStorage,
        persistentGrowable,
        showDiskFields: createShowDiskFields,
      },
      catalogError,
    }),
    [
      providerOptions,
      providerId,
      createFieldSchema,
      createFieldOptions,
      createFieldLabels,
      createFieldTooltips,
      storageModeOptions,
      supportsPersistentStorage,
      persistentGrowable,
      createShowDiskFields,
      catalogError,
    ],
  );
  const handleProviderChange = (value: HostProvider) => {
    onProviderChange?.(value);
  };
  const providerCaps =
    providerId && catalog?.provider_capabilities
      ? catalog.provider_capabilities[providerId]
      : undefined;
  const providerDescriptor =
    providerId !== "none" ? getProviderDescriptor(providerId) : undefined;
  const fieldSchema = providerDescriptor
    ? filterFieldSchemaForCaps(providerDescriptor.fields, providerCaps)
    : { primary: [], advanced: [] };
  const watchedRegion = Form.useWatch("region", form);
  const watchedZone = Form.useWatch("zone", form);
  const watchedMachineType = Form.useWatch("machine_type", form);
  const watchedGpuType = Form.useWatch("gpu_type", form);
  const watchedSize = Form.useWatch("size", form);
  const hideAdvanced = providerId === "self-host";
  const selection: ProviderSelection = {
    region: watchedRegion ?? host?.region ?? undefined,
    zone: watchedZone ?? host?.machine?.zone ?? undefined,
    machine_type:
      watchedMachineType ?? host?.machine?.machine_type ?? undefined,
    gpu_type: watchedGpuType ?? host?.machine?.gpu_type ?? undefined,
    size:
      watchedMachineType ??
      watchedSize ??
      host?.machine?.machine_type ??
      host?.size ??
      undefined,
    gpu: host?.gpu ? "true" : undefined,
  };
  const fieldOptions = providerDescriptor
    ? getProviderOptions(providerId, catalog, selection)
    : {};
  const gcpCompatibilityWarning = React.useMemo(() => {
    if (providerId !== "gcp") return null;
    const compatibilityOptions = isDeprovisioned
      ? createFieldOptions
      : fieldOptions;
    const gpuType =
      watchedGpuType && watchedGpuType !== "none" ? watchedGpuType : undefined;
    if (!gpuType) return null;
    const regionOption = (compatibilityOptions.region ?? []).find(
      (opt) => opt.value === watchedRegion,
    );
    const regionMeta = (regionOption?.meta ?? {}) as {
      compatible?: boolean;
      compatibleZone?: string;
    };
    if (regionMeta.compatible === false) {
      const compatibleRegions = (compatibilityOptions.region ?? []).filter(
        (opt) => {
          const meta = opt.meta as { compatible?: boolean } | undefined;
          return meta?.compatible === true;
        },
      );
      return { type: "region" as const, compatibleRegions };
    }
    if (!watchedZone) return null;
    const zoneOption = (compatibilityOptions.zone ?? []).find(
      (opt) => opt.value === watchedZone,
    );
    const zoneMeta = (zoneOption?.meta ?? {}) as {
      compatible?: boolean;
      region?: string;
    };
    if (zoneMeta.compatible !== false) return null;
    const compatibleZones = (compatibilityOptions.zone ?? []).filter((opt) => {
      const meta = opt.meta as { compatible?: boolean } | undefined;
      return meta?.compatible === true;
    });
    return { type: "zone" as const, compatibleZones };
  }, [
    createFieldOptions,
    fieldOptions.region,
    fieldOptions.zone,
    isDeprovisioned,
    providerId,
    watchedGpuType,
    watchedRegion,
    watchedZone,
  ]);
  const storageSupport = providerDescriptor
    ? getProviderStorageSupport(providerId, catalog?.provider_capabilities)
    : { supported: false, growable: false };
  const diskTypeOptions = getDiskTypeOptions(providerId);
  const defaultDiskType =
    providerId === "nebius" ? "ssd_io_m3" : diskTypeOptions[0]?.value;
  const supportsDiskResize = !!providerCaps?.supportsDiskResize;
  const diskResizeRequiresStop = !!providerCaps?.diskResizeRequiresStop;
  const diskResizeBlocked =
    !isSelfHost &&
    !isDeprovisioned &&
    diskResizeRequiresStop &&
    host?.status !== "off";
  const readPositive = (value: unknown) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.floor(parsed);
  };
  const currentCpu = readPositive(host?.machine?.metadata?.cpu);
  const currentRam = readPositive(host?.machine?.metadata?.ram_gb);
  const currentDisk = readPositive(host?.machine?.disk_gb);
  const diskMin = isDeprovisioned ? 10 : (currentDisk ?? 10);
  const diskMax = Math.max(2000, diskMin);
  const watchedDiskType = Form.useWatch("disk_type", form);
  const isNebiusIoM3 =
    providerId === "nebius" && watchedDiskType === "ssd_io_m3";
  const diskStep = isNebiusIoM3 ? NEBIUS_IO_M3_GB : 1;
  const diskMinAdjusted = isNebiusIoM3
    ? Math.ceil(diskMin / NEBIUS_IO_M3_GB) * NEBIUS_IO_M3_GB
    : diskMin;
  const normalizeDiskValue = React.useCallback(
    (value: number) => {
      if (!isNebiusIoM3) return value;
      const rounded = Math.ceil(value / NEBIUS_IO_M3_GB) * NEBIUS_IO_M3_GB;
      return Math.max(diskMinAdjusted, rounded);
    },
    [diskMinAdjusted, isNebiusIoM3],
  );
  const storageMode = host?.machine?.storage_mode ?? "persistent";
  const showDiskFields = isSelfHost
    ? !isDirect
    : isDeprovisioned || (supportsDiskResize && storageMode !== "ephemeral");
  const currentAutoGrow = React.useMemo(() => {
    const metadata = (host?.machine?.metadata ?? {}) as Record<string, any>;
    const nested = (metadata.auto_grow ?? {}) as HostAutoGrowConfig;
    return {
      enabled:
        nested.enabled ??
        (typeof metadata.auto_grow_enabled === "boolean"
          ? metadata.auto_grow_enabled
          : false),
      max_disk_gb: readPositive(
        nested.max_disk_gb ?? metadata.auto_grow_max_disk_gb,
      ),
      growth_step_gb: readPositive(
        nested.growth_step_gb ?? metadata.auto_grow_growth_step_gb,
      ),
      min_grow_interval_minutes: readPositive(
        nested.min_grow_interval_minutes ??
          metadata.auto_grow_min_grow_interval_minutes,
      ),
    };
  }, [host]);
  const autoGrowDefaultMaxDisk = Math.max(currentDisk ?? 100, 500);
  const showAutoGrowControls =
    providerId === "gcp" &&
    (isDeprovisioned
      ? selectedStorageMode !== "ephemeral" && storageSupport.growable
      : showDiskFields && storageMode !== "ephemeral");
  const watchedAutoGrowEnabled = Form.useWatch("auto_grow_enabled", form);
  const showAdvancedSection =
    isDeprovisioned &&
    ((providerDescriptor && fieldSchema.advanced.length > 0) ||
      storageSupport.supported);
  const initRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      initRef.current = null;
      return;
    }
    if (!host) {
      initRef.current = null;
      form.resetFields();
      return;
    }
    if (initRef.current === host.id) return;
    initRef.current = host.id;
    form.setFieldsValue({
      name: host.name,
      provider: host.machine?.cloud ?? providerOptions[0]?.value,
      cpu: currentCpu ?? 2,
      ram_gb: currentRam ?? 8,
      disk_gb: currentDisk ?? 100,
      disk: currentDisk ?? 100,
      region: host.region ?? undefined,
      zone: host.machine?.zone ?? undefined,
      machine_type: host.machine?.machine_type ?? undefined,
      gpu_type: host.machine?.gpu_type ?? "none",
      size: host.machine?.machine_type ?? host.size ?? undefined,
      storage_mode: storageMode,
      disk_type: host.machine?.disk_type,
      self_host_ssh_target: host.machine?.metadata?.self_host_ssh_target,
      auto_grow_enabled: currentAutoGrow.enabled,
      auto_grow_max_disk_gb:
        currentAutoGrow.max_disk_gb ?? autoGrowDefaultMaxDisk,
      auto_grow_growth_step_gb: currentAutoGrow.growth_step_gb ?? 50,
      auto_grow_min_grow_interval_minutes:
        currentAutoGrow.min_grow_interval_minutes ?? 60,
    });
  }, [
    autoGrowDefaultMaxDisk,
    currentCpu,
    currentAutoGrow.enabled,
    currentAutoGrow.growth_step_gb,
    currentAutoGrow.max_disk_gb,
    currentAutoGrow.min_grow_interval_minutes,
    currentDisk,
    currentRam,
    form,
    host,
    open,
    providerOptions,
    storageMode,
  ]);
  React.useEffect(() => {
    if (!isDeprovisioned) return;
    if (!diskTypeOptions.length) return;
    const hasDiskType =
      watchedDiskType &&
      diskTypeOptions.some((opt) => opt.value === watchedDiskType);
    if (!hasDiskType) {
      form.setFieldsValue({ disk_type: defaultDiskType });
    }
  }, [
    defaultDiskType,
    diskTypeOptions,
    form,
    isDeprovisioned,
    watchedDiskType,
  ]);
  React.useEffect(() => {
    if (isDeprovisioned) return;
    if (lockRegionZone) return;
    const zoneOptions = fieldOptions.zone ?? [];
    if (!zoneOptions.length) return;
    const hasZone =
      watchedZone && zoneOptions.some((opt) => opt.value === watchedZone);
    if (!hasZone) {
      form.setFieldsValue({ zone: zoneOptions[0]?.value });
    }
  }, [fieldOptions.zone, form, isDeprovisioned, lockRegionZone, watchedZone]);

  const handleOk = async () => {
    const values = await form.validateFields();
    if (!host) return;
    await onSave(host.id, values);
  };

  const ensureFieldValue = React.useCallback(
    (
      field: "region" | "zone" | "machine_type" | "size" | "gpu_type",
      current?: string,
    ) => {
      const options = fieldOptions[field] ?? [];
      if (!options.length) return;
      if (!current || !options.some((opt) => opt.value === current)) {
        form.setFieldsValue({ [field]: options[0]?.value });
      }
    },
    [fieldOptions, form],
  );

  React.useEffect(() => {
    if (isDeprovisioned) return;
    if (lockRegionZone) return;
    ensureFieldValue("region", watchedRegion);
  }, [ensureFieldValue, isDeprovisioned, lockRegionZone, watchedRegion]);

  React.useEffect(() => {
    if (isDeprovisioned) return;
    if (lockRegionZone) return;
    ensureFieldValue("zone", watchedZone);
  }, [ensureFieldValue, isDeprovisioned, lockRegionZone, watchedZone]);

  React.useEffect(() => {
    if (isDeprovisioned) return;
    ensureFieldValue("machine_type", watchedMachineType);
  }, [ensureFieldValue, isDeprovisioned, watchedMachineType]);

  React.useEffect(() => {
    if (isDeprovisioned) return;
    ensureFieldValue("size", watchedSize);
  }, [ensureFieldValue, isDeprovisioned, watchedSize]);

  React.useEffect(() => {
    if (isDeprovisioned) return;
    ensureFieldValue("gpu_type", watchedGpuType);
  }, [ensureFieldValue, isDeprovisioned, watchedGpuType]);

  const renderField = (field: HostFieldId) => {
    if (
      providerId === "self-host" &&
      !selfHostAlphaEnabled &&
      (field === "self_host_kind" || field === "self_host_mode")
    ) {
      return null;
    }
    const fieldOpts = fieldOptions[field] ?? [];
    const label =
      fieldSchema.labels?.[field] ??
      field
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    const tooltip = fieldSchema.tooltips?.[field];
    const isLocked = lockRegionZone && (field === "region" || field === "zone");
    return (
      <Form.Item
        key={field}
        name={field}
        label={label}
        tooltip={tooltip}
        initialValue={fieldOpts[0]?.value}
      >
        <Select options={fieldOpts} disabled={!fieldOpts.length || isLocked} />
      </Form.Item>
    );
  };

  const disableSave = !!gcpCompatibilityWarning;

  return (
    <Modal
      title="Edit host"
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      confirmLoading={saving}
      okText="Save"
      okButtonProps={{ disabled: disableSave }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        {isDeprovisioned ? (
          <HostCreateForm
            form={form}
            canCreateHosts={true}
            provider={createProviderVm}
            onProviderChange={handleProviderChange}
            wrapForm={false}
          />
        ) : (
          <>
            <Form.Item
              label="Name"
              name="name"
              rules={[
                { required: true, message: "Please enter a name" },
                { max: 100, message: "Name is too long" },
              ]}
            >
              <Input placeholder="Host name" />
            </Form.Item>
            {canEditMachine &&
              providerDescriptor &&
              fieldSchema.primary.map(renderField)}
          </>
        )}
        {canEditMachine && gcpCompatibilityWarning?.type === "region" && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            title="Selected GPU isn't available in this region."
            description={
              gcpCompatibilityWarning.compatibleRegions.length &&
              !lockRegionZone ? (
                <Select
                  placeholder="Choose a compatible region"
                  options={gcpCompatibilityWarning.compatibleRegions}
                  onChange={(value) => {
                    const regionOption =
                      gcpCompatibilityWarning.compatibleRegions.find(
                        (opt) => opt.value === value,
                      );
                    const meta = (regionOption?.meta ?? {}) as {
                      compatibleZone?: string;
                    };
                    form.setFieldsValue({
                      region: value,
                      zone: meta.compatibleZone ?? undefined,
                    });
                  }}
                />
              ) : (
                "Choose a GPU compatible with the selected region."
              )
            }
          />
        )}
        {canEditMachine && gcpCompatibilityWarning?.type === "zone" && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            title="Selected GPU isn't available in this zone."
            description={
              gcpCompatibilityWarning.compatibleZones.length &&
              !lockRegionZone ? (
                <Select
                  placeholder="Choose a compatible zone"
                  options={gcpCompatibilityWarning.compatibleZones}
                  onChange={(value) => {
                    const zoneOption =
                      gcpCompatibilityWarning.compatibleZones.find(
                        (opt) => opt.value === value,
                      );
                    const meta = (zoneOption?.meta ?? {}) as {
                      region?: string;
                    };
                    form.setFieldsValue({
                      zone: value,
                      region: meta.region ?? undefined,
                    });
                  }}
                />
              ) : (
                "Choose a GPU compatible with the selected zone."
              )
            }
          />
        )}
        {isSelfHost && (
          <Form.Item
            label={<SshTargetLabel label="SSH target (optional)" />}
            name="self_host_ssh_target"
          >
            <Input placeholder="user@host[:port] or ssh-config name" />
          </Form.Item>
        )}
        {!isDeprovisioned && isSelfHost && !isDirect && (
          <>
            <Form.Item
              label="vCPU"
              name="cpu"
              tooltip="Update requires a brief stop/start of the VM."
              extra="Safe range: 1–64 vCPU"
            >
              <InputNumber min={1} max={64} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item
              label="Memory (GB)"
              name="ram_gb"
              tooltip="Update requires a brief stop/start of the VM."
              extra="Safe range: 1–512 GB"
            >
              <InputNumber min={1} max={512} style={{ width: "100%" }} />
            </Form.Item>
          </>
        )}
        {!isDeprovisioned && showDiskFields && (
          <Form.Item
            label="Disk size (GB)"
            name="disk_gb"
            tooltip={
              isDeprovisioned
                ? "Disk size is applied on next provision."
                : `Disk can only grow while provisioned.${
                    isNebiusIoM3
                      ? " SSD IO M3 requires multiples of 93 GB."
                      : ""
                  }`
            }
            extra={
              diskResizeBlocked
                ? "Stop the VM before resizing the disk."
                : isDeprovisioned
                  ? undefined
                  : `Current minimum: ${diskMinAdjusted} GB (grow only)`
            }
          >
            <InputNumber
              min={diskMinAdjusted}
              max={diskMax}
              step={diskStep}
              style={{ width: "100%" }}
              disabled={diskResizeBlocked}
              onChange={(value) => {
                if (typeof value !== "number" || Number.isNaN(value)) {
                  return;
                }
                const normalized = normalizeDiskValue(value);
                if (normalized !== value) {
                  form.setFieldsValue({ disk_gb: normalized });
                }
              }}
            />
          </Form.Item>
        )}
        {showAutoGrowControls && (
          <Collapse ghost style={{ marginBottom: 8 }} defaultActiveKey={[]}>
            <Collapse.Panel header="Auto-grow" key="auto-grow">
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="Guarded auto-grow"
                description="If a large OCI or RootFS pull is denied by storage reservations, CoCalc can grow this host's persistent disk once and retry. This is currently intended for GCP hosts."
              />
              <Form.Item
                label="Enable guarded auto-grow"
                name="auto_grow_enabled"
                valuePropName="checked"
                extra="Only used after an explicit storage reservation failure. Growth is capped and rate-limited."
              >
                <Switch />
              </Form.Item>
              {watchedAutoGrowEnabled && (
                <>
                  <Form.Item
                    label="Maximum disk size (GB)"
                    name="auto_grow_max_disk_gb"
                    dependencies={["disk_gb"]}
                    rules={[
                      ({ getFieldValue }) => ({
                        validator(_, value) {
                          const parsed = Number(value);
                          if (!Number.isFinite(parsed) || parsed <= 0) {
                            return Promise.reject(
                              new Error(
                                "Enter the largest disk size this host may auto-grow to",
                              ),
                            );
                          }
                          const currentConfiguredDisk = Number(
                            getFieldValue("disk_gb") ?? currentDisk ?? 0,
                          );
                          if (
                            Number.isFinite(currentConfiguredDisk) &&
                            currentConfiguredDisk > 0 &&
                            parsed < currentConfiguredDisk
                          ) {
                            return Promise.reject(
                              new Error(
                                `Maximum disk must be at least ${currentConfiguredDisk} GB`,
                              ),
                            );
                          }
                          return Promise.resolve();
                        },
                      }),
                    ]}
                    extra="The disk will never auto-grow past this limit."
                  >
                    <InputNumber
                      min={diskMinAdjusted}
                      max={10000}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                  <Form.Item
                    label="Growth step (GB)"
                    name="auto_grow_growth_step_gb"
                    rules={[
                      {
                        required: true,
                        message: "Enter how much to grow the disk per step",
                      },
                    ]}
                    extra="Each auto-grow increases the disk by this amount before retrying once."
                  >
                    <InputNumber min={1} max={2000} style={{ width: "100%" }} />
                  </Form.Item>
                  <Form.Item
                    label="Minimum minutes between grows"
                    name="auto_grow_min_grow_interval_minutes"
                    rules={[
                      {
                        required: true,
                        message:
                          "Enter the cooldown between auto-grow attempts",
                      },
                    ]}
                    extra="Prevents repeated disk expansions when a host is under pressure."
                  >
                    <InputNumber
                      min={1}
                      max={7 * 24 * 60}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </>
              )}
            </Collapse.Panel>
          </Collapse>
        )}
        {!isDeprovisioned && showAdvancedSection && !hideAdvanced && (
          <Collapse ghost style={{ marginBottom: 8 }}>
            <Collapse.Panel header="Advanced options" key="advanced">
              {providerDescriptor && fieldSchema.advanced.map(renderField)}
              {isDeprovisioned && storageSupport.supported && (
                <>
                  <Form.Item
                    label="Storage mode"
                    name="storage_mode"
                    tooltip="Ephemeral uses local disks; persistent uses a separate disk."
                  >
                    <Select
                      options={[
                        { value: "ephemeral", label: "Ephemeral (local)" },
                        {
                          value: "persistent",
                          label: storageSupport.growable
                            ? "Persistent (growable disk)"
                            : "Persistent (fixed size)",
                        },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item label="Disk type" name="disk_type">
                    <Select
                      options={diskTypeOptions}
                      disabled={!diskTypeOptions.length}
                    />
                  </Form.Item>
                </>
              )}
            </Collapse.Panel>
          </Collapse>
        )}
      </Form>
    </Modal>
  );
};
