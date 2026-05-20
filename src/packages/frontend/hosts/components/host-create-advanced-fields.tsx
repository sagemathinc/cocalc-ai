import { Col, Form, Row, Select } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { HostCatalog } from "@cocalc/conat/hub/api/hosts";
import type { DedicatedHostSurchargeSettings } from "@cocalc/util/project-host-pricing";
import type { HostCreateViewModel } from "../hooks/use-host-create-view-model";
import { getDiskTypeOptions } from "../constants";
import {
  getProviderPriceEstimate,
  type HostFieldOption,
  type HostFieldId,
  type ProviderSelection,
} from "../providers/registry";
import type { HostProvider } from "../types";
import { HostOptionsSelect } from "./host-options-select";
import { DiskTypeLabel } from "./disk-type-help";
import { HostSpotRecoveryFields } from "./host-spot-recovery-fields";

type HostCreateAdvancedFieldsProps = {
  provider: HostCreateViewModel["provider"];
  showSpotFields: boolean;
  nebiusSpotSupported: boolean;
  pricingSettings?: DedicatedHostSurchargeSettings;
  draftManaged?: boolean;
  onDraftPatch?: (patch: Record<string, any>) => void;
};

export function addMonthlyDiskPriceLabels(opts: {
  options: HostFieldOption[];
  provider: HostProvider;
  catalog?: HostCatalog;
  selection: ProviderSelection;
  pricingSettings?: DedicatedHostSurchargeSettings;
}): HostFieldOption[] {
  if (opts.provider !== "gcp" && opts.provider !== "nebius") {
    return opts.options;
  }
  return opts.options.map((option) => {
    const diskLine = getProviderPriceEstimate(
      opts.provider,
      opts.catalog,
      {
        ...opts.selection,
        storage_mode: opts.selection.storage_mode ?? "persistent",
        disk_type: option.value,
        disk_gb: 1,
      },
      opts.pricingSettings,
    )?.line_items.find((item) => item.key === "disk");
    if (!diskLine) return option;
    const monthlyPerGb = diskLine.monthly_label.replace(/\/mo$/, "/GB/mo");
    return {
      ...option,
      label: `${option.label} · ${monthlyPerGb}`,
    };
  });
}

export const HostCreateAdvancedFields: React.FC<
  HostCreateAdvancedFieldsProps
> = ({
  provider,
  showSpotFields,
  nebiusSpotSupported,
  pricingSettings,
  draftManaged = false,
  onDraftPatch,
}) => {
  const { selectedProvider, catalog, fields, storage } = provider;
  const form = Form.useFormInstance();
  const diskTypeOptions = getDiskTypeOptions(selectedProvider);
  const defaultDiskType =
    selectedProvider === "nebius" ? "ssd_io_m3" : diskTypeOptions[0]?.value;
  const hideSelfHostAdvanced = selectedProvider === "self-host";
  const { schema, options, labels, tooltips } = fields;
  const {
    storageModeOptions,
    supportsPersistentStorage,
    persistentGrowable,
    showDiskFields,
  } = storage;
  const watchedRegion = Form.useWatch("region", form);
  const watchedZone = Form.useWatch("zone", form);
  const watchedMachineType = Form.useWatch("machine_type", form);
  const watchedPricingModel = Form.useWatch("pricing_model", form);
  const watchedFundingMode = Form.useWatch("funding_mode", form);
  const watchedStorageMode = Form.useWatch("storage_mode", form);
  const watchedDiskType = Form.useWatch("disk_type", form);

  const pricedDiskTypeOptions = React.useMemo(() => {
    return addMonthlyDiskPriceLabels({
      options: diskTypeOptions,
      provider: selectedProvider,
      catalog,
      pricingSettings,
      selection: {
        region: watchedRegion,
        zone: watchedZone,
        machine_type: watchedMachineType,
        funding_mode: watchedFundingMode,
        pricing_model: watchedPricingModel,
        storage_mode: watchedStorageMode ?? "persistent",
      },
    });
  }, [
    catalog,
    diskTypeOptions,
    pricingSettings,
    selectedProvider,
    watchedFundingMode,
    watchedMachineType,
    watchedPricingModel,
    watchedRegion,
    watchedStorageMode,
    watchedZone,
  ]);

  React.useEffect(() => {
    if (draftManaged) return;
    if (!diskTypeOptions.length) return;
    const hasDiskType =
      watchedDiskType &&
      diskTypeOptions.some((opt) => opt.value === watchedDiskType);
    if (!hasDiskType) {
      form.setFieldsValue({ disk_type: defaultDiskType });
    }
  }, [defaultDiskType, diskTypeOptions, draftManaged, form, watchedDiskType]);

  const renderField = (field: HostFieldId) => {
    const fieldOptions = options[field] ?? [];
    const label =
      labels[field] ??
      field
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    const tooltip = tooltips[field];
    return (
      <Col span={24} key={field}>
        <Form.Item
          name={field}
          label={label}
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
  };

  if (hideSelfHostAdvanced) {
    return null;
  }

  return (
    <Row gutter={[12, 12]}>
      {showSpotFields && (
        <>
          <Col span={24}>
            <Form.Item
              name="pricing_model"
              label="Pricing model"
              initialValue={draftManaged ? undefined : "on_demand"}
              extra={
                selectedProvider === "nebius" && !nebiusSpotSupported
                  ? "Spot is unavailable for the selected Nebius instance type."
                  : undefined
              }
            >
              <Select
                options={[
                  { value: "on_demand", label: "On-demand" },
                  {
                    value: "spot",
                    label: "Spot / interruptible",
                    disabled:
                      selectedProvider === "nebius" && !nebiusSpotSupported,
                  },
                ]}
              />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              name="interruption_restore_policy"
              label="Interruption restore"
              initialValue={draftManaged ? undefined : "immediate"}
              tooltip="For spot hosts, immediately restoring the host is strongly preferred because users otherwise lose access until a backup restore or manual recovery."
            >
              <Select
                options={[
                  { value: "immediate", label: "Restore immediately" },
                  { value: "none", label: "Do not auto-restore" },
                ]}
              />
            </Form.Item>
          </Col>
          <HostSpotRecoveryFields
            visible={showSpotFields}
            draftManaged={draftManaged}
            onDraftPatch={onDraftPatch}
          />
        </>
      )}
      {schema.advanced.map(renderField)}
      {selectedProvider !== "none" && (
        <Col span={24}>
          <Form.Item
            name="storage_mode"
            label="Storage mode"
            initialValue={draftManaged ? undefined : "persistent"}
            tooltip={
              selectedProvider === "gcp"
                ? "Persistent disk only for GCP hosts in this release. Local SSD and newer Hyperdisk-style storage are not offered yet."
                : supportsPersistentStorage
                  ? persistentGrowable
                    ? "Ephemeral uses fast local disks; persistent uses a separate growable disk."
                    : "Ephemeral uses fast local disks; persistent uses a separate fixed-size disk."
                  : "Only ephemeral storage is available for this provider."
            }
          >
            <Select
              options={storageModeOptions}
              disabled={
                !supportsPersistentStorage || storageModeOptions.length === 1
              }
            />
          </Form.Item>
        </Col>
      )}
      {showDiskFields && (
        <>
          <Col span={24}>
            <Form.Item
              name="disk_type"
              label={<DiskTypeLabel provider={selectedProvider} />}
              initialValue={draftManaged ? undefined : defaultDiskType}
            >
              <Select
                options={pricedDiskTypeOptions}
                disabled={!pricedDiskTypeOptions.length}
              />
            </Form.Item>
          </Col>
        </>
      )}
    </Row>
  );
};
