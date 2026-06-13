import {
  Alert,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Segmented,
  Slider,
  Switch,
  Tag,
  Typography,
} from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  mapCloudRegionToR2Region,
  mapCountryRegionToR2Region,
  R2_REGION_LABELS,
} from "@cocalc/util/consts";
import { MIN_PROJECT_HOST_DISK_GB } from "@cocalc/util/project-host-limits";
import { COLORS } from "@cocalc/util/theme";
import type { HostCreateViewModel } from "../hooks/use-host-create-view-model";
import { getDiskTypeOptions } from "../constants";
import { isNebiusSpotSupported } from "../providers/registry";
import type { HostFieldId } from "../providers/registry";
import {
  getMachineTypeSortOptions,
  HostOptionsSelect,
  type MachineTypeSortMode,
  sortMachineTypeOptions,
} from "./host-options-select";
import { SshTargetLabel } from "./ssh-target-help";
import { useMachineTypeSortMode } from "../hooks/use-machine-type-sort-mode";
import { HostSharedScratchFields } from "./host-shared-scratch-fields";

const MIN_DISK_SIZE = MIN_PROJECT_HOST_DISK_GB;
const MAX_DISK_SIZE = 10_000;
const INITIAL_DISK_SIZE = 100;
const NEBIUS_IO_M3_GB = 93;
const FIELD_GROUP_STYLE: React.CSSProperties = {
  background: COLORS.GRAY_LLL,
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: 10,
  marginBottom: 8,
  padding: "8px 10px 0",
};

type HostCreateProviderFieldsProps = {
  provider: HostCreateViewModel["provider"];
  onProviderChange?: (value: string) => void;
  hideProviderSelect?: boolean;
  draftManaged?: boolean;
  onDraftPatch?: (patch: Record<string, any>) => void;
};

export const HostCreateProviderFields: React.FC<
  HostCreateProviderFieldsProps
> = ({
  provider,
  onProviderChange,
  hideProviderSelect = false,
  draftManaged = false,
  onDraftPatch,
}) => {
  const { providerOptions, selectedProvider, fields, catalogError, storage } =
    provider;
  const { schema, options, labels, tooltips } = fields;
  const { persistentGrowable, showDiskFields } = storage;
  const form = Form.useFormInstance();
  const setFormFields = React.useCallback(
    (patch: Record<string, any>) => {
      form.setFieldsValue(patch);
      if (draftManaged) {
        onDraftPatch?.(patch);
      }
    },
    [draftManaged, form, onDraftPatch],
  );
  const watchedRegion = Form.useWatch("region", form);
  const watchedZone = Form.useWatch("zone", form);
  const watchedMachineType = Form.useWatch("machine_type", form);
  const watchedSize = Form.useWatch("size", form);
  const watchedGpuType = Form.useWatch("gpu_type", form);
  const watchedPricingModel = Form.useWatch("pricing_model", form);
  const watchedStorageMode = Form.useWatch("storage_mode", form);
  const watchedDisk = Form.useWatch("disk", form);
  const watchedDiskGb = Form.useWatch("disk_gb", form);
  const watchedDiskType = Form.useWatch("disk_type", form);
  const watchedAutoGrowEnabled = Form.useWatch("auto_grow_enabled", form);
  const watchedAutoGrowMaxDiskGb = Form.useWatch("auto_grow_max_disk_gb", form);
  const watchedAutoGrowGrowthStepGb = Form.useWatch(
    "auto_grow_growth_step_gb",
    form,
  );
  const watchedAutoGrowMinIntervalMinutes = Form.useWatch(
    "auto_grow_min_grow_interval_minutes",
    form,
  );
  const watchedSelfHostKind = Form.useWatch("self_host_kind", form);
  const watchedSelfHostMode = Form.useWatch("self_host_mode", form);
  const watchedSelfHostTarget = Form.useWatch("self_host_ssh_target", form);
  const watchedRegionPreference = Form.useWatch("region_preference", form);
  const showRegionPreference =
    (selectedProvider === "gcp" || selectedProvider === "nebius") &&
    schema.primary.includes("region");
  const showPriceDisplay = showRegionPreference;
  const selfHostAlphaEnabled = !!useTypedRedux(
    "customize",
    "project_hosts_self_host_alpha_enabled",
  );
  const cloudflareCountry = useTypedRedux("customize", "country");
  const cloudflareRegionCode = useTypedRedux(
    "customize",
    "cloudflare_region_code",
  );
  const preferredR2Region = React.useMemo(
    () => mapCountryRegionToR2Region(cloudflareCountry, cloudflareRegionCode),
    [cloudflareCountry, cloudflareRegionCode],
  );
  const preferredR2RegionLabel = R2_REGION_LABELS[preferredR2Region];
  const [machineTypeSortMode, setMachineTypeSortMode] =
    useMachineTypeSortMode();
  const supportsMachineBenchmarks = selectedProvider === "gcp";
  const effectiveMachineTypeSortMode: MachineTypeSortMode =
    supportsMachineBenchmarks
      ? machineTypeSortMode
      : machineTypeSortMode === "price"
        ? "price"
        : "type";
  const displayOptions = React.useMemo(
    () => ({
      ...options,
      machine_type: sortMachineTypeOptions(
        options.machine_type,
        effectiveMachineTypeSortMode,
      ),
    }),
    [effectiveMachineTypeSortMode, options],
  );
  const nebiusSpotSupported = React.useMemo(
    () =>
      selectedProvider !== "nebius" ||
      isNebiusSpotSupported(displayOptions.machine_type, watchedMachineType),
    [displayOptions.machine_type, selectedProvider, watchedMachineType],
  );
  const showSpotHint =
    watchedRegionPreference === "cheapest" &&
    watchedPricingModel !== "spot" &&
    (selectedProvider === "gcp" ||
      (selectedProvider === "nebius" && nebiusSpotSupported));
  const diskTypeOptions = getDiskTypeOptions(selectedProvider);
  const defaultDiskType =
    selectedProvider === "nebius" ? "ssd_io_m3" : diskTypeOptions[0]?.value;
  React.useEffect(() => {
    if (draftManaged) return;
    if (!showDiskFields || !diskTypeOptions.length) return;
    if (!watchedDiskType) {
      setFormFields({ disk_type: defaultDiskType });
    }
  }, [
    defaultDiskType,
    diskTypeOptions.length,
    setFormFields,
    showDiskFields,
    watchedDiskType,
    draftManaged,
  ]);
  React.useEffect(() => {
    if (draftManaged) return;
    if (selectedProvider !== "gcp") return;
    if (watchedStorageMode === "persistent") return;
    setFormFields({ storage_mode: "persistent" });
  }, [draftManaged, selectedProvider, setFormFields, watchedStorageMode]);
  const isNebiusPersistentDisk = selectedProvider === "nebius";
  const diskMin = isNebiusPersistentDisk
    ? Math.ceil(MIN_DISK_SIZE / NEBIUS_IO_M3_GB) * NEBIUS_IO_M3_GB
    : MIN_DISK_SIZE;
  const diskStep = isNebiusPersistentDisk ? NEBIUS_IO_M3_GB : 1;
  const diskValue =
    typeof watchedDiskGb === "number" && Number.isFinite(watchedDiskGb)
      ? watchedDiskGb
      : typeof watchedDisk === "number" && Number.isFinite(watchedDisk)
        ? watchedDisk
        : INITIAL_DISK_SIZE;
  const showMainAutoGrowControls =
    selectedProvider === "gcp" &&
    showDiskFields &&
    watchedStorageMode !== "ephemeral" &&
    persistentGrowable;
  const autoGrowDefaultMaxDisk = Math.max(diskValue, 500);
  const normalizeDiskValue = React.useCallback(
    (value: number) => {
      if (!isNebiusPersistentDisk) return value;
      const rounded = Math.ceil(value / NEBIUS_IO_M3_GB) * NEBIUS_IO_M3_GB;
      return Math.max(diskMin, rounded);
    },
    [diskMin, isNebiusPersistentDisk],
  );
  React.useEffect(() => {
    if (draftManaged) return;
    if (!isNebiusPersistentDisk) return;
    const normalized = normalizeDiskValue(diskValue);
    if (normalized !== diskValue) {
      setFormFields({ disk: normalized, disk_gb: normalized });
    }
  }, [
    diskValue,
    draftManaged,
    isNebiusPersistentDisk,
    normalizeDiskValue,
    setFormFields,
  ]);
  React.useEffect(() => {
    if (draftManaged) return;
    if (!showDiskFields) return;
    if (
      (typeof watchedDisk === "number" && Number.isFinite(watchedDisk)) ||
      (typeof watchedDiskGb === "number" && Number.isFinite(watchedDiskGb))
    ) {
      return;
    }
    setFormFields({ disk: diskMin, disk_gb: diskMin });
  }, [
    diskMin,
    draftManaged,
    setFormFields,
    showDiskFields,
    watchedDisk,
    watchedDiskGb,
  ]);
  React.useEffect(() => {
    if (!showMainAutoGrowControls) {
      const patch: Record<string, any> = {};
      if (form.getFieldValue("auto_grow_enabled") !== false) {
        patch.auto_grow_enabled = false;
      }
      for (const field of [
        "auto_grow_max_disk_gb",
        "auto_grow_growth_step_gb",
        "auto_grow_min_grow_interval_minutes",
      ]) {
        if (form.getFieldValue(field) !== undefined) {
          patch[field] = undefined;
        }
      }
      if (Object.keys(patch).length > 0) {
        setFormFields(patch);
      }
      return;
    }
    if (!watchedAutoGrowEnabled) return;
    const patch: Record<string, any> = {};
    if (
      typeof watchedAutoGrowMaxDiskGb !== "number" ||
      !Number.isFinite(watchedAutoGrowMaxDiskGb) ||
      watchedAutoGrowMaxDiskGb < diskValue
    ) {
      patch.auto_grow_max_disk_gb = autoGrowDefaultMaxDisk;
    }
    if (
      typeof watchedAutoGrowGrowthStepGb !== "number" ||
      !Number.isFinite(watchedAutoGrowGrowthStepGb)
    ) {
      patch.auto_grow_growth_step_gb = 50;
    }
    if (
      typeof watchedAutoGrowMinIntervalMinutes !== "number" ||
      !Number.isFinite(watchedAutoGrowMinIntervalMinutes)
    ) {
      patch.auto_grow_min_grow_interval_minutes = 60;
    }
    if (Object.keys(patch).length > 0) {
      setFormFields(patch);
    }
  }, [
    autoGrowDefaultMaxDisk,
    diskValue,
    form,
    setFormFields,
    showMainAutoGrowControls,
    watchedAutoGrowEnabled,
    watchedAutoGrowGrowthStepGb,
    watchedAutoGrowMaxDiskGb,
    watchedAutoGrowMinIntervalMinutes,
  ]);
  const gcpCompatibilityWarning = React.useMemo(() => {
    if (selectedProvider !== "gcp") return null;
    const machineType =
      watchedMachineType && watchedMachineType.trim()
        ? watchedMachineType.trim()
        : undefined;
    const gpuType =
      watchedGpuType && watchedGpuType !== "none" ? watchedGpuType : undefined;
    if (!gpuType && !machineType) return null;
    const subject = gpuType ? "GPU" : "machine type";
    const regionOption = (options.region ?? []).find(
      (opt) => opt.value === watchedRegion,
    );
    const regionMeta = (regionOption?.meta ?? {}) as {
      compatible?: boolean;
      compatibleZone?: string;
    };
    if (regionMeta.compatible === false) {
      const compatibleRegions = (options.region ?? []).filter((opt) => {
        const meta = opt.meta as { compatible?: boolean } | undefined;
        return meta?.compatible === true;
      });
      return { type: "region" as const, compatibleRegions, subject };
    }
    if (!watchedZone) return null;
    const zoneOption = (options.zone ?? []).find(
      (opt) => opt.value === watchedZone,
    );
    const zoneMeta = (zoneOption?.meta ?? {}) as {
      compatible?: boolean;
      region?: string;
    };
    if (zoneMeta.compatible !== false) return null;
    const compatibleZones = (options.zone ?? []).filter((opt) => {
      const meta = opt.meta as { compatible?: boolean } | undefined;
      return meta?.compatible === true;
    });
    return { type: "zone" as const, compatibleZones, subject };
  }, [
    options.machine_type,
    options.region,
    options.zone,
    selectedProvider,
    watchedMachineType,
    watchedGpuType,
    watchedRegion,
    watchedZone,
  ]);
  const ensureFieldValue = React.useCallback(
    (field: HostFieldId, current?: string) => {
      const fieldOptions = displayOptions[field] ?? [];
      if (!fieldOptions.length) return;
      if (!current || !fieldOptions.some((opt) => opt.value === current)) {
        setFormFields({ [field]: fieldOptions[0]?.value });
      }
    },
    [displayOptions, setFormFields],
  );

  React.useEffect(() => {
    if (draftManaged) return;
    ensureFieldValue("region", watchedRegion);
  }, [draftManaged, ensureFieldValue, watchedRegion]);

  React.useEffect(() => {
    if (draftManaged) return;
    ensureFieldValue("zone", watchedZone);
  }, [draftManaged, ensureFieldValue, watchedZone]);

  React.useEffect(() => {
    if (draftManaged) return;
    ensureFieldValue("machine_type", watchedMachineType);
  }, [draftManaged, ensureFieldValue, watchedMachineType]);

  React.useEffect(() => {
    if (draftManaged) return;
    ensureFieldValue("size", watchedSize);
  }, [draftManaged, ensureFieldValue, watchedSize]);

  React.useEffect(() => {
    if (draftManaged) return;
    ensureFieldValue("gpu_type", watchedGpuType);
  }, [draftManaged, ensureFieldValue, watchedGpuType]);

  React.useEffect(() => {
    if (draftManaged) return;
    ensureFieldValue("self_host_kind", form.getFieldValue("self_host_kind"));
  }, [draftManaged, ensureFieldValue, form]);

  React.useEffect(() => {
    if (draftManaged) return;
    ensureFieldValue("self_host_mode", form.getFieldValue("self_host_mode"));
  }, [draftManaged, ensureFieldValue, form]);
  const requireSshTarget =
    selectedProvider === "self-host" && !selfHostAlphaEnabled;
  const showSelfHostSshWarning =
    selectedProvider === "self-host" &&
    watchedSelfHostMode === "local" &&
    !String(watchedSelfHostTarget ?? "").trim() &&
    selfHostAlphaEnabled;
  const fieldColumnSpan = (field: HostFieldId) =>
    field === "machine_type" || field === "size"
      ? 16
      : field === "gpu_type" || field === "gpu"
        ? 8
        : 12;
  const renderField = (field: HostFieldId) => {
    if (
      selectedProvider === "self-host" &&
      !selfHostAlphaEnabled &&
      (field === "self_host_kind" || field === "self_host_mode")
    ) {
      return null;
    }
    const showCloudflareRegionColumn =
      field === "region" &&
      (selectedProvider === "gcp" || selectedProvider === "nebius");
    const fieldOptions = showCloudflareRegionColumn
      ? (displayOptions[field] ?? []).map((opt) => {
          const r2Region = mapCloudRegionToR2Region(opt.value);
          return {
            ...opt,
            detailLabel: R2_REGION_LABELS[r2Region],
          };
        })
      : (displayOptions[field] ?? []);
    const label =
      labels[field] ??
      field
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    const tooltip = tooltips[field];
    const showMachineTypeSort =
      field === "machine_type" &&
      fieldOptions.length > 1 &&
      fieldOptions.some(
        (option) =>
          !!option.priceLabel ||
          (typeof option.hourlyRate === "number" &&
            Number.isFinite(option.hourlyRate)),
      );
    const itemLabel = showMachineTypeSort ? (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          width: "100%",
        }}
      >
        <span>{label}</span>
        <Segmented
          size="small"
          value={effectiveMachineTypeSortMode}
          options={getMachineTypeSortOptions(supportsMachineBenchmarks)}
          onChange={(value) =>
            setMachineTypeSortMode(value as MachineTypeSortMode)
          }
        />
      </div>
    ) : (
      label
    );
    const item = (
      <Col xs={24} md={fieldColumnSpan(field)} key={field}>
        <Form.Item
          name={field}
          label={itemLabel}
          tooltip={tooltip}
          initialValue={draftManaged ? undefined : fieldOptions[0]?.value}
        >
          <HostOptionsSelect
            options={fieldOptions}
            disabled={!fieldOptions.length}
          />
        </Form.Item>
      </Col>
    );
    if (field === "region" && selectedProvider !== "self-host") {
      const regionValue = watchedRegion ?? fieldOptions[0]?.value;
      if (regionValue) {
        const r2Region = mapCloudRegionToR2Region(regionValue);
        const r2Label = R2_REGION_LABELS[r2Region];
        return (
          <Col xs={24} md={fieldColumnSpan(field)} key={field}>
            <Form.Item
              name={field}
              label={itemLabel}
              tooltip={tooltip}
              initialValue={draftManaged ? undefined : fieldOptions[0]?.value}
            >
              <HostOptionsSelect
                options={fieldOptions}
                disabled={!fieldOptions.length}
              />
            </Form.Item>
            <div style={{ marginBottom: 12 }}>
              <Tag>CoCalc Region: {r2Label}</Tag>
            </div>
          </Col>
        );
      }
    }
    return item;
  };

  return (
    <>
      <div style={FIELD_GROUP_STYLE}>
        <Typography.Text strong>Placement preferences</Typography.Text>
        <Row gutter={[10, 0]} style={{ marginTop: 6 }}>
          {!hideProviderSelect && (
            <Col xs={24} md={12}>
              <Form.Item
                name="provider"
                label="Provider"
                initialValue={
                  draftManaged
                    ? undefined
                    : (providerOptions[0]?.value ?? "none")
                }
              >
                <Select options={providerOptions} onChange={onProviderChange} />
              </Form.Item>
            </Col>
          )}
          {showRegionPreference && (
            <Col xs={24} md={12}>
              <Form.Item
                name="region_preference"
                label="Region preference"
                initialValue={draftManaged ? undefined : "cheapest"}
                extra="Sort by location and price."
              >
                <Select
                  options={[
                    { value: "balanced", label: "Balanced" },
                    { value: "closest", label: "Closest" },
                    { value: "cheapest", label: "Cheapest" },
                  ]}
                />
              </Form.Item>
            </Col>
          )}
          {showPriceDisplay && (
            <Col xs={24} md={12}>
              <Form.Item
                name="price_display"
                label="Show prices as"
                initialValue={draftManaged ? undefined : "hourly"}
              >
                <Select
                  options={[
                    { value: "hourly", label: "Hourly" },
                    { value: "monthly", label: "Monthly" },
                  ]}
                />
              </Form.Item>
            </Col>
          )}
        </Row>
      </div>
      <div style={FIELD_GROUP_STYLE}>
        <Typography.Text strong>
          Location and compute{" "}
          {showRegionPreference ? (
            <Typography.Text type="secondary" style={{ fontWeight: "normal" }}>
              (your region: {preferredR2RegionLabel})
            </Typography.Text>
          ) : null}
        </Typography.Text>
        <Row gutter={[10, 0]} style={{ marginTop: 6 }}>
          {schema.primary.map(renderField)}
        </Row>
      </div>
      {showDiskFields && (
        <div style={FIELD_GROUP_STYLE}>
          <Typography.Text strong>Storage</Typography.Text>
          <Form.Item
            label="Disk size (GB)"
            style={{ marginTop: 6 }}
            tooltip={`Disk for storing all projects on this host. Files are compressed and deduplicated. ${
              persistentGrowable
                ? "You can enlarge this disk at any time later."
                : "This disk CANNOT be enlarged later."
            }${isNebiusPersistentDisk ? " Nebius disks require multiples of 93 GB." : ""}`}
          >
            <Row gutter={10} align="middle">
              <Col flex="auto">
                <Slider
                  min={diskMin}
                  max={MAX_DISK_SIZE}
                  step={diskStep}
                  value={diskValue}
                  onChange={(value) => {
                    if (typeof value !== "number" || Number.isNaN(value)) {
                      return;
                    }
                    const normalized = normalizeDiskValue(value);
                    setFormFields({
                      disk: normalized,
                      disk_gb: normalized,
                    });
                  }}
                />
              </Col>
              <Col flex="120px">
                <Form.Item
                  name="disk"
                  initialValue={draftManaged ? undefined : INITIAL_DISK_SIZE}
                  noStyle
                >
                  <InputNumber
                    min={diskMin}
                    max={MAX_DISK_SIZE}
                    step={diskStep}
                    precision={0}
                    style={{ width: "100%" }}
                    onChange={(value) => {
                      if (typeof value !== "number" || Number.isNaN(value)) {
                        return;
                      }
                      const normalized = normalizeDiskValue(value);
                      setFormFields({
                        disk: normalized,
                        disk_gb: normalized,
                      });
                    }}
                  />
                </Form.Item>
              </Col>
            </Row>
          </Form.Item>
          <HostSharedScratchFields
            provider={selectedProvider}
            catalog={provider.catalog}
            draftManaged={draftManaged}
            onDraftPatch={onDraftPatch}
          />
          {showMainAutoGrowControls && (
            <div style={{ marginTop: 12 }}>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                title="Guarded disk auto-grow"
                description="For GCP hosts, CoCalc can grow the main persistent disk after a storage reservation failure, then retry the blocked operation once."
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
                <Row gutter={10}>
                  <Col xs={24} md={8}>
                    <Form.Item
                      label="Maximum disk size (GB)"
                      name="auto_grow_max_disk_gb"
                      dependencies={["disk"]}
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
                            const currentDisk = Number(
                              getFieldValue("disk_gb") ??
                                getFieldValue("disk") ??
                                diskValue,
                            );
                            if (
                              Number.isFinite(currentDisk) &&
                              currentDisk > 0 &&
                              parsed < currentDisk
                            ) {
                              return Promise.reject(
                                new Error(
                                  `Maximum disk must be at least ${currentDisk} GB`,
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
                        min={diskValue}
                        max={MAX_DISK_SIZE}
                        precision={0}
                        style={{ width: "100%" }}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      label="Growth step (GB)"
                      name="auto_grow_growth_step_gb"
                      rules={[
                        {
                          required: true,
                          message: "Enter how much to grow the disk per step",
                        },
                      ]}
                      extra="Each grow increases the disk by this amount."
                    >
                      <InputNumber
                        min={1}
                        max={2000}
                        precision={0}
                        style={{ width: "100%" }}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      label="Cooldown (minutes)"
                      name="auto_grow_min_grow_interval_minutes"
                      rules={[
                        {
                          required: true,
                          message:
                            "Enter the cooldown between auto-grow attempts",
                        },
                      ]}
                      extra="Prevents repeated disk expansions under pressure."
                    >
                      <InputNumber
                        min={1}
                        max={7 * 24 * 60}
                        precision={0}
                        style={{ width: "100%" }}
                      />
                    </Form.Item>
                  </Col>
                </Row>
              )}
            </div>
          )}
        </div>
      )}
      {showSpotHint && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title="Spot instances can be cheaper"
          description="Spot instances can be enabled under Advanced options."
        />
      )}
      {gcpCompatibilityWarning?.type === "region" && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={`Selected ${gcpCompatibilityWarning.subject} isn't available in this region.`}
          description={
            gcpCompatibilityWarning.compatibleRegions.length ? (
              <Select
                popupMatchSelectWidth={false}
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
                  setFormFields({
                    region: value,
                    zone: meta.compatibleZone ?? undefined,
                  });
                }}
              />
            ) : (
              `Try a different ${gcpCompatibilityWarning.subject}.`
            )
          }
        />
      )}
      {gcpCompatibilityWarning?.type === "zone" && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={`Selected ${gcpCompatibilityWarning.subject} isn't available in this zone.`}
          description={
            gcpCompatibilityWarning.compatibleZones.length ? (
              <Select
                popupMatchSelectWidth={false}
                placeholder="Choose a compatible zone"
                options={gcpCompatibilityWarning.compatibleZones}
                onChange={(value) => {
                  const zoneOption =
                    gcpCompatibilityWarning.compatibleZones.find(
                      (opt) => opt.value === value,
                    );
                  const meta = (zoneOption?.meta ?? {}) as { region?: string };
                  setFormFields({
                    zone: value,
                    region: meta.region ?? undefined,
                  });
                }}
              />
            ) : (
              `Try a different region to use this ${gcpCompatibilityWarning.subject}.`
            )
          }
        />
      )}
      {selectedProvider === "self-host" && (
        <Form.Item
          name="self_host_ssh_target"
          label={<SshTargetLabel label="SSH target" />}
          rules={
            requireSshTarget
              ? [
                  {
                    required: true,
                    message: "Please enter an SSH target for this host.",
                  },
                ]
              : undefined
          }
        >
          <Input placeholder="user@host[:port] or ssh-config name" />
        </Form.Item>
      )}
      {showSelfHostSshWarning && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="No SSH target provided"
          description="Without an SSH target, the host must be able to reach the hub’s SSH port directly."
        />
      )}
      {selectedProvider === "self-host" && watchedSelfHostKind !== "direct" && (
        <>
          <Form.Item
            name="cpu"
            label="vCPU"
            tooltip="Number of virtual CPUs for this VM."
            initialValue={draftManaged ? undefined : 2}
          >
            <InputNumber min={1} max={128} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="ram_gb"
            label="Memory (GB)"
            tooltip="RAM to allocate to this VM."
            initialValue={draftManaged ? undefined : 8}
          >
            <InputNumber min={1} max={512} style={{ width: "100%" }} />
          </Form.Item>
        </>
      )}
      {catalogError && selectedProvider !== "none" && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Cloud catalog unavailable"
          description={catalogError}
        />
      )}
    </>
  );
};
