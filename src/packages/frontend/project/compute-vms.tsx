/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Divider,
  Dropdown,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Popover,
  Popconfirm,
  Radio,
  Switch,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";

import type {
  ComputeAgentGrant,
  ComputeCatalog,
  ComputeVolume,
  ComputeVm,
} from "@cocalc/conat/hub/api/compute";
import { useRedux, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { CopyToClipBoard, Icon, TimeAgo } from "@cocalc/frontend/components";
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { mapCountryRegionToR2Region } from "@cocalc/util/consts";
import {
  COCALC_CLI_DOWNLOAD_URL,
  COCALC_CLI_INSTALL_COMMAND,
} from "@cocalc/util/consts/ui";
import { uuid } from "@cocalc/util/misc";
import {
  gcpMachineArchitecture,
  gcpMachineGpu,
  gcpMinimumBootDiskGb,
} from "@cocalc/util/project-host-pricing";
import {
  HostOptionsSelect,
  sortMachineTypeOptions,
} from "../hosts/components/host-options-select";
import { HostPriceBreakdown } from "../hosts/components/host-price-breakdown";
import { useHostPricingSettings } from "../hosts/hooks/use-host-pricing-settings";
import {
  getGcpMachineTypeOptions,
  getGcpPersistentDiskPriceEstimate,
  getGcpRegionOptions,
  getGcpZoneOptions,
  getProviderDescriptor,
  getProviderOptions,
  getProviderPriceEstimate,
  getNebiusPersistentDiskPriceEstimate,
  type HostFieldOption,
  type ProviderPriceEstimate,
  type ProviderSelection,
} from "../hosts/providers/registry";
import {
  markRecommendedRegionOption,
  sortRegionOptionsByPreference,
} from "../hosts/utils/region-ranking";
import {
  vmCreateCli,
  volumeCreateCli,
  type VmCreateCliValues,
  type VolumeCreateCliValues,
} from "./compute-vms-cli";
import { readProjectDeployPublicKey } from "./settings/project-to-project-ssh-service";

const { Paragraph, Text, Title } = Typography;
const COPYABLE_PROPS = {
  inputWidth: "100%",
  inputStyle: { minWidth: 0 },
  outerStyle: { width: "100%" },
  style: { marginTop: 6, width: "100%" },
} as const;
const NEBIUS_VOLUME_INCREMENT_GB = 93;
const VM_REFRESH_BASE_MS = 12_000;
const VM_REFRESH_JITTER_MS = 6_000;

function hasProjectVmAvailabilityScope(grant: ComputeAgentGrant): boolean {
  return (
    grant.metadata?.approved_scope?.kind === "project-vm-availability" &&
    grant.metadata?.approved_scope?.existing_resources_only === true
  );
}

function documentIsVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

function normalizedVolumeSizeGb(
  provider: "gcp" | "nebius",
  requestedSizeGb?: number,
): number {
  const sizeGb = Number(requestedSizeGb);
  if (provider !== "nebius") {
    return Number.isFinite(sizeGb) && sizeGb > 0 ? sizeGb : 50;
  }
  if (!Number.isFinite(sizeGb) || sizeGb <= 0) {
    return NEBIUS_VOLUME_INCREMENT_GB;
  }
  return (
    Math.max(1, Math.ceil(sizeGb / NEBIUS_VOLUME_INCREMENT_GB)) *
    NEBIUS_VOLUME_INCREMENT_GB
  );
}

function volumeSizeRules(provider: "gcp" | "nebius") {
  return [
    { required: true },
    {
      validator: async (_: unknown, value: unknown) => {
        if (value == null || value === "") return;
        const sizeGb = Number(value);
        if (!Number.isInteger(sizeGb)) {
          throw new Error("Size must be a whole number of GB.");
        }
        if (
          provider === "nebius" &&
          sizeGb % NEBIUS_VOLUME_INCREMENT_GB !== 0
        ) {
          throw new Error(
            `Nebius volumes must be a multiple of ${NEBIUS_VOLUME_INCREMENT_GB} GB.`,
          );
        }
      },
    },
  ];
}

function effectiveVolumeSizeGb(
  provider: "gcp" | "nebius",
  requestedSizeGb?: number,
): number | undefined {
  const sizeGb = Number(requestedSizeGb);
  if (!Number.isFinite(sizeGb) || sizeGb <= 0) return undefined;
  if (provider === "nebius" && sizeGb % NEBIUS_VOLUME_INCREMENT_GB !== 0) {
    return undefined;
  }
  return sizeGb;
}

interface VmDraft extends VmCreateCliValues {
  use_project_ssh_key: boolean;
}

type VolumeDraft = VolumeCreateCliValues;

interface TtlDraft {
  action: "set" | "extend" | "clear";
  minutes: number;
}

interface VolumeResizeDraft {
  size_gb: number;
}

function shortProjectId(projectId: string): string {
  return projectId.slice(0, 8);
}

function hourlyPrice(vm: ComputeVm): string {
  const price =
    vm.effective_pricing_model === "spot"
      ? vm.spot_hourly_price
      : vm.on_demand_hourly_price;
  return `$${Number(price).toFixed(3)}/h`;
}

function pricingLabel(value: string): string {
  return value === "spot" ? "Spot" : "Standard";
}

function egressRateLabel(vm: ComputeVm): string {
  if (vm.provider === "nebius") return "Egress $0/GB";
  return `Egress $0.10/GB${vm.funding_mode === "site-funded" ? " · paid by site" : ""}`;
}

const VM_MONTHLY_HOURS = 730;

function formatVmPrice(value: number, suffix: "hr" | "mo"): string {
  return `$${value.toFixed(2)}/${suffix}`;
}

function storedPriceEstimate(
  rate: any,
  notes: string[],
): ProviderPriceEstimate | undefined {
  const snapshot = rate?.pricing_snapshot;
  if (!Array.isArray(snapshot?.components)) return undefined;
  const line_items = snapshot.components
    .map((component: any) => {
      const usdPerHour = Number(component.hourly_cost_usd);
      if (!Number.isFinite(usdPerHour)) return undefined;
      return {
        key: component.key,
        label: component.label,
        billing_states: component.billing_states ?? ["running"],
        usd_per_hour: usdPerHour,
        usd_per_month: usdPerHour * VM_MONTHLY_HOURS,
        hourly_label: formatVmPrice(usdPerHour, "hr"),
        monthly_label: formatVmPrice(usdPerHour * VM_MONTHLY_HOURS, "mo"),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item != null);
  const usd_per_hour = Number(snapshot.hourly_cost_usd ?? rate.hourly_cost_usd);
  if (!Number.isFinite(usd_per_hour)) return undefined;
  return {
    usd_per_hour,
    usd_per_month: usd_per_hour * VM_MONTHLY_HOURS,
    hourly_label: formatVmPrice(usd_per_hour, "hr"),
    monthly_label: formatVmPrice(usd_per_hour * VM_MONTHLY_HOURS, "mo"),
    line_items,
    notes,
  };
}

function vmStoredPriceEstimate(
  vm: ComputeVm,
): ProviderPriceEstimate | undefined {
  return storedPriceEstimate(
    vm.metadata?.billing?.running_rates?.[vm.effective_pricing_model],
    [
      ...(vm.operating_system === "windows"
        ? [
            "The Windows Server license is charged only while this VM is running. It does not accrue while the VM is stopped.",
          ]
        : []),
      "The persistent boot disk continues to cost money while the VM is stopped.",
    ],
  );
}

function vmStoredStoppedPriceEstimate(
  vm: ComputeVm,
): ProviderPriceEstimate | undefined {
  return storedPriceEstimate(vm.metadata?.billing?.stopped_rate, [
    "Stopped VMs retain their persistent boot disk. Compute and Windows Server licensing do not accrue while stopped.",
  ]);
}

function providerErrorSummary(error: string): string {
  if (/ZONE_RESOURCE_POOL_EXHAUSTED|not enough resources/i.test(error)) {
    return "Capacity unavailable in this zone";
  }
  if (/QUOTA/i.test(error)) return "Provider quota exhausted";
  return "Provider operation failed";
}

function regionFromZone(zone?: string): string {
  return `${zone ?? ""}`.replace(/-[a-z]$/, "");
}

function providerCatalog(catalog: ComputeCatalog, provider: "gcp" | "nebius") {
  return catalog.provider_catalogs[provider];
}

function compatibleOptions(options: HostFieldOption[]): HostFieldOption[] {
  return options.filter((option) => {
    const meta = (option.meta ?? {}) as { compatible?: boolean };
    return (
      !option.disabled &&
      option.stateLabel !== "price unavailable" &&
      meta.compatible !== false
    );
  });
}

function selectablePlacementOptions(
  options: HostFieldOption[],
): HostFieldOption[] {
  return options.filter((option) => {
    const meta = (option.meta ?? {}) as { compatible?: boolean };
    return !option.disabled && meta.compatible !== false;
  });
}

function formatMaximumSpend(usd: number): string {
  return usd.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function sshKeyOptions(sshKeys: any) {
  const raw = sshKeys?.toJS?.() ?? sshKeys ?? {};
  return Object.entries(raw)
    .map(([fingerprint, value]: [string, any]) => ({
      label: value?.title || fingerprint,
      value: `${value?.value ?? ""}`.trim(),
    }))
    .filter(({ value }) => value);
}

function similarName(name: string, rows: ComputeVm[]): string {
  const names = new Set(rows.map((vm) => vm.name));
  const stem = `${name.slice(0, 26)}-copy`;
  if (!names.has(stem)) return stem;
  for (let index = 2; index < 100; index++) {
    const candidate = `${name.slice(0, 28 - `${index}`.length)}-${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `vm-${Date.now()}`.slice(0, 32);
}

function availableName(stem: string, names: Iterable<string>): string {
  const used = new Set(names);
  const base = stem.replace(/-+$/, "").slice(0, 32) || "compute-vm";
  if (!used.has(base)) return base;
  for (let index = 1; index < 10_000; index++) {
    const suffix = "-" + index;
    const candidate = base.slice(0, 32 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
  return ("vm-" + Date.now()).slice(0, 32);
}

function originalTtlMinutes(vm: ComputeVm): number | null {
  if (!vm.expires_at) return null;
  return Math.max(
    5,
    Math.round(
      (new Date(vm.expires_at).valueOf() - new Date(vm.created_at).valueOf()) /
        60_000,
    ),
  );
}

function VmCreateModal({
  open,
  project_id,
  catalog,
  volumes,
  initial,
  projectSshPublicKey,
  sshKeys,
  saving,
  error,
  preferredR2Region,
  onGenerateProjectSshKey,
  onCancel,
  onCreate,
}: {
  open: boolean;
  project_id: string;
  catalog: ComputeCatalog;
  volumes: ComputeVolume[];
  initial: VmDraft;
  projectSshPublicKey: string | null;
  sshKeys: Array<{ label: string; value: string }>;
  saving: boolean;
  error?: string;
  preferredR2Region: ReturnType<typeof mapCountryRegionToR2Region>;
  onGenerateProjectSshKey: () => Promise<string | undefined>;
  onCancel: () => void;
  onCreate: (values: VmDraft) => Promise<void>;
}) {
  const [form] = Form.useForm<VmDraft>();
  const [draft, setDraft] = useState<Partial<VmDraft>>(initial);
  const [sortRegionsByPrice, setSortRegionsByPrice] = useState(false);
  const [sortMachinesByPrice, setSortMachinesByPrice] = useState(false);
  const [usePersistentHomeVolume, setUsePersistentHomeVolume] = useState(false);
  const [confirmedDraft, setConfirmedDraft] = useState<VmDraft>();
  const [sshKeyError, setSshKeyError] = useState<string>();
  const pricingSettings = useHostPricingSettings();

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue(initial);
    setDraft(initial);
    setSortRegionsByPrice(false);
    setSortMachinesByPrice(false);
    setUsePersistentHomeVolume(
      initial.create_home_volume === true || !!initial.home_volume,
    );
    setConfirmedDraft(undefined);
    setSshKeyError(undefined);
  }, [form, initial, open]);

  const api = globalThis.location?.origin ?? "https://cocalc.ai";
  const operatingSystem =
    draft.operating_system ?? initial.operating_system ?? "linux";
  const provider = draft.provider ?? initial.provider;
  const hostCatalog = providerCatalog(catalog, provider);
  const availableVolumes = volumes.filter(
    (volume) =>
      operatingSystem === "linux" &&
      volume.provider === provider &&
      volume.state === "ready" &&
      volume.attachment_state === "detached",
  );
  const selectedVolume = volumes.find(
    (volume) => volume.name === draft.home_volume,
  );
  const selection: ProviderSelection = {
    operating_system: operatingSystem,
    architecture: draft.architecture,
    region: draft.region || regionFromZone(draft.zone),
    zone: draft.zone,
    machine_type: draft.machine_type,
    gpu_type: draft.gpu_type,
    pricing_model: draft.pricing_model,
    storage_mode: "persistent",
    disk_type: provider === "nebius" ? "ssd" : "balanced",
    disk_gb: draft.boot_disk_gb,
    funding_mode: draft.funding_mode,
    price_display: "hourly",
    pricing_settings: pricingSettings,
  };
  const providerOptions = getProviderOptions(provider, hostCatalog, selection);
  const descriptor = getProviderDescriptor(provider);
  const regionOptions = markRecommendedRegionOption(
    sortRegionOptionsByPreference({
      options:
        provider === "gcp"
          ? compatibleOptions(getGcpRegionOptions(hostCatalog, selection))
          : selectablePlacementOptions(providerOptions.region ?? []),
      preference: sortRegionsByPrice ? "cheapest" : "closest",
      preferredRegion: preferredR2Region,
    }),
  );
  const zoneOptions = compatibleOptions(
    provider === "gcp"
      ? getGcpZoneOptions(hostCatalog, selection)
      : (providerOptions.zone ?? []),
  );
  const machineOptions =
    sortMachineTypeOptions(
      compatibleOptions(
        (provider === "gcp"
          ? getGcpMachineTypeOptions(hostCatalog, selection)
          : (providerOptions.machine_type ?? [])
        ).filter(
          ({ value }) =>
            provider !== "gcp" ||
            (gcpMachineArchitecture(value) === draft.architecture &&
              (operatingSystem !== "windows" || !gcpMachineGpu(value))),
        ),
      ),
      sortMachinesByPrice ? "price" : "type",
    ) ?? [];
  const gpuOptions = compatibleOptions(providerOptions.gpu_type ?? []);
  const price = getProviderPriceEstimate(
    provider,
    hostCatalog,
    selection,
    pricingSettings,
  );
  const standardFallbackPrice =
    draft.pricing_model === "spot" && draft.allow_on_demand_fallback
      ? getProviderPriceEstimate(
          provider,
          hostCatalog,
          { ...selection, pricing_model: "on_demand" },
          pricingSettings,
        )
      : undefined;
  const newVolumeEffectiveSizeGb = effectiveVolumeSizeGb(
    provider,
    draft.new_home_volume_size_gb,
  );
  const newVolumeEstimate =
    draft.create_home_volume && newVolumeEffectiveSizeGb
      ? provider === "gcp"
        ? getGcpPersistentDiskPriceEstimate(
            hostCatalog,
            {
              region: draft.region || regionFromZone(draft.zone),
              zone: draft.zone,
              storage_mode: "persistent",
              disk_type: "balanced",
              disk_gb: newVolumeEffectiveSizeGb,
              pricing_settings: pricingSettings,
            },
            pricingSettings,
          )
        : getNebiusPersistentDiskPriceEstimate(
            hostCatalog,
            {
              region: draft.region,
              storage_mode: "persistent",
              disk_type: "ssd",
              disk_gb: newVolumeEffectiveSizeGb,
              pricing_settings: pricingSettings,
            },
            pricingSettings,
          )
      : undefined;
  const newVolumePrice = newVolumeEstimate?.line_items.find(
    (item) => item.key === "disk",
  );
  const maximumSpend =
    draft.ttl_minutes && (standardFallbackPrice ?? price)
      ? ((standardFallbackPrice ?? price)!.usd_per_hour * draft.ttl_minutes) /
        60
      : undefined;
  const minimumBootDiskGb =
    operatingSystem === "windows"
      ? 50
      : provider === "gcp" && draft.machine_type
        ? gcpMinimumBootDiskGb(draft.machine_type)
        : 10;

  const patchDraft = (patch: Partial<VmDraft>) => {
    form.setFieldsValue(patch);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const chooseGcpMachine = (
    nextSelection: ProviderSelection,
    preferredMachine = draft.machine_type,
  ) => {
    const options = compatibleOptions(
      getGcpMachineTypeOptions(hostCatalog, nextSelection),
    ).filter(
      ({ value }) =>
        gcpMachineArchitecture(value) === nextSelection.architecture &&
        (operatingSystem !== "windows" || !gcpMachineGpu(value)),
    );
    return options.some(({ value }) => value === preferredMachine)
      ? preferredMachine
      : options[0]?.value;
  };

  const gcpMachinePatch = (machine_type?: string): Partial<VmDraft> => {
    const gpu = machine_type ? gcpMachineGpu(machine_type) : undefined;
    return {
      machine_type,
      gpu_count: gpu?.count ?? 0,
      boot_disk_gb: Math.max(
        Number(draft.boot_disk_gb ?? (operatingSystem === "windows" ? 80 : 20)),
        operatingSystem === "windows"
          ? 50
          : machine_type
            ? gcpMinimumBootDiskGb(machine_type)
            : 10,
      ),
    };
  };

  const withResolvedSshKey = (values: VmDraft): VmDraft => ({
    ...values,
    ssh_public_key: values.use_project_ssh_key
      ? (projectSshPublicKey ?? "")
      : values.ssh_public_key,
  });

  const reviewCreate = () =>
    void form
      .validateFields()
      .then((values) => setConfirmedDraft(withResolvedSshKey(values)));

  return (
    <Modal
      open={open}
      title={initial.name ? `Create ${initial.name}` : "Create virtual machine"}
      onCancel={onCancel}
      footer={
        <Flex vertical gap={12}>
          {error && (
            <Alert
              showIcon
              type="error"
              title="Unable to create VM"
              description={error}
              style={{ textAlign: "left" }}
            />
          )}
          <Flex justify="flex-end" gap={8}>
            <Button disabled={saving} onClick={onCancel}>
              Cancel
            </Button>
            <Popconfirm
              open={confirmedDraft != null}
              title={`Create ${confirmedDraft?.name ?? "this VM"}?`}
              description={
                confirmedDraft && (
                  <Space direction="vertical" size={2}>
                    <Text>
                      {confirmedDraft.operating_system === "windows"
                        ? "Windows Server 2022"
                        : "Ubuntu 24.04"}{" "}
                      · {confirmedDraft.machine_type} ·{" "}
                      {confirmedDraft.zone ?? confirmedDraft.region}
                    </Text>
                    <Text strong>
                      Boot disk: {confirmedDraft.boot_disk_gb} GB
                    </Text>
                    <Text>
                      Capacity: {pricingLabel(confirmedDraft.pricing_model)}
                      {price
                        ? ` · ${price.hourly_label} (${price.monthly_label})`
                        : " · price unavailable"}
                    </Text>
                    <Text>
                      Home:{" "}
                      {confirmedDraft.create_home_volume
                        ? `new ${confirmedDraft.new_home_volume_size_gb} GB persistent volume`
                        : confirmedDraft.home_volume
                          ? `persistent volume ${confirmedDraft.home_volume}`
                          : "boot disk"}
                    </Text>
                    <Text type="secondary">
                      The boot disk size cannot currently be changed after
                      creation.
                    </Text>
                  </Space>
                )
              }
              okText="Create VM"
              cancelText="Review"
              okButtonProps={{ loading: saving }}
              onConfirm={() => {
                if (!confirmedDraft) return;
                const values = confirmedDraft;
                setConfirmedDraft(undefined);
                void onCreate(values);
              }}
              onCancel={() => setConfirmedDraft(undefined)}
            >
              <Button
                type="primary"
                loading={saving}
                disabled={
                  saving || (draft.create_home_volume && !newVolumePrice)
                }
                onClick={reviewCreate}
              >
                Create VM
              </Button>
            </Popconfirm>
          </Flex>
        </Flex>
      }
      styles={{ body: { maxHeight: "calc(100vh - 190px)", overflowY: "auto" } }}
      width={920}
    >
      <Form<VmDraft>
        form={form}
        layout="vertical"
        initialValues={initial}
        onValuesChange={(changedValues) =>
          setDraft((current) => ({ ...current, ...changedValues }))
        }
      >
        <Flex gap={12} wrap>
          <Form.Item
            name="name"
            label="Name"
            rules={[
              { required: true },
              {
                pattern: /^[a-z][a-z0-9-]{0,31}$/,
                message:
                  "Use at most 32 lowercase letters, digits, or hyphens.",
              },
            ]}
            style={{ flex: "1 1 220px" }}
          >
            <Input autoFocus />
          </Form.Item>
          <Form.Item
            name="funding_mode"
            label="Funding"
            rules={[{ required: true }]}
            style={{ flex: "1 1 320px" }}
          >
            <Select
              options={catalog.funding_modes.map((mode) => ({
                value: mode.value,
                label: mode.label,
                disabled: !mode.allowed,
                title: mode.reason,
              }))}
            />
          </Form.Item>
        </Flex>
        <Flex gap={12} wrap>
          <Form.Item
            name="operating_system"
            label="Operating system"
            rules={[{ required: true }]}
            style={{ flex: "1 1 260px" }}
          >
            <Select
              options={catalog.operating_systems.map((entry) => ({
                value: entry.value,
                label: entry.label,
              }))}
              onChange={(nextOs: "linux" | "windows") => {
                if (nextOs === "windows") {
                  patchDraft({
                    operating_system: "windows",
                    provider: "gcp",
                    architecture: "x86_64",
                    region: catalog.defaults.region,
                    zone: catalog.defaults.zone,
                    machine_type: catalog.defaults.machine_type,
                    gpu_type: undefined,
                    gpu_count: 0,
                    home_volume: undefined,
                    create_home_volume: false,
                    boot_disk_gb: Math.max(Number(draft.boot_disk_gb ?? 0), 80),
                  });
                } else {
                  patchDraft({ operating_system: "linux" });
                }
                if (nextOs === "windows") {
                  setUsePersistentHomeVolume(false);
                }
              }}
            />
          </Form.Item>
          <Form.Item
            name="provider"
            label="Cloud provider"
            rules={[{ required: true }]}
            style={{ flex: "1 1 220px" }}
          >
            <Select
              disabled={operatingSystem === "windows"}
              options={catalog.providers
                .filter(
                  (value) => operatingSystem !== "windows" || value === "gcp",
                )
                .map((value) => ({
                  value,
                  label: getProviderDescriptor(value).label,
                }))}
              onChange={(nextProvider: "gcp" | "nebius") => {
                const nextCatalog = providerCatalog(catalog, nextProvider);
                const options = getProviderOptions(nextProvider, nextCatalog, {
                  pricing_model: draft.pricing_model,
                });
                const region =
                  nextProvider === "gcp"
                    ? catalog.defaults.region
                    : options.region?.[0]?.value;
                const zone =
                  nextProvider === "gcp"
                    ? catalog.defaults.zone
                    : options.zone?.[0]?.value;
                const machine_type =
                  nextProvider === "gcp"
                    ? catalog.defaults.machine_type
                    : options.machine_type?.[0]?.value;
                patchDraft({
                  provider: nextProvider,
                  architecture: "x86_64",
                  region,
                  zone,
                  machine_type,
                  gpu_type: undefined,
                  gpu_count: 0,
                  home_volume: undefined,
                  create_home_volume: false,
                  new_home_volume_size_gb: normalizedVolumeSizeGb(
                    nextProvider,
                    draft.new_home_volume_size_gb,
                  ),
                });
                setUsePersistentHomeVolume(false);
              }}
            />
          </Form.Item>
          <Form.Item
            name="architecture"
            label="Architecture"
            rules={[{ required: true }]}
            style={{ flex: "1 1 180px", order: -1 }}
          >
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              disabled={provider !== "gcp" || operatingSystem === "windows"}
              onChange={(event) => {
                const architecture = event.target.value as "x86_64" | "arm64";
                const architectureSelection: ProviderSelection = {
                  ...selection,
                  architecture,
                  machine_type: undefined,
                  gpu_type: undefined,
                  region: undefined,
                  zone: undefined,
                };
                const compatibleRegions = sortRegionOptionsByPreference({
                  options: compatibleOptions(
                    getGcpRegionOptions(hostCatalog, architectureSelection),
                  ),
                  preference: sortRegionsByPrice ? "cheapest" : "closest",
                  preferredRegion: preferredR2Region,
                });
                const region = compatibleRegions.some(
                  (option) => option.value === draft.region,
                )
                  ? draft.region
                  : compatibleRegions[0]?.value;
                const zoneSelection = {
                  ...architectureSelection,
                  region,
                };
                const compatibleZones = compatibleOptions(
                  getGcpZoneOptions(hostCatalog, zoneSelection),
                );
                const zone = compatibleZones.some(
                  (option) => option.value === draft.zone,
                )
                  ? draft.zone
                  : compatibleZones[0]?.value;
                const machine_type = compatibleOptions(
                  getGcpMachineTypeOptions(hostCatalog, {
                    ...zoneSelection,
                    zone,
                  }),
                ).find(
                  ({ value }) => gcpMachineArchitecture(value) === architecture,
                )?.value;
                const nextMachinePatch = gcpMachinePatch(machine_type);
                patchDraft({
                  architecture,
                  region,
                  zone,
                  gpu_type: undefined,
                  ...nextMachinePatch,
                });
              }}
            >
              <Radio.Button value="x86_64">x86-64</Radio.Button>
              <Radio.Button value="arm64">ARM64</Radio.Button>
            </Radio.Group>
          </Form.Item>
        </Flex>
        <Flex gap={12} wrap>
          <Form.Item
            name="region"
            label={
              <Flex align="center" justify="space-between" gap={12}>
                <span>Region</span>
                <Space size={6}>
                  <Text type="secondary" style={{ fontWeight: 400 }}>
                    Sort by price
                  </Text>
                  <Switch
                    size="small"
                    checked={sortRegionsByPrice}
                    onChange={setSortRegionsByPrice}
                  />
                </Space>
              </Flex>
            }
            rules={[{ required: true }]}
            style={{ flex: "1 1 280px" }}
          >
            <HostOptionsSelect
              options={regionOptions}
              disabled={selectedVolume != null || !regionOptions.length}
              placeholder={
                regionOptions.length
                  ? "Select a region"
                  : "No regions available"
              }
              onChange={(region) => {
                const nextSelection = {
                  ...selection,
                  region,
                  zone: undefined,
                };
                const nextZone = compatibleOptions(
                  provider === "gcp"
                    ? getGcpZoneOptions(hostCatalog, nextSelection)
                    : (getProviderOptions(provider, hostCatalog, nextSelection)
                        .zone ?? []),
                )[0]?.value;
                const machinePatch =
                  provider === "gcp"
                    ? gcpMachinePatch(
                        chooseGcpMachine({
                          ...nextSelection,
                          zone: nextZone,
                        }),
                      )
                    : {};
                patchDraft({ region, zone: nextZone, ...machinePatch });
              }}
            />
          </Form.Item>
          <Form.Item
            name="zone"
            label="Zone"
            rules={[{ required: provider === "gcp" }]}
            style={{ flex: "1 1 280px" }}
          >
            {!descriptor.supports.zone ? (
              <Input disabled placeholder="Provider-managed location" />
            ) : zoneOptions.length ? (
              <HostOptionsSelect
                options={zoneOptions}
                disabled={selectedVolume != null}
                onChange={(zone) => {
                  const machinePatch =
                    provider === "gcp"
                      ? gcpMachinePatch(
                          chooseGcpMachine({ ...selection, zone }),
                        )
                      : {};
                  patchDraft({ zone, ...machinePatch });
                }}
              />
            ) : (
              <Input disabled={selectedVolume != null} />
            )}
          </Form.Item>
        </Flex>
        {descriptor.supports.gpuType &&
          operatingSystem === "linux" &&
          !(provider === "gcp" && draft.architecture === "arm64") &&
          gpuOptions.length > 0 && (
            <Flex gap={12} wrap>
              <Form.Item
                name="gpu_type"
                label="GPU"
                style={{ flex: "1 1 280px" }}
              >
                <HostOptionsSelect
                  options={gpuOptions}
                  placeholder="No GPU"
                  onChange={(value) => {
                    const gpu_type = value === "none" ? undefined : value;
                    if (provider !== "gcp") {
                      patchDraft({ gpu_type });
                      return;
                    }
                    const baseSelection: ProviderSelection = {
                      ...selection,
                      architecture: "x86_64",
                      gpu_type,
                      machine_type: undefined,
                      region: undefined,
                      zone: undefined,
                    };
                    const regions = sortRegionOptionsByPreference({
                      options: compatibleOptions(
                        getGcpRegionOptions(hostCatalog, baseSelection),
                      ),
                      preference: sortRegionsByPrice ? "cheapest" : "closest",
                      preferredRegion: preferredR2Region,
                    });
                    const region = regions.some(
                      ({ value }) => value === draft.region,
                    )
                      ? draft.region
                      : regions[0]?.value;
                    const regionSelection = { ...baseSelection, region };
                    const zones = compatibleOptions(
                      getGcpZoneOptions(hostCatalog, regionSelection),
                    );
                    const zone = zones.some(({ value }) => value === draft.zone)
                      ? draft.zone
                      : zones[0]?.value;
                    const machine_type = chooseGcpMachine(
                      { ...regionSelection, zone },
                      undefined,
                    );
                    patchDraft({
                      architecture: "x86_64",
                      gpu_type,
                      region,
                      zone,
                      ...gcpMachinePatch(machine_type),
                    });
                  }}
                />
              </Form.Item>
              <Form.Item
                name="gpu_count"
                label="GPU count"
                style={{ flex: "1 1 160px" }}
              >
                <InputNumber disabled min={0} max={8} />
              </Form.Item>
            </Flex>
          )}
        <Flex gap={12} wrap>
          <Form.Item
            name="machine_type"
            label={
              <Flex align="center" justify="space-between" gap={12}>
                <span>Machine</span>
                <Space size={6}>
                  <Text type="secondary" style={{ fontWeight: 400 }}>
                    Sort by price
                  </Text>
                  <Switch
                    size="small"
                    checked={sortMachinesByPrice}
                    onChange={setSortMachinesByPrice}
                  />
                </Space>
              </Flex>
            }
            rules={[{ required: true }]}
            style={{ flex: "1 1 260px" }}
          >
            <HostOptionsSelect
              options={machineOptions}
              disabled={machineOptions.length === 0}
              placeholder="Select a machine available in this zone"
              onChange={(machine_type) => {
                patchDraft(
                  provider === "gcp"
                    ? gcpMachinePatch(machine_type)
                    : { machine_type },
                );
              }}
            />
          </Form.Item>
          <Form.Item
            name="boot_disk_gb"
            label="Boot disk (GB)"
            rules={[
              { required: true },
              {
                validator: async (_rule, value) => {
                  const size = Number(value);
                  if (
                    !Number.isInteger(size) ||
                    size < minimumBootDiskGb ||
                    size > catalog.limits.max_boot_disk_gb
                  ) {
                    throw new Error(
                      `Enter a whole number from ${minimumBootDiskGb} to ${catalog.limits.max_boot_disk_gb} GB.`,
                    );
                  }
                },
              },
            ]}
            style={{ flex: "0 1 150px" }}
          >
            <InputNumber
              placeholder={`${minimumBootDiskGb}-${catalog.limits.max_boot_disk_gb}`}
            />
          </Form.Item>
          <Text strong style={{ flex: "1 1 300px", marginTop: 31 }}>
            Boot disks cannot currently be enlarged after VM creation.
          </Text>
        </Flex>
        {operatingSystem === "linux" && (
          <>
            <Form.Item name="create_home_volume" hidden valuePropName="checked">
              <Checkbox />
            </Form.Item>
            <Form.Item name="home_volume" hidden>
              <Input />
            </Form.Item>
            <Form.Item
              style={{ marginBottom: usePersistentHomeVolume ? 8 : 16 }}
            >
              <Checkbox
                checked={usePersistentHomeVolume}
                onChange={(event) => {
                  if (event.target.checked) {
                    setUsePersistentHomeVolume(true);
                    patchDraft({
                      home_volume: undefined,
                      create_home_volume: true,
                      new_home_volume_size_gb: normalizedVolumeSizeGb(
                        provider,
                        draft.new_home_volume_size_gb,
                      ),
                    });
                  } else {
                    setUsePersistentHomeVolume(false);
                    patchDraft({
                      home_volume: undefined,
                      create_home_volume: false,
                    });
                  }
                }}
              >
                Persistent home volume mounted at <Text code>/home/user</Text>
              </Checkbox>
            </Form.Item>
            {usePersistentHomeVolume && (
              <Form.Item
                label="Home volume"
                style={{ marginBottom: draft.create_home_volume ? 12 : 16 }}
              >
                <Select
                  value={
                    draft.create_home_volume ? "__new__" : draft.home_volume
                  }
                  options={[
                    {
                      value: "__new__",
                      label: "Create a new persistent home volume",
                    },
                    ...availableVolumes.map((volume) => ({
                      value: volume.name,
                      label: `${volume.name} · ${volume.effective_size_gb} GB · ${volume.region}${volume.zone ? `/${volume.zone}` : ""}${
                        volume.region === draft.region &&
                        (!volume.zone || volume.zone === draft.zone)
                          ? ""
                          : " · unavailable in this location"
                      }`,
                      disabled:
                        volume.region !== draft.region ||
                        (!!volume.zone && volume.zone !== draft.zone),
                    })),
                  ]}
                  onChange={(value) => {
                    if (value === "__new__") {
                      patchDraft({
                        home_volume: undefined,
                        create_home_volume: true,
                        new_home_volume_size_gb: normalizedVolumeSizeGb(
                          provider,
                          draft.new_home_volume_size_gb,
                        ),
                      });
                    } else {
                      patchDraft({
                        home_volume: value,
                        create_home_volume: false,
                      });
                    }
                  }}
                />
              </Form.Item>
            )}
            {usePersistentHomeVolume && draft.create_home_volume && (
              <>
                <Flex gap={12} wrap>
                  <Form.Item
                    name="new_home_volume_name"
                    label="New home volume name"
                    rules={[
                      { required: true },
                      {
                        pattern: /^[a-z][a-z0-9-]{0,31}$/,
                        message:
                          "Use at most 32 lowercase letters, digits, or hyphens.",
                      },
                    ]}
                    style={{ flex: "1 1 260px" }}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    name="new_home_volume_size_gb"
                    label="Size (GB)"
                    rules={volumeSizeRules(provider)}
                    style={{ flex: "1 1 160px" }}
                  >
                    <InputNumber
                      min={
                        provider === "nebius" ? NEBIUS_VOLUME_INCREMENT_GB : 10
                      }
                      max={catalog.limits.max_volume_gb}
                      step={
                        provider === "nebius" ? NEBIUS_VOLUME_INCREMENT_GB : 1
                      }
                      precision={0}
                      style={{ width: "100%" }}
                    />
                  </Form.Item>
                </Flex>
                <Alert
                  showIcon
                  type="info"
                  title={
                    newVolumePrice
                      ? `New home volume: ${newVolumePrice.monthly_label}`
                      : "New home volume pricing is unavailable"
                  }
                  description={
                    <Space direction="vertical" size={2}>
                      <span>
                        The volume will be created in{" "}
                        {draft.zone ?? draft.region}, attached to this VM, and
                        retained if the VM is deleted.
                      </span>
                      {provider === "nebius" && (
                        <Text strong>
                          Nebius persistent volumes are available in 93 GB
                          increments.
                        </Text>
                      )}
                    </Space>
                  }
                  style={{ marginBottom: 16 }}
                />
              </>
            )}
          </>
        )}
        <Popover
          trigger="click"
          placement="topLeft"
          title="Estimated price"
          content={
            <Space
              direction="vertical"
              size={10}
              style={{ width: 480, maxWidth: "80vw" }}
            >
              {price && (
                <HostPriceBreakdown
                  estimate={price}
                  title="Itemized running cost"
                  compact
                />
              )}
              {operatingSystem === "windows" && (
                <Text strong>
                  The Windows Server license is charged only while this VM is
                  running. It does not accrue while the VM is stopped.
                </Text>
              )}
              {standardFallbackPrice && (
                <Text>
                  Standard fallback: {standardFallbackPrice.hourly_label} (
                  {standardFallbackPrice.monthly_label}).
                </Text>
              )}
              <Text type="secondary">
                The persistent boot disk continues to cost money while the VM is
                stopped. Public Internet egress{" "}
                {provider === "nebius"
                  ? "costs $0/GB on Nebius."
                  : draft.funding_mode === "site-funded"
                    ? "costs $0.10/GB on GCP and is paid by the site."
                    : "costs $0.10/GB on GCP and is billed separately."}
              </Text>
              {maximumSpend != null && (
                <Text strong>
                  Maximum compute and storage spend through the deletion
                  deadline: {formatMaximumSpend(maximumSpend)}
                  {provider === "nebius" || draft.funding_mode === "site-funded"
                    ? "."
                    : " + $0.10/GB public egress."}
                </Text>
              )}
            </Space>
          }
        >
          <Button style={{ marginBottom: 8 }}>
            {price
              ? `Estimated price: ${price.hourly_label} (${price.monthly_label})`
              : "Price estimate unavailable for this selection"}
          </Button>
        </Popover>
        <Collapse
          ghost
          items={[
            {
              key: "advanced",
              label: "Advanced options",
              forceRender: true,
              children: (
                <>
                  <Title level={5}>Capacity and lifetime</Title>
                  <Flex gap={12} wrap>
                    <Form.Item
                      name="pricing_model"
                      label="Capacity"
                      style={{ flex: "1 1 320px" }}
                    >
                      <Radio.Group
                        optionType="button"
                        buttonStyle="solid"
                        onChange={(event) => {
                          const pricing_model = event.target.value;
                          patchDraft({
                            pricing_model,
                            allow_on_demand_fallback: pricing_model === "spot",
                          });
                        }}
                      >
                        <Radio.Button value="spot">
                          Spot · lower cost
                        </Radio.Button>
                        <Radio.Button value="on_demand">Standard</Radio.Button>
                      </Radio.Group>
                    </Form.Item>
                    <Form.Item
                      name="ttl_minutes"
                      label="Optional deletion deadline"
                      extra="Leave blank to run until you stop it or membership funding is unavailable."
                      style={{ flex: "1 1 260px" }}
                    >
                      <Select
                        allowClear
                        placeholder="No deadline"
                        options={[
                          { value: 30, label: "30 minutes" },
                          { value: 60, label: "1 hour" },
                          { value: 240, label: "4 hours" },
                          { value: 480, label: "8 hours" },
                          { value: 1440, label: "1 day" },
                        ].filter(
                          ({ value }) =>
                            value <= catalog.limits.max_ttl_minutes,
                        )}
                      />
                    </Form.Item>
                  </Flex>
                  {draft.pricing_model === "spot" && (
                    <Form.Item
                      name="allow_on_demand_fallback"
                      valuePropName="checked"
                    >
                      <Checkbox>
                        Automatically restart interrupted Spot VMs. If Spot
                        remains unavailable, use Standard capacity for up to 24
                        hours and keep retrying Spot.
                      </Checkbox>
                    </Form.Item>
                  )}
                  <Divider />
                  <Title level={5}>SSH access</Title>
                  <Form.Item
                    name="configure_project_ssh"
                    valuePropName="checked"
                  >
                    <Checkbox disabled={!draft.use_project_ssh_key}>
                      Add a managed SSH alias to this project&apos;s{" "}
                      <Text code>~/.ssh/config</Text> when the VM is ready
                    </Checkbox>
                  </Form.Item>
                  {projectSshPublicKey ? (
                    <Form.Item
                      name="use_project_ssh_key"
                      valuePropName="checked"
                    >
                      <Checkbox>
                        Add this project&apos;s SSH key from{" "}
                        <Text code>.ssh/id_ed25519.pub</Text>
                      </Checkbox>
                    </Form.Item>
                  ) : (
                    <Alert
                      showIcon
                      type="info"
                      title="This project does not have an SSH keypair yet."
                      description="Create an encrypted project SSH keypair, then use its public key for this VM. The project does not need to restart."
                      action={
                        <Button
                          size="small"
                          loading={saving}
                          onClick={() => {
                            setSshKeyError(undefined);
                            void onGenerateProjectSshKey()
                              .then((publicKey) => {
                                if (publicKey) {
                                  patchDraft({ use_project_ssh_key: true });
                                }
                              })
                              .catch((err) => setSshKeyError(String(err)));
                          }}
                        >
                          Create project SSH keypair
                        </Button>
                      }
                      style={{ marginBottom: 16 }}
                    />
                  )}
                  {sshKeyError && (
                    <Alert
                      showIcon
                      type="warning"
                      title="Unable to create project SSH keypair"
                      description={sshKeyError}
                      style={{ marginBottom: 16 }}
                    />
                  )}
                  <Form.Item
                    name="ssh_public_key"
                    label={
                      projectSshPublicKey
                        ? "Other SSH public key (optional)"
                        : "SSH public key (optional)"
                    }
                    extra={
                      draft.use_project_ssh_key
                        ? "Uncheck the project key above to select a different initial key."
                        : sshKeys.length
                          ? "Select an account key, or leave blank. The CoCalc CLI can authorize your local key later when you run cocalc vm ssh."
                          : "Leave blank to authorize your local key later with cocalc vm ssh, or paste a public key now."
                    }
                  >
                    {sshKeys.length ? (
                      <Select
                        allowClear
                        disabled={draft.use_project_ssh_key}
                        options={sshKeys}
                        placeholder="No initial key"
                      />
                    ) : (
                      <Input.TextArea
                        autoSize={{ minRows: 2, maxRows: 4 }}
                        disabled={draft.use_project_ssh_key}
                      />
                    )}
                  </Form.Item>
                  <Divider />
                  <Text strong>Equivalent CLI command</Text>
                  <Paragraph type="secondary" style={{ margin: "4px 0 0" }}>
                    The command reproduces the form exactly, including an
                    initial SSH key or an explicitly keyless VM.
                  </Paragraph>
                  <CopyToClipBoard
                    value={vmCreateCli({
                      api,
                      project_id,
                      values: withResolvedSshKey(draft as VmDraft),
                    })}
                    {...COPYABLE_PROPS}
                  />
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  );
}

function VolumeCreateModal({
  open,
  project_id,
  catalog,
  saving,
  onCancel,
  onCreate,
}: {
  open: boolean;
  project_id: string;
  catalog: ComputeCatalog;
  saving: boolean;
  onCancel: () => void;
  onCreate: (values: VolumeDraft) => Promise<void>;
}) {
  const [form] = Form.useForm<VolumeDraft>();
  const initialProvider = catalog.defaults.provider;
  const initial = {
    name: "home-data",
    provider: initialProvider,
    funding_mode: catalog.default_funding_mode,
    region: catalog.defaults.region,
    zone: catalog.defaults.zone,
    size_gb: normalizedVolumeSizeGb(initialProvider, 50),
  };
  const [draft, setDraft] = useState<Partial<VolumeDraft>>(initial);
  const pricingSettings = useHostPricingSettings();
  const api = globalThis.location?.origin ?? "https://cocalc.ai";
  const provider = draft.provider ?? initial.provider;
  const hostCatalog = providerCatalog(catalog, provider);
  const region = draft.region ?? regionFromZone(draft.zone ?? initial.zone);
  const placementSelection: ProviderSelection = {
    region,
    zone: draft.zone,
  };
  const pricingSelection = {
    ...placementSelection,
    storage_mode: "persistent",
    disk_type: provider === "nebius" ? "ssd" : "balanced",
    disk_gb: effectiveVolumeSizeGb(provider, draft.size_gb),
    pricing_settings: pricingSettings,
  } as const;
  const providerOptions = getProviderOptions(
    provider,
    hostCatalog,
    placementSelection,
  );
  const regionOptions =
    provider === "gcp"
      ? compatibleOptions(getGcpRegionOptions(hostCatalog, placementSelection))
      : selectablePlacementOptions(providerOptions.region ?? []);
  const zoneOptions = compatibleOptions(
    provider === "gcp"
      ? getGcpZoneOptions(hostCatalog, placementSelection)
      : (providerOptions.zone ?? []),
  );
  const volumeEstimate =
    provider === "gcp"
      ? getGcpPersistentDiskPriceEstimate(
          hostCatalog,
          pricingSelection,
          pricingSettings,
        )
      : getNebiusPersistentDiskPriceEstimate(
          hostCatalog,
          pricingSelection,
          pricingSettings,
        );
  const diskEstimate = volumeEstimate?.line_items.find(
    (item) => item.key === "disk",
  );

  const patchDraft = (patch: Partial<VolumeDraft>) => {
    form.setFieldsValue(patch);
    setDraft((current) => ({ ...current, ...patch }));
  };

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue(initial);
    setDraft(initial);
  }, [form, open]);

  return (
    <Modal
      open={open}
      title="Create persistent home volume"
      okText="Create volume"
      confirmLoading={saving}
      okButtonProps={{ disabled: !diskEstimate }}
      onCancel={onCancel}
      onOk={() => void form.validateFields().then(onCreate)}
      width={650}
    >
      <Form<VolumeDraft>
        form={form}
        layout="vertical"
        initialValues={initial}
        onValuesChange={(_, values) => setDraft(values)}
      >
        <Flex gap={12} wrap>
          <Form.Item
            name="name"
            label="Name"
            rules={[{ required: true }, { pattern: /^[a-z][a-z0-9-]{0,31}$/ }]}
            style={{ flex: "1 1 180px" }}
          >
            <Input autoFocus />
          </Form.Item>
        </Flex>
        <Flex gap={12} wrap>
          <Form.Item
            name="funding_mode"
            label="Funding"
            rules={[{ required: true }]}
            style={{ flex: "1 1 260px" }}
          >
            <Select
              options={catalog.funding_modes.map((mode) => ({
                value: mode.value,
                label: mode.label,
                disabled: !mode.allowed,
                title: mode.reason,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="provider"
            label="Cloud provider"
            rules={[{ required: true }]}
            style={{ flex: "1 1 220px" }}
          >
            <Select
              options={catalog.providers.map((value) => ({
                value,
                label: getProviderDescriptor(value).label,
              }))}
              onChange={(nextProvider: "gcp" | "nebius") => {
                const nextCatalog = providerCatalog(catalog, nextProvider);
                const options = getProviderOptions(
                  nextProvider,
                  nextCatalog,
                  {},
                );
                patchDraft({
                  provider: nextProvider,
                  region:
                    nextProvider === "gcp"
                      ? catalog.defaults.region
                      : options.region?.[0]?.value,
                  zone:
                    nextProvider === "gcp"
                      ? catalog.defaults.zone
                      : options.zone?.[0]?.value,
                  size_gb: normalizedVolumeSizeGb(nextProvider, draft.size_gb),
                });
              }}
            />
          </Form.Item>
        </Flex>
        <Flex gap={12} wrap>
          <Form.Item
            name="region"
            label="Region"
            rules={[{ required: true }]}
            style={{ flex: "1 1 220px" }}
          >
            <HostOptionsSelect
              value={region}
              options={regionOptions}
              disabled={!regionOptions.length}
              placeholder={
                regionOptions.length
                  ? "Select a region"
                  : "No regions available"
              }
              onChange={(nextRegion) => {
                const nextSelection = {
                  ...placementSelection,
                  region: nextRegion,
                  zone: undefined,
                };
                const zone = compatibleOptions(
                  provider === "gcp"
                    ? getGcpZoneOptions(hostCatalog, nextSelection)
                    : (getProviderOptions(provider, hostCatalog, nextSelection)
                        .zone ?? []),
                )[0]?.value;
                patchDraft({ region: nextRegion, zone });
              }}
            />
          </Form.Item>
          <Form.Item
            name="zone"
            label="Zone"
            rules={[{ required: provider === "gcp" }]}
            style={{ flex: "1 1 220px" }}
          >
            {!getProviderDescriptor(provider).supports.zone ? (
              <Input disabled placeholder="Provider-managed location" />
            ) : zoneOptions.length ? (
              <HostOptionsSelect options={zoneOptions} />
            ) : (
              <Input />
            )}
          </Form.Item>
          <Form.Item
            name="size_gb"
            label="Size (GB)"
            rules={volumeSizeRules(provider)}
            style={{ flex: "1 1 120px" }}
          >
            <InputNumber
              min={provider === "nebius" ? NEBIUS_VOLUME_INCREMENT_GB : 10}
              max={catalog.limits.max_volume_gb}
              step={provider === "nebius" ? NEBIUS_VOLUME_INCREMENT_GB : 1}
              precision={0}
            />
          </Form.Item>
        </Flex>
      </Form>
      <Alert
        showIcon
        type="info"
        title={
          diskEstimate
            ? `${provider === "nebius" ? "Persistent SSD" : "Balanced persistent SSD"}: ${diskEstimate.monthly_label} (${(diskEstimate.usd_per_month / Number(effectiveVolumeSizeGb(provider, draft.size_gb) ?? 1)).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 3 })}/GB/month)`
            : "Persistent SSD pricing is unavailable for this region"
        }
        description={
          <Space direction="vertical" size={2}>
            <span>
              The volume and VM must use the same provider and location. Volumes
              are retained when VMs are deleted. They can grow online but cannot
              shrink. The estimate includes the site surcharge.
            </span>
            {provider === "nebius" && (
              <Text strong>
                Nebius persistent volumes are available in 93 GB increments.
              </Text>
            )}
          </Space>
        }
      />
      <Divider />
      <Text strong>Equivalent CLI command</Text>
      <CopyToClipBoard
        value={volumeCreateCli({ api, project_id, values: draft })}
        {...COPYABLE_PROPS}
      />
    </Modal>
  );
}

function VolumeResizeModal({
  volume,
  maxSizeGb,
  saving,
  onCancel,
  onResize,
}: {
  volume?: ComputeVolume;
  maxSizeGb: number;
  saving: boolean;
  onCancel: () => void;
  onResize: (values: VolumeResizeDraft) => Promise<void>;
}) {
  const [form] = Form.useForm<VolumeResizeDraft>();
  const sizeGb = Form.useWatch("size_gb", form);
  const currentSizeGb = volume
    ? Math.max(volume.size_gb, volume.effective_size_gb)
    : 10;

  useEffect(() => {
    if (!volume) return;
    form.setFieldsValue({ size_gb: currentSizeGb });
  }, [currentSizeGb, form, volume]);

  const monthlyPrice =
    volume && Number.isFinite(Number(sizeGb))
      ? Number(sizeGb) * Number(volume.monthly_price_per_gb)
      : undefined;
  return (
    <Modal
      open={volume != null}
      title={volume ? "Enlarge " + volume.name : "Enlarge volume"}
      okText="Enlarge volume"
      confirmLoading={saving}
      onCancel={onCancel}
      onOk={() => void form.validateFields().then(onResize)}
    >
      <Form<VolumeResizeDraft> form={form} layout="vertical">
        <Form.Item
          name="size_gb"
          label="New size (GB)"
          extra={
            volume
              ? "Current size: " + currentSizeGb + " GB. Volumes cannot shrink."
              : undefined
          }
          rules={[
            { required: true },
            {
              validator: async (_, value) => {
                if (volume && Number(value) < currentSizeGb) {
                  throw new Error("The new size cannot be smaller.");
                }
              },
            },
            ...(volume ? volumeSizeRules(volume.provider).slice(1) : []),
          ]}
        >
          <InputNumber
            min={currentSizeGb}
            max={maxSizeGb}
            step={
              volume?.provider === "nebius" ? NEBIUS_VOLUME_INCREMENT_GB : 1
            }
            precision={0}
            style={{ width: "100%" }}
          />
        </Form.Item>
      </Form>
      <Alert
        showIcon
        type="info"
        title={
          monthlyPrice == null
            ? "Balanced persistent SSD"
            : "Estimated storage: $" + monthlyPrice.toFixed(2) + "/month"
        }
        description={
          <Space direction="vertical" size={2}>
            <span>
              {volume?.attached_vm_id
                ? "The block device grows online. The VM checks every 30 seconds and automatically grows the ext4 /home/user filesystem without a reboot."
                : "The enlarged capacity is available the next time this volume is attached."}
            </span>
            {volume?.provider === "nebius" && (
              <Text strong>
                Nebius persistent volumes are available in 93 GB increments.
              </Text>
            )}
          </Space>
        }
      />
    </Modal>
  );
}

function VmTtlModal({
  vm,
  saving,
  onCancel,
  onSave,
}: {
  vm?: ComputeVm;
  saving: boolean;
  onCancel: () => void;
  onSave: (values: TtlDraft) => Promise<void>;
}) {
  const [form] = Form.useForm<TtlDraft>();
  const [draft, setDraft] = useState<TtlDraft>({
    action: vm?.expires_at ? "extend" : "set",
    minutes: 60,
  });

  useEffect(() => {
    if (!vm) return;
    const initial: TtlDraft = {
      action: vm.expires_at ? "extend" : "set",
      minutes: 60,
    };
    form.setFieldsValue(initial);
    setDraft(initial);
  }, [form, vm]);

  const duration =
    draft.minutes % 60 === 0 ? `${draft.minutes / 60}h` : `${draft.minutes}m`;
  const command = vm
    ? draft.action === "clear"
      ? `cocalc vm ttl ${vm.name} --clear`
      : `cocalc vm ttl ${vm.name} --${draft.action} ${duration}`
    : "";

  return (
    <Modal
      open={vm != null}
      title={vm ? `Deletion deadline for ${vm.name}` : "Deletion deadline"}
      okText="Save deadline"
      confirmLoading={saving}
      onCancel={onCancel}
      onOk={() => void form.validateFields().then(onSave)}
    >
      <Alert
        showIcon
        type={vm?.expires_at ? "warning" : "info"}
        title={
          vm?.expires_at ? (
            <>
              This VM and its boot disk will be deleted{" "}
              <TimeAgo date={new Date(vm.expires_at)} click_to_toggle={false} />
              .
            </>
          ) : (
            "This VM has no automatic deletion deadline."
          )
        }
        description={
          vm?.expires_at
            ? "A separate persistent home volume is retained."
            : "It runs until you stop or delete it, or membership funding becomes unavailable."
        }
        style={{ marginBottom: 16 }}
      />
      <Form<TtlDraft>
        form={form}
        layout="vertical"
        onValuesChange={(_, values) => setDraft(values)}
      >
        <Form.Item name="action" label="Change">
          <Select
            options={[
              { value: "set", label: "Set deadline from now" },
              ...(vm?.expires_at
                ? [{ value: "extend", label: "Extend current deadline" }]
                : []),
              { value: "clear", label: "Remove deadline" },
            ]}
          />
        </Form.Item>
        {draft.action !== "clear" && (
          <Form.Item
            name="minutes"
            label="Duration"
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: 30, label: "30 minutes" },
                { value: 60, label: "1 hour" },
                { value: 240, label: "4 hours" },
                { value: 480, label: "8 hours" },
                { value: 1440, label: "1 day" },
              ]}
            />
          </Form.Item>
        )}
      </Form>
      <Alert
        showIcon
        type="info"
        title="Membership spending limits remain enforced when no deletion deadline is set."
      />
      <CopyToClipBoard value={command} {...COPYABLE_PROPS} />
    </Modal>
  );
}

function VmMachineTypeModal({
  vm,
  catalog,
  saving,
  error,
  onCancel,
  onSave,
}: {
  vm?: ComputeVm;
  catalog: ComputeCatalog;
  saving: boolean;
  error?: string;
  onCancel: () => void;
  onSave: (machineType: string) => Promise<void>;
}) {
  const [machineType, setMachineType] = useState<string>();
  const [sortByPrice, setSortByPrice] = useState(false);
  const pricingSettings = useHostPricingSettings();

  useEffect(() => {
    setMachineType(vm?.machine_type);
    setSortByPrice(false);
  }, [vm]);

  if (!vm) return null;
  const hostCatalog = providerCatalog(catalog, vm.provider);
  const selection: ProviderSelection = {
    operating_system: vm.operating_system,
    architecture: vm.architecture,
    region: vm.region,
    zone: vm.zone ?? undefined,
    machine_type: machineType,
    gpu_type: vm.gpu_type ?? undefined,
    pricing_model: vm.desired_pricing_model,
    storage_mode: "persistent",
    disk_type: vm.provider === "nebius" ? "ssd" : "balanced",
    disk_gb: vm.boot_disk_gb,
    funding_mode: vm.funding_mode,
    price_display: "hourly",
    pricing_settings: pricingSettings,
  };
  const rawOptions =
    vm.provider === "gcp"
      ? getGcpMachineTypeOptions(hostCatalog, selection)
      : (getProviderOptions(vm.provider, hostCatalog, selection).machine_type ??
        []);
  const machineOptions = sortMachineTypeOptions(
    compatibleOptions(rawOptions).filter(({ value }) => {
      if (
        vm.provider === "gcp" &&
        gcpMachineArchitecture(value) !== vm.architecture
      ) {
        return false;
      }
      const gpu = vm.provider === "gcp" ? gcpMachineGpu(value) : undefined;
      return vm.provider !== "gcp"
        ? true
        : (gpu?.type ?? null) === (vm.gpu_type ?? null) &&
            Number(gpu?.count ?? 0) === Number(vm.gpu_count);
    }),
    sortByPrice ? "price" : "type",
  );
  const estimate = machineType
    ? getProviderPriceEstimate(
        vm.provider,
        hostCatalog,
        selection,
        pricingSettings,
      )
    : undefined;

  return (
    <Modal
      open
      width={720}
      title={`Change machine type for ${vm.name}`}
      okText="Change machine type"
      confirmLoading={saving}
      okButtonProps={{
        disabled: !machineType || machineType === vm.machine_type || !estimate,
      }}
      onCancel={onCancel}
      onOk={() => machineType && void onSave(machineType)}
    >
      <Alert
        showIcon
        type="info"
        title={`This VM remains in ${vm.zone ?? vm.region}`}
        description="The persistent boot disk contains the VM's data and is tied to this location. Changing location requires a separate disk-migration workflow."
        style={{ marginBottom: 16 }}
      />
      <Flex align="center" justify="space-between" gap={12}>
        <Text strong>Machine</Text>
        <Space size={6}>
          <Text type="secondary">Sort by price</Text>
          <Switch
            size="small"
            checked={sortByPrice}
            onChange={setSortByPrice}
          />
        </Space>
      </Flex>
      <div style={{ marginBottom: 16, marginTop: 6 }}>
        <HostOptionsSelect
          options={machineOptions}
          value={machineType}
          onChange={setMachineType}
          style={{ width: "100%" }}
        />
      </div>
      {estimate && (
        <HostPriceBreakdown
          estimate={estimate}
          title={`${pricingLabel(vm.desired_pricing_model)} running cost after change`}
        />
      )}
      {vm.operating_system === "windows" && (
        <Alert
          showIcon
          type="info"
          title="The Windows Server license is charged only while this VM is running."
          style={{ marginTop: 12 }}
        />
      )}
      {error && (
        <Alert
          showIcon
          type="error"
          title="Unable to change machine type"
          description={error}
          style={{ marginTop: 12 }}
        />
      )}
    </Modal>
  );
}

export function ProjectComputeVms({
  project_id,
  compact = false,
  isVisible = true,
}: {
  project_id: string;
  compact?: boolean;
  isVisible?: boolean;
}) {
  const accountSshKeys = useRedux("account", "ssh_keys");
  const sshKeys = sshKeyOptions(accountSshKeys);
  const cloudflareCountry = useTypedRedux("customize", "country");
  const cloudflareRegionCode = useTypedRedux(
    "customize",
    "cloudflare_region_code",
  );
  const preferredR2Region = mapCountryRegionToR2Region(
    cloudflareCountry,
    cloudflareRegionCode,
  );
  const [rows, setRows] = useState<ComputeVm[]>([]);
  const [allRows, setAllRows] = useState<ComputeVm[]>([]);
  const [volumes, setVolumes] = useState<ComputeVolume[]>([]);
  const [catalog, setCatalog] = useState<ComputeCatalog>();
  const [agentGrants, setAgentGrants] = useState<ComputeAgentGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [vmModalOpen, setVmModalOpen] = useState(false);
  const [vmCreateError, setVmCreateError] = useState<string>();
  const [volumeModalOpen, setVolumeModalOpen] = useState(false);
  const [resizeVolumeTarget, setResizeVolumeTarget] = useState<ComputeVolume>();
  const [ttlVm, setTtlVm] = useState<ComputeVm>();
  const [machineTypeVm, setMachineTypeVm] = useState<ComputeVm>();
  const [machineTypeError, setMachineTypeError] = useState<string>();
  const [vmInitial, setVmInitial] = useState<VmDraft>();
  const [projectSshPublicKey, setProjectSshPublicKey] = useState<string | null>(
    null,
  );
  const [projectSshKeyLoading, setProjectSshKeyLoading] = useState(true);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  const load = async ({
    refreshCatalogAndGrants = true,
    showLoading = true,
    projectOnly = false,
  }: {
    refreshCatalogAndGrants?: boolean;
    showLoading?: boolean;
    projectOnly?: boolean;
  } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const [ownedVms, projectVolumes, computeCatalog, grants] =
        await Promise.all([
          webapp_client.conat_client.hub.compute.listVms(
            projectOnly ? { project_id } : {},
          ),
          webapp_client.conat_client.hub.compute.listVolumes({ project_id }),
          refreshCatalogAndGrants
            ? webapp_client.conat_client.hub.compute.getCatalog({})
            : Promise.resolve(undefined),
          refreshCatalogAndGrants
            ? webapp_client.conat_client.hub.compute.listAgentGrants({
                project_id,
              })
            : Promise.resolve(undefined),
        ]);
      if (projectOnly) {
        setAllRows((current) => [
          ...current.filter((vm) => vm.project_id !== project_id),
          ...ownedVms,
        ]);
      } else {
        setAllRows(ownedVms);
      }
      setRows(ownedVms.filter((vm) => vm.project_id === project_id));
      setVolumes(projectVolumes);
      if (computeCatalog != null) setCatalog(computeCatalog);
      if (grants != null) setAgentGrants(grants);
      setError(undefined);
    } catch (err) {
      setError(`${err}`);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    if (!isVisible) return;
    let disposed = false;
    let inFlight = false;
    let refreshCatalogNext = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (disposed || !documentIsVisible()) return;
      timer = setTimeout(
        () => void run(),
        VM_REFRESH_BASE_MS + Math.random() * VM_REFRESH_JITTER_MS,
      );
    };

    const run = async () => {
      if (disposed || !documentIsVisible()) return;
      if (inFlight) {
        refreshCatalogNext = true;
        return;
      }
      inFlight = true;
      const refreshCatalogAndGrants = refreshCatalogNext;
      refreshCatalogNext = false;
      try {
        await load({
          refreshCatalogAndGrants,
          showLoading: refreshCatalogAndGrants,
          projectOnly: !refreshCatalogAndGrants,
        });
      } finally {
        inFlight = false;
        if (disposed || !documentIsVisible()) return;
        if (refreshCatalogNext) {
          void run();
        } else {
          schedule();
        }
      }
    };

    const onVisibilityChange = () => {
      if (timer != null) clearTimeout(timer);
      timer = undefined;
      if (!documentIsVisible()) return;
      refreshCatalogNext = true;
      void run();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void run();
    return () => {
      disposed = true;
      if (timer != null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isVisible, project_id]);

  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    setProjectSshKeyLoading(true);
    void readProjectDeployPublicKey(project_id)
      .then((publicKey) => {
        if (!cancelled) {
          setProjectSshPublicKey(publicKey?.trim() || null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectSshPublicKey(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setProjectSshKeyLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isVisible, project_id]);

  const defaultVm = (): VmDraft => {
    const catalogDefaultZone = catalog?.defaults.zone ?? "us-central1-a";
    const defaultProvider = catalog?.defaults.provider ?? "gcp";
    const defaultCatalog = catalog
      ? providerCatalog(catalog, defaultProvider)
      : undefined;
    const defaultSelection: ProviderSelection = {
      operating_system: "linux",
      region: regionFromZone(catalogDefaultZone),
      zone: catalogDefaultZone,
      machine_type: catalog?.defaults.machine_type ?? "e2-standard-2",
      pricing_model: "on_demand",
      storage_mode: "persistent",
      disk_type: "balanced",
      disk_gb: catalog?.defaults.boot_disk_gb ?? 20,
    };
    const nearestRegion = catalog
      ? sortRegionOptionsByPreference({
          options: compatibleOptions(
            getGcpRegionOptions(defaultCatalog, {
              ...defaultSelection,
              region: undefined,
              zone: undefined,
            }),
          ),
          preference: "closest",
          preferredRegion: preferredR2Region,
        })[0]?.value
      : undefined;
    const nearestZone =
      catalog && nearestRegion
        ? compatibleOptions(
            getGcpZoneOptions(defaultCatalog, {
              ...defaultSelection,
              region: nearestRegion,
              zone: undefined,
            }),
          )[0]?.value
        : undefined;
    const zone = nearestZone ?? catalogDefaultZone;
    const name = availableName(
      "compute-vm",
      allRows.map((vm) => vm.name),
    );
    return {
      name,
      provider: defaultProvider,
      operating_system: catalog?.defaults.operating_system ?? "linux",
      funding_mode: catalog?.default_funding_mode ?? "account-prepaid",
      architecture: catalog?.defaults.architecture ?? "x86_64",
      region: regionFromZone(zone),
      zone,
      machine_type: catalog?.defaults.machine_type ?? "e2-standard-2",
      pricing_model: "on_demand",
      allow_on_demand_fallback: false,
      ttl_minutes: catalog?.defaults.ttl_minutes ?? null,
      boot_disk_gb: catalog?.defaults.boot_disk_gb ?? 20,
      create_home_volume: false,
      new_home_volume_name: availableName(
        name + "-home",
        volumes.map((volume) => volume.name),
      ),
      new_home_volume_size_gb: 50,
      use_project_ssh_key: projectSshPublicKey != null,
      configure_project_ssh: projectSshPublicKey != null,
      ssh_public_key: sshKeys[0]?.value ?? "",
    };
  };

  const openSimilar = (vm: ComputeVm) => {
    const ttlMinutes = originalTtlMinutes(vm);
    const name = similarName(vm.name, allRows);
    setVmInitial({
      name,
      provider: vm.provider,
      operating_system: vm.operating_system ?? "linux",
      funding_mode: vm.funding_mode,
      architecture: vm.architecture,
      region: vm.region,
      zone: vm.zone ?? undefined,
      machine_type: vm.machine_type,
      pricing_model: vm.desired_pricing_model,
      allow_on_demand_fallback: vm.allow_on_demand_fallback,
      ttl_minutes:
        ttlMinutes == null
          ? null
          : Math.min(ttlMinutes, catalog?.limits.max_ttl_minutes ?? ttlMinutes),
      boot_disk_gb: vm.boot_disk_gb,
      create_home_volume: false,
      new_home_volume_name: availableName(
        name + "-home",
        volumes.map((volume) => volume.name),
      ),
      new_home_volume_size_gb: 50,
      use_project_ssh_key: projectSshPublicKey != null,
      configure_project_ssh: projectSshPublicKey != null,
      ssh_public_key: sshKeys[0]?.value ?? "",
    });
    setVmCreateError(undefined);
    setVmModalOpen(true);
  };

  const generateProjectSshKey = async (): Promise<string | undefined> => {
    setSaving(true);
    setError(undefined);
    try {
      let publicKey: string | undefined;
      const completed = await runFreshAuthAction(async () => {
        const result =
          await webapp_client.conat_client.hub.projects.generateProjectSshKeySecret(
            {
              browser_id: webapp_client.browser_id,
              project_id,
            },
          );
        publicKey = result.public_key.trim();
      });
      if (!completed || !publicKey) return;
      setProjectSshPublicKey(publicKey);
      setNotice("Project SSH keypair created and selected for this VM.");
      return publicKey;
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const waitForVolumeReady = async (idOrName: string) => {
    const deadline = Date.now() + 5 * 60_000;
    let state = "requested";
    while (Date.now() < deadline) {
      const volume = await webapp_client.conat_client.hub.compute.getVolume({
        id_or_name: idOrName,
      });
      state = volume.state;
      if (state === "ready") return volume;
      if (state === "failed" || state === "deleted") {
        throw new Error(
          volume.error || "Volume creation failed (state=" + state + ").",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(
      "Timed out waiting for the home volume (state=" + state + ").",
    );
  };

  const createVm = async (values: VmDraft) => {
    setSaving(true);
    setVmCreateError(undefined);
    let createdVolumeName: string | undefined;
    try {
      const completed = await runFreshAuthAction(async () => {
        let homeVolume = values.home_volume;
        if (values.create_home_volume) {
          if (!values.new_home_volume_name || !values.new_home_volume_size_gb) {
            throw new Error("A new home volume name and size are required.");
          }
          const createdVolume =
            await webapp_client.conat_client.hub.compute.createVolume({
              project_id,
              name: values.new_home_volume_name,
              provider: values.provider,
              funding_mode: values.funding_mode,
              region: values.region,
              zone: values.zone,
              size_gb: values.new_home_volume_size_gb,
              idempotency_key: uuid(),
              browser_id: webapp_client.browser_id,
            });
          createdVolumeName = createdVolume.name;
          await waitForVolumeReady(createdVolume.id);
          homeVolume = createdVolume.name;
        }
        await webapp_client.conat_client.hub.compute.createVm({
          project_id,
          name: values.name,
          provider: values.provider,
          operating_system: values.operating_system,
          funding_mode: values.funding_mode,
          architecture: values.architecture,
          region: values.region,
          zone: values.zone,
          machine_type: values.machine_type,
          gpu_type:
            values.gpu_type && values.gpu_type !== "none"
              ? values.gpu_type
              : undefined,
          gpu_count: values.gpu_count,
          pricing_model: values.pricing_model,
          allow_on_demand_fallback: values.allow_on_demand_fallback,
          ttl_minutes: values.ttl_minutes ?? null,
          boot_disk_gb: values.boot_disk_gb,
          home_volume: homeVolume,
          ssh_public_key: values.ssh_public_key,
          configure_project_ssh: values.configure_project_ssh,
          idempotency_key: uuid(),
          browser_id: webapp_client.browser_id,
        });
      });
      if (!completed) return;
      setVmModalOpen(false);
      setNotice(`VM '${values.name}' requested.`);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setVmCreateError(
        createdVolumeName
          ? "Volume '" +
              createdVolumeName +
              "' was created and retained, but VM creation failed: " +
              message
          : message,
      );
    } finally {
      setSaving(false);
    }
  };

  const deleteVm = async (vm: ComputeVm) => {
    setError(undefined);
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.compute.deleteVm({
          id_or_name: vm.id,
          idempotency_key: uuid(),
          browser_id: webapp_client.browser_id,
        });
      });
      if (!completed) return;
      setNotice(`VM '${vm.name}' is being deleted.`);
      await load();
    } catch (err) {
      setError(`${err}`);
    }
  };

  const revokeAgentGrant = async (grant: ComputeAgentGrant) => {
    setError(undefined);
    try {
      await webapp_client.conat_client.hub.compute.revokeAgentGrant({
        grant_id: grant.grant_id,
      });
      setNotice("The Codex VM authorization was revoked.");
      await load();
    } catch (err) {
      setError(`${err}`);
    }
  };

  const setVmRunning = async (vm: ComputeVm, running: boolean) => {
    setError(undefined);
    try {
      const action = running ? "startVm" : "stopVm";
      const execute = async () => {
        await webapp_client.conat_client.hub.compute[action]({
          id_or_name: vm.id,
          idempotency_key: uuid(),
          ...(running ? { browser_id: webapp_client.browser_id } : {}),
        });
      };
      if (running) {
        const completed = await runFreshAuthAction(execute);
        if (!completed) return;
      } else {
        await execute();
      }
      setNotice(`VM '${vm.name}' is ${running ? "starting" : "stopping"}.`);
      await load();
    } catch (err) {
      setError(`${err}`);
    }
  };

  const saveVmMachineType = async (machineType: string) => {
    if (!machineTypeVm) return;
    setSaving(true);
    setMachineTypeError(undefined);
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.compute.setVmMachineType({
          id_or_name: machineTypeVm.id,
          machine_type: machineType,
          idempotency_key: uuid(),
          browser_id: webapp_client.browser_id,
        });
      });
      if (!completed) return;
      setNotice(
        `Machine type for '${machineTypeVm.name}' changed to ${machineType}.`,
      );
      setMachineTypeVm(undefined);
      await load();
    } catch (err) {
      setMachineTypeError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const changeVmFunding = (vm: ComputeVm) => {
    let fundingMode = vm.funding_mode;
    Modal.confirm({
      title: `Change funding for ${vm.name}`,
      content: (
        <Select
          defaultValue={fundingMode}
          style={{ marginTop: 12, width: "100%" }}
          options={(catalog?.funding_modes ?? []).map((mode) => ({
            value: mode.value,
            label: mode.allowed ? mode.label : `${mode.label} (${mode.reason})`,
            disabled: !mode.allowed,
          }))}
          onChange={(value) => {
            fundingMode = value;
          }}
        />
      ),
      okText: "Change funding",
      onOk: async () => {
        if (fundingMode === vm.funding_mode) return;
        const completed = await runFreshAuthAction(async () => {
          await webapp_client.conat_client.hub.compute.setVmFundingMode({
            id_or_name: vm.id,
            funding_mode: fundingMode,
            idempotency_key: uuid(),
            browser_id: webapp_client.browser_id,
          });
        });
        if (!completed) throw new Error("Fresh authorization was cancelled.");
        setNotice(`Funding for '${vm.name}' changed to ${fundingMode}.`);
        await load();
      },
    });
  };

  const changeVolumeFunding = (volume: ComputeVolume) => {
    let fundingMode = volume.funding_mode;
    Modal.confirm({
      title: `Change funding for ${volume.name}`,
      content: (
        <Select
          defaultValue={fundingMode}
          style={{ marginTop: 12, width: "100%" }}
          options={(catalog?.funding_modes ?? []).map((mode) => ({
            value: mode.value,
            label: mode.allowed ? mode.label : `${mode.label} (${mode.reason})`,
            disabled: !mode.allowed,
          }))}
          onChange={(value) => {
            fundingMode = value;
          }}
        />
      ),
      okText: "Change funding",
      onOk: async () => {
        if (fundingMode === volume.funding_mode) return;
        const completed = await runFreshAuthAction(async () => {
          await webapp_client.conat_client.hub.compute.setVolumeFundingMode({
            id_or_name: volume.id,
            funding_mode: fundingMode,
            idempotency_key: uuid(),
            browser_id: webapp_client.browser_id,
          });
        });
        if (!completed) throw new Error("Fresh authorization was cancelled.");
        setNotice(`Funding for '${volume.name}' changed to ${fundingMode}.`);
        await load();
      },
    });
  };

  const saveVmTtl = async (values: TtlDraft) => {
    if (!ttlVm) return;
    setSaving(true);
    setError(undefined);
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.compute.setVmTtl({
          id_or_name: ttlVm.id,
          ...(values.action === "extend"
            ? { extend_minutes: values.minutes }
            : {
                ttl_minutes: values.action === "clear" ? null : values.minutes,
              }),
          idempotency_key: uuid(),
          browser_id: webapp_client.browser_id,
        });
      });
      if (!completed) return;
      setNotice(`Deletion deadline for '${ttlVm.name}' updated.`);
      setTtlVm(undefined);
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  };

  const createVolume = async (values: VolumeDraft) => {
    setSaving(true);
    setError(undefined);
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.compute.createVolume({
          project_id,
          name: values.name,
          provider: values.provider,
          funding_mode: values.funding_mode,
          region: values.region,
          zone: values.zone,
          size_gb: values.size_gb,
          idempotency_key: uuid(),
          browser_id: webapp_client.browser_id,
        });
      });
      if (!completed) return;
      setVolumeModalOpen(false);
      setNotice(`Volume '${values.name}' requested.`);
      await load();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  };

  const resizeVolume = async (values: VolumeResizeDraft) => {
    if (!resizeVolumeTarget) return;
    setSaving(true);
    setError(undefined);
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.compute.resizeVolume({
          id_or_name: resizeVolumeTarget.id,
          size_gb: values.size_gb,
          idempotency_key: uuid(),
          browser_id: webapp_client.browser_id,
        });
      });
      if (!completed) return;
      setNotice(
        "Volume '" +
          resizeVolumeTarget.name +
          "' is growing to " +
          values.size_gb +
          " GB.",
      );
      setResizeVolumeTarget(undefined);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteVolume = async (volume: ComputeVolume) => {
    setError(undefined);
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.compute.deleteVolume({
          id_or_name: volume.id,
          confirm_name: volume.name,
          idempotency_key: uuid(),
          browser_id: webapp_client.browser_id,
        });
      });
      if (!completed) return;
      setNotice(`Volume '${volume.name}' is being deleted.`);
      await load();
    } catch (err) {
      setError(`${err}`);
    }
  };

  const vmColumns: ColumnsType<ComputeVm> = [
    {
      title: "VM",
      dataIndex: "name",
      fixed: "left",
      width: 180,
      render: (name: string, vm) => (
        <Space direction="vertical" size={0}>
          <Text strong>{name}</Text>
          <Text copyable={{ text: vm.id }} type="secondary">
            ID {vm.id.slice(0, 8)}
          </Text>
        </Space>
      ),
    },
    {
      title: "Status",
      dataIndex: "state",
      width: 160,
      render: (state: string, vm) => (
        <Space direction="vertical" size={1} style={{ minWidth: 0 }}>
          <Tag
            color={state === "ready" ? "green" : undefined}
            style={{ marginInlineEnd: 0, width: "fit-content" }}
          >
            {state}
          </Tag>
          {vm.expires_at && (
            <Text type="secondary">
              Deletes <TimeAgo date={new Date(vm.expires_at)} />
            </Text>
          )}
          {state === "recovering" && (
            <Text type="secondary">Spot unavailable; retrying</Text>
          )}
          {state === "failed" && vm.error && (
            <Popover
              trigger="click"
              title={providerErrorSummary(vm.error)}
              content={
                <Space direction="vertical" size={8} style={{ maxWidth: 430 }}>
                  {/ZONE_RESOURCE_POOL_EXHAUSTED|not enough resources/i.test(
                    vm.error,
                  ) && (
                    <Text>
                      Stop this VM, choose another machine type, then start it
                      again. If the zone remains out of capacity, create a VM in
                      another zone.
                    </Text>
                  )}
                  <Text type="secondary" copyable={{ text: vm.error }}>
                    {vm.error}
                  </Text>
                </Space>
              }
            >
              <Button danger size="small" type="link" style={{ padding: 0 }}>
                {providerErrorSummary(vm.error)}
              </Button>
            </Popover>
          )}
          {!vm.expires_at && <Text type="secondary">No deletion deadline</Text>}
        </Space>
      ),
    },
    {
      title: "Configuration",
      width: 175,
      render: (_, vm) => (
        <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
          <Text strong>{vm.machine_type}</Text>
          <Text type="secondary">
            {getProviderDescriptor(vm.provider).label} · {vm.architecture} ·{" "}
            {vm.operating_system === "windows" ? "Windows 2022" : "Linux"}
          </Text>
          <Text type="secondary">{vm.zone ?? vm.region}</Text>
          <Text type="secondary">Boot disk · {vm.boot_disk_gb} GB</Text>
          {vm.gpu_type && (
            <Text type="secondary">
              {vm.gpu_count}× {vm.gpu_type}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: "Cost & usage",
      width: 190,
      render: (_, vm) => {
        const egress = vm.egress_summary;
        const gb = Number(egress.current_month_bytes ?? 0) / 1_000_000_000;
        const cost = Number(egress.current_month_cost_usd ?? 0);
        const estimate = vmStoredPriceEstimate(vm);
        const stoppedEstimate = vmStoredStoppedPriceEstimate(vm);
        const egressLabel = egressRateLabel(vm);
        return (
          <Popover
            trigger="click"
            title={`Cost and usage for ${vm.name}`}
            content={
              <Space
                direction="vertical"
                size={10}
                style={{ width: 430, maxWidth: "80vw" }}
              >
                {estimate ? (
                  <HostPriceBreakdown
                    estimate={estimate}
                    title={`${pricingLabel(vm.effective_pricing_model)} running cost`}
                  />
                ) : (
                  <Text>Running cost: {hourlyPrice(vm)}</Text>
                )}
                {stoppedEstimate && (
                  <HostPriceBreakdown
                    compact
                    estimate={stoppedEstimate}
                    title="Stopped cost"
                  />
                )}
                <Text>
                  Current-month egress: {gb.toFixed(gb >= 10 ? 1 : 3)} GB ·{" "}
                  {vm.provider === "nebius"
                    ? "$0/GB"
                    : vm.funding_mode === "site-funded"
                      ? "$0.10/GB · paid by site"
                      : `$0.10/GB · $${cost.toFixed(2)} charged`}
                </Text>
                <Text type="secondary">
                  Lifetime egress:{" "}
                  {(Number(egress.lifetime_bytes) / 1_000_000_000).toFixed(3)}{" "}
                  GB · ${Number(egress.lifetime_cost_usd).toFixed(2)}.
                  {egress.stale
                    ? " Usage reporting is delayed; these totals may lag."
                    : ""}
                </Text>
                <Text type="secondary">
                  The boot disk remains billable while stopped and cannot
                  currently be enlarged after creation.
                </Text>
              </Space>
            }
          >
            <Button
              type="link"
              style={{ height: "auto", padding: 0, textAlign: "left" }}
            >
              <Space direction="vertical" size={0} align="start">
                <Text>
                  {pricingLabel(vm.effective_pricing_model)} · {hourlyPrice(vm)}
                </Text>
                <Text type="secondary">{vm.funding_mode}</Text>
                <Text type="secondary">
                  {egressLabel} · {gb.toFixed(gb >= 10 ? 1 : 3)} GB
                  {egress.stale ? " · usage reporting delayed" : ""}
                </Text>
              </Space>
            </Button>
          </Popover>
        );
      },
    },
    {
      title: "Actions",
      width: 215,
      render: (_, vm) => {
        const transitioning = ["starting", "stopping", "deleting"].includes(
          vm.state,
        );
        const running =
          vm.desired_state === "running" && vm.state !== "stopped";
        const cliCommand = `cocalc vm ssh ${vm.name}`;
        const directCommand = vm.public_hostname
          ? `ssh ${vm.ssh_user || "user"}@${vm.public_hostname}`
          : undefined;
        const projectSshCommand =
          vm.state === "ready" && vm.metadata?.configure_project_ssh === true
            ? `ssh ${vm.ssh_alias || vm.name}`
            : undefined;
        const directRdpTunnelCommand =
          vm.operating_system === "windows" && vm.public_hostname
            ? `ssh -N -L 3389:localhost:3389 ${vm.ssh_user || "user"}@${vm.public_hostname}`
            : undefined;
        return (
          <Space.Compact>
            <Popover
              trigger="click"
              placement="bottomRight"
              title={`Connect to ${vm.name}`}
              content={
                <Space
                  direction="vertical"
                  size={10}
                  style={{
                    maxHeight: "calc(100vh - 140px)",
                    maxWidth: 430,
                    overflowY: "auto",
                    paddingRight: 6,
                    width: 390,
                  }}
                >
                  {projectSshCommand && (
                    <div>
                      <Text type="secondary">From this project</Text>
                      <br />
                      <Text code copyable={{ text: projectSshCommand }}>
                        {projectSshCommand}
                      </Text>
                      <br />
                      <Text type="secondary">
                        This shortcut is managed in .ssh/config.
                      </Text>
                    </div>
                  )}
                  <div>
                    <Text type="secondary">CoCalc CLI</Text>
                    <br />
                    <Text code copyable={{ text: cliCommand }}>
                      {cliCommand}
                    </Text>
                  </div>
                  {vm.public_hostname && (
                    <div>
                      <Text type="secondary">DNS hostname</Text>
                      <br />
                      <Text copyable={{ text: vm.public_hostname }}>
                        {vm.public_hostname}
                      </Text>
                    </div>
                  )}
                  {directCommand ? (
                    <div>
                      <Text type="secondary">Direct SSH</Text>
                      <br />
                      <Text code copyable={{ text: directCommand }}>
                        {directCommand}
                      </Text>
                    </div>
                  ) : (
                    <Text type="secondary">
                      A public address will appear when the VM is ready.
                    </Text>
                  )}
                  {vm.operating_system === "windows" && (
                    <div>
                      <Text type="secondary">Remote Desktop</Text>
                      <br />
                      <Text
                        code
                        copyable={{ text: `cocalc vm rdp ${vm.name}` }}
                      >
                        cocalc vm rdp {vm.name}
                      </Text>
                      <br />
                      <Text type="secondary">
                        Generates a fresh password and a private SSH tunnel; TCP
                        3389 is not public.
                      </Text>
                      {directRdpTunnelCommand && (
                        <>
                          <br />
                          <br />
                          <Text type="secondary">Manual SSH tunnel</Text>
                          <br />
                          <Text
                            code
                            copyable={{ text: directRdpTunnelCommand }}
                          >
                            {directRdpTunnelCommand}
                          </Text>
                          <br />
                          <Text type="secondary">
                            If RDP credentials are already configured, connect
                            your RDP client to localhost:3389. This command does
                            not create or reset the Windows password.
                          </Text>
                        </>
                      )}
                    </div>
                  )}
                  <Text type="secondary">
                    Public TCP ports: {vm.public_ports.join(", ")}. HTTPS
                    certificates and services are managed by you.
                  </Text>
                </Space>
              }
            >
              <Button size="small" type="primary">
                Connect
              </Button>
            </Popover>
            {running ? (
              <Popconfirm
                title={`Stop ${vm.name}?`}
                description="Compute and Windows license charges stop, but persistent disk charges continue."
                okText="Stop VM"
                cancelText="Keep running"
                onConfirm={() => void setVmRunning(vm, false)}
              >
                <Button size="small" disabled={transitioning}>
                  Stop
                </Button>
              </Popconfirm>
            ) : (
              <Button
                size="small"
                disabled={transitioning}
                onClick={() => void setVmRunning(vm, true)}
              >
                Start
              </Button>
            )}
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  {
                    key: "machine-type",
                    disabled: vm.state !== "stopped",
                    label:
                      vm.state === "stopped"
                        ? "Change machine type"
                        : "Change machine type (stop first)",
                  },
                  {
                    key: "deadline",
                    label: vm.expires_at
                      ? "Change deletion deadline"
                      : "Set deletion deadline",
                  },
                  { key: "similar", label: "Create similar" },
                  { key: "funding", label: "Change funding" },
                  { type: "divider" },
                  {
                    key: "delete",
                    danger: true,
                    disabled: vm.state === "deleting",
                    label: "Delete VM",
                  },
                ],
                onClick: ({ key }) => {
                  if (key === "machine-type") {
                    setMachineTypeError(undefined);
                    setMachineTypeVm(vm);
                  } else if (key === "deadline") {
                    setTtlVm(vm);
                  } else if (key === "similar") {
                    openSimilar(vm);
                  } else if (key === "funding") {
                    changeVmFunding(vm);
                  } else if (key === "delete") {
                    Modal.confirm({
                      title: `Delete ${vm.name}?`,
                      content:
                        "The VM, persistent boot disk, public address, and DNS record are deleted. An attached persistent home volume is retained independently.",
                      okText: "Delete VM",
                      okButtonProps: { danger: true },
                      onOk: () => deleteVm(vm),
                    });
                  }
                },
              }}
            >
              <Button size="small">Manage</Button>
            </Dropdown>
          </Space.Compact>
        );
      },
    },
  ];

  const volumeColumns: ColumnsType<ComputeVolume> = [
    {
      title: "Name",
      dataIndex: "name",
      render: (name: string, volume) => (
        <div>
          <Text strong>{name}</Text>
          <br />
          <Text copyable={{ text: volume.id }} type="secondary">
            {volume.id.slice(0, 8)}
          </Text>
        </div>
      ),
    },
    {
      title: "State",
      dataIndex: "state",
      render: (state: string) => <Tag>{state}</Tag>,
    },
    {
      title: "Size",
      render: (_, volume) => `${volume.effective_size_gb} GB`,
    },
    {
      title: "Location",
      render: (_, volume) => volume.zone ?? volume.region,
    },
    {
      title: "Attachment",
      render: (_, volume) => (
        <span>
          {volume.attachment_state}
          {volume.attached_vm_id
            ? ` · ${rows.find((vm) => vm.id === volume.attached_vm_id)?.name ?? volume.attached_vm_id.slice(0, 8)}`
            : ""}
        </span>
      ),
    },
    {
      title: "Storage",
      render: (_, volume) =>
        `$${(
          volume.effective_size_gb * Number(volume.monthly_price_per_gb)
        ).toFixed(2)}/month · ${volume.funding_mode}`,
    },
    {
      title: "Actions",
      render: (_, volume) => {
        const attached =
          !!volume.attached_vm_id || volume.attachment_state !== "detached";
        return (
          <Flex gap={4} wrap>
            <Button
              size="small"
              disabled={volume.state !== "ready"}
              onClick={() => setResizeVolumeTarget(volume)}
            >
              Enlarge
            </Button>
            <Button size="small" onClick={() => changeVolumeFunding(volume)}>
              Funding
            </Button>
            <Popconfirm
              title={`Permanently delete ${volume.name}?`}
              description="All data on this volume will be lost."
              okText="Delete volume"
              okButtonProps={{ danger: true }}
              disabled={attached}
              onConfirm={() => deleteVolume(volume)}
            >
              <Button danger size="small" disabled={attached}>
                Delete
              </Button>
            </Popconfirm>
          </Flex>
        );
      },
    },
  ];

  return (
    <div
      style={{
        boxSizing: "border-box",
        margin: compact ? undefined : "0 auto",
        maxWidth: compact ? undefined : 1180,
        padding: compact ? 12 : 24,
        width: "100%",
      }}
    >
      <Flex align="center" justify="space-between" gap={12} wrap>
        <div>
          <Flex align="center" gap={4}>
            <Title level={compact ? 5 : 3} style={{ marginBottom: 0 }}>
              <Icon name="server" /> Virtual machines
            </Title>
            <Popover
              trigger="click"
              title="VMs use your membership's dedicated-host spending limits"
              content={
                <Space direction="vertical" size={10} style={{ maxWidth: 430 }}>
                  <Paragraph style={{ marginBottom: 0 }}>
                    VMs run either minimal Ubuntu 24.04 LTS or Windows Server
                    2022; CoCalc and other special software are not installed.
                    Compute, boot disks, and retained home volumes appear in
                    Purchases. The login is <Text code>user</Text>.
                  </Paragraph>
                  <Paragraph style={{ marginBottom: 0 }}>
                    Billable GCP public Internet egress costs $0.10/GB and
                    appears as one accumulating purchase per VM per calendar
                    month. For site-funded VMs, the site pays that GCP egress
                    cost. Nebius egress costs $0/GB. Usage can take about five
                    minutes to appear.
                  </Paragraph>
                  <Paragraph style={{ marginBottom: 0 }}>
                    Running VMs stop when funding is unavailable. After
                    authorizing an SSH key, connect with the CoCalc CLI or
                    directly as <Text code>user</Text> at the stable hostname.
                    TCP ports 22 and 443 are public; you manage any HTTPS server
                    and certificate yourself.
                  </Paragraph>
                </Space>
              }
            >
              <Button
                aria-label="Virtual machine help"
                icon={<Icon name="question-circle" />}
                shape="circle"
                size="small"
                type="text"
              />
            </Popover>
          </Flex>
          {!compact && (
            <Paragraph type="secondary" style={{ marginBottom: 12 }}>
              Short-lived machines owned by you and attached to project{" "}
              <Text code>{shortProjectId(project_id)}</Text>.
            </Paragraph>
          )}
        </div>
        <Space>
          <Button
            icon={<Icon name="book" />}
            onClick={() =>
              openProjectDocs({
                projectId: project_id,
                slug: "projects/virtual-machines",
              })
            }
          >
            Documentation
          </Button>
          <Button
            type="primary"
            icon={<Icon name="plus" />}
            disabled={!catalog || projectSshKeyLoading}
            loading={projectSshKeyLoading}
            onClick={() => {
              setVmInitial(defaultVm());
              setVmCreateError(undefined);
              setVmModalOpen(true);
            }}
          >
            Create VM
          </Button>
          <Button
            icon={<Icon name="refresh" />}
            loading={loading}
            onClick={() => void load()}
          >
            Refresh
          </Button>
        </Space>
      </Flex>
      {error && (
        <Alert
          closable
          showIcon
          type="warning"
          title="Managed compute action failed"
          description={error}
          onClose={() => setError(undefined)}
          style={{ marginBottom: 12 }}
        />
      )}
      {notice && (
        <Alert
          closable
          showIcon
          type="success"
          title={notice}
          onClose={() => setNotice(undefined)}
          style={{ marginBottom: 12 }}
        />
      )}
      {agentGrants
        .filter(
          (grant) =>
            !grant.metadata?.pending_request &&
            grant.allowed_actions.some((action) =>
              ["availability", "billable", "destructive"].includes(action),
            ),
        )
        .map((grant) => {
          const availabilityScope = hasProjectVmAvailabilityScope(grant);
          const request = grant.metadata?.approved_request;
          return (
            <Alert
              key={grant.grant_id}
              showIcon
              type="info"
              title={
                availabilityScope
                  ? "Codex can start and stop project VMs"
                  : "Codex has temporary VM authority"
              }
              description={
                <Space direction="vertical" size={8}>
                  <Text>
                    {availabilityScope
                      ? "This turn may start and stop existing VMs in this project. Starting a VM incurs its configured price."
                      : `${request?.operation ?? grant.allowed_actions.join(", ")}${request?.vm_id ? ` · resource ${request.vm_id.slice(0, 8)}` : ""}`}
                  </Text>
                  <Text type="secondary">
                    {availabilityScope
                      ? `Current authorization record expires ${new Date(grant.expires_at).toLocaleTimeString()} and is extended only by valid credentials from this turn.`
                      : `Expires ${new Date(grant.expires_at).toLocaleTimeString()}.`}
                  </Text>
                  <Button
                    size="small"
                    onClick={() => void revokeAgentGrant(grant)}
                  >
                    Revoke now
                  </Button>
                </Space>
              }
              style={{ marginBottom: 12 }}
            />
          );
        })}
      <Table<ComputeVm>
        columns={vmColumns}
        dataSource={rows}
        loading={loading && rows.length === 0}
        locale={{
          emptyText: "No virtual machines are attached to this project.",
        }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 920 }}
        size="small"
      />

      <Flex align="center" justify="space-between" style={{ marginTop: 28 }}>
        <div>
          <Flex align="center" gap={4}>
            <Title level={4} style={{ marginBottom: 0 }}>
              Persistent home volumes
            </Title>
            <Popover
              trigger="click"
              title="About persistent home volumes"
              content={
                <Paragraph style={{ marginBottom: 0, maxWidth: 400 }}>
                  Retained independently from virtual machines. A volume can
                  only be attached at <Text code>/home/user</Text> to a VM from
                  the same provider and location. Select an existing volume or
                  create a new one when creating the VM; changing attachments
                  later is not yet supported.
                </Paragraph>
              }
            >
              <Button
                aria-label="Persistent volume help"
                icon={<Icon name="question-circle" />}
                shape="circle"
                size="small"
                type="text"
              />
            </Popover>
          </Flex>
        </div>
        <Button
          icon={<Icon name="plus" />}
          disabled={!catalog}
          onClick={() => setVolumeModalOpen(true)}
        >
          Create volume
        </Button>
      </Flex>
      <Table<ComputeVolume>
        columns={volumeColumns}
        dataSource={volumes}
        loading={loading && volumes.length === 0}
        locale={{ emptyText: "No persistent volumes belong to this project." }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 850 }}
        size="small"
        style={{ marginTop: 12 }}
      />

      <Alert
        showIcon
        type="info"
        title={
          <span>
            Prefer a terminal?{" "}
            <a href={COCALC_CLI_DOWNLOAD_URL}>Install the CoCalc CLI</a>.
          </span>
        }
        description={
          <CopyToClipBoard
            value={COCALC_CLI_INSTALL_COMMAND}
            {...COPYABLE_PROPS}
          />
        }
        style={{ marginTop: 20 }}
      />

      {catalog && vmInitial && (
        <VmCreateModal
          open={vmModalOpen}
          project_id={project_id}
          catalog={catalog}
          volumes={volumes}
          initial={vmInitial}
          projectSshPublicKey={projectSshPublicKey}
          sshKeys={sshKeys}
          saving={saving}
          error={vmCreateError}
          preferredR2Region={preferredR2Region}
          onGenerateProjectSshKey={generateProjectSshKey}
          onCancel={() => {
            setVmModalOpen(false);
            setVmCreateError(undefined);
          }}
          onCreate={createVm}
        />
      )}
      {catalog && (
        <VolumeCreateModal
          open={volumeModalOpen}
          project_id={project_id}
          catalog={catalog}
          saving={saving}
          onCancel={() => setVolumeModalOpen(false)}
          onCreate={createVolume}
        />
      )}
      <VmTtlModal
        vm={ttlVm}
        saving={saving}
        onCancel={() => setTtlVm(undefined)}
        onSave={saveVmTtl}
      />
      {catalog && (
        <VmMachineTypeModal
          vm={machineTypeVm}
          catalog={catalog}
          saving={saving}
          error={machineTypeError}
          onCancel={() => {
            setMachineTypeVm(undefined);
            setMachineTypeError(undefined);
          }}
          onSave={saveVmMachineType}
        />
      )}
      {catalog && (
        <VolumeResizeModal
          volume={resizeVolumeTarget}
          maxSizeGb={catalog.limits.max_volume_gb}
          saving={saving}
          onCancel={() => setResizeVolumeTarget(undefined)}
          onResize={resizeVolume}
        />
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
