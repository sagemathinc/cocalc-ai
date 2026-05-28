import {
  Alert,
  Button,
  Col,
  Form,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Typography,
} from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { HostProvider } from "../types";
import type {
  HostCatalog,
  HostCatalogEntry,
} from "@cocalc/conat/hub/api/hosts";
import { COLORS } from "@cocalc/util/theme";

const NEBIUS_DISK_INCREMENT_GB = 93;
const GCP_SHARED_SCRATCH_MIN_GB = 10;
const MONTHLY_HOURS = 730;

const DURABILITY_LABELS = {
  "single-copy": "single copy",
  replicated: "replicated",
  "highly-replicated": "highly replicated",
} as const;

const normalizeSharedDiskSize = ({
  provider,
  size,
}: {
  provider?: HostProvider;
  size: number;
}) => {
  const min = minSharedDiskSize(provider);
  const next = Math.max(min, Math.floor(size));
  if (provider === "nebius") {
    return (
      Math.ceil(next / NEBIUS_DISK_INCREMENT_GB) * NEBIUS_DISK_INCREMENT_GB
    );
  }
  return next;
};

function minSharedDiskSize(provider?: HostProvider) {
  if (provider === "gcp") return GCP_SHARED_SCRATCH_MIN_GB;
  if (provider === "nebius") return NEBIUS_DISK_INCREMENT_GB;
  return 1;
}

function formatUsdMonthlyPerGb(hourly: number | undefined) {
  if (hourly == null || !Number.isFinite(hourly) || hourly <= 0) {
    return undefined;
  }
  const monthly = hourly * MONTHLY_HOURS;
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.ceil((monthly - Number.EPSILON) * 100) / 100);
  return `${amount}/GB-mo`;
}

function catalogPayload<T>(
  catalog: HostCatalog | undefined,
  kind: string,
  scope = "global",
): T | undefined {
  const entry = (catalog?.entries ?? []).find(
    (item: HostCatalogEntry) => item.kind === kind && item.scope === scope,
  );
  return entry?.payload as T | undefined;
}

function gcpDiskPricePerGbHour(
  catalog: HostCatalog | undefined,
  diskType: string,
) {
  const prices = catalogPayload<any>(catalog, "prices");
  const key =
    diskType === "standard"
      ? "pd-standard"
      : diskType === "ssd"
        ? "pd-ssd"
        : diskType === "balanced"
          ? "pd-balanced"
          : undefined;
  if (!key) return undefined;
  const rates = prices?.disks?.[key];
  const values = Object.values(rates ?? {})
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return values[0];
}

function nebiusDiskProduct(diskType: string) {
  switch (diskType) {
    case "balanced":
      return "Network SSD Non-replicated disk";
    case "ssd":
      return "Network SSD disk";
    case "ssd_io_m3":
      return "Network SSD IO M3 disk";
    default:
      return undefined;
  }
}

function nebiusDiskPricePerGbHour(
  catalog: HostCatalog | undefined,
  diskType: string,
) {
  const product = nebiusDiskProduct(diskType);
  if (!product) return undefined;
  const prices = catalogPayload<unknown>(catalog, "prices");
  const items = Array.isArray(prices)
    ? (prices as Array<{ product: string; price_usd: string; unit: string }>)
    : [];
  const item = items.find(
    (price) => price.product === product && /gib/i.test(price.unit),
  );
  const price = Number(item?.price_usd);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const unit = `${item?.unit ?? ""}`.trim();
  const monthMatch = unit.match(/gib per (\d+) hours/i);
  if (monthMatch) {
    const hours = Number(monthMatch[1]);
    return Number.isFinite(hours) && hours > 0 ? price / hours : undefined;
  }
  return /gib hour$/i.test(unit) ? price : undefined;
}

function diskPricePerGbMonthLabel(
  provider: HostProvider | undefined,
  catalog: HostCatalog | undefined,
  diskType: string,
) {
  const hourly =
    provider === "gcp"
      ? gcpDiskPricePerGbHour(catalog, diskType)
      : provider === "nebius"
        ? nebiusDiskPricePerGbHour(catalog, diskType)
        : undefined;
  return formatUsdMonthlyPerGb(hourly);
}

type HostSharedScratchFieldsProps = {
  provider?: HostProvider;
  catalog?: HostCatalog;
  disabled?: boolean;
  currentSizeGb?: number;
  allowDelete?: boolean;
  onDelete?: () => void | Promise<void>;
  deleting?: boolean;
  draftManaged?: boolean;
  onDraftPatch?: (patch: Record<string, any>) => void;
  currentDiskType?: string;
};

export function supportsSharedScratch(
  provider?: HostProvider,
  catalog?: HostCatalog,
) {
  if (!provider) return false;
  return !!catalog?.provider_capabilities?.[provider]?.sharedScratchDisk
    ?.supported;
}

export const HostSharedScratchFields: React.FC<
  HostSharedScratchFieldsProps
> = ({
  provider,
  catalog,
  disabled,
  currentSizeGb,
  allowDelete,
  onDelete,
  deleting,
  draftManaged,
  onDraftPatch,
  currentDiskType,
}) => {
  const form = Form.useFormInstance();
  const cap = provider
    ? catalog?.provider_capabilities?.[provider]?.sharedScratchDisk
    : undefined;
  const supported = !!cap?.supported;
  const watchedSize = Form.useWatch("shared_disk_gb", form);
  const watchedType = Form.useWatch("shared_disk_type", form);
  const currentSize = Number(currentSizeGb ?? 0);
  const [scratchEnabled, setScratchEnabled] = React.useState(
    () => currentSize > 0,
  );
  const enabled = currentSize > 0 || scratchEnabled;
  const diskTypes = cap?.disk_types ?? [];
  const defaultDiskType =
    diskTypes.find((entry) => entry.default)?.value ?? diskTypes[0]?.value;
  const diskTypeOptions = diskTypes.map((entry) => {
    const priceLabel = diskPricePerGbMonthLabel(provider, catalog, entry.value);
    return {
      value: entry.value,
      label: `${entry.label} (${DURABILITY_LABELS[entry.durability]})${
        priceLabel ? ` - ${priceLabel}` : ""
      }`,
    };
  });
  const step = provider === "nebius" ? NEBIUS_DISK_INCREMENT_GB : 1;
  const minSize = Math.max(
    minSharedDiskSize(provider),
    Number(currentSizeGb ?? 0) || 0,
  );
  const defaultSharedDiskGb = normalizeSharedDiskSize({
    provider,
    size: minSharedDiskSize(provider),
  });

  const setFields = React.useCallback(
    (patch: Record<string, any>) => {
      form.setFieldsValue(patch);
      if (draftManaged) {
        onDraftPatch?.(patch);
      }
    },
    [draftManaged, form, onDraftPatch],
  );

  React.useEffect(() => {
    if (!supported) {
      setScratchEnabled(false);
      if (watchedSize != null || watchedType != null) {
        setFields({
          shared_disk_gb: undefined,
          shared_disk_type: undefined,
        });
      }
      return;
    }
    if (enabled && !watchedType && (currentDiskType || defaultDiskType)) {
      setFields({ shared_disk_type: currentDiskType ?? defaultDiskType });
    }
  }, [
    currentDiskType,
    defaultDiskType,
    enabled,
    setFields,
    supported,
    watchedSize,
    watchedType,
  ]);
  React.useEffect(() => {
    if (currentSize > 0) {
      setScratchEnabled(true);
      return;
    }
    if (
      typeof watchedSize === "number" &&
      Number.isFinite(watchedSize) &&
      watchedSize > 0
    ) {
      setScratchEnabled(true);
    }
  }, [currentSize, watchedSize]);

  if (!supported) return null;

  const normalizeAndSetSize = (value: number | null) => {
    if (typeof value !== "number" || Number.isNaN(value)) return;
    const normalized = normalizeSharedDiskSize({
      provider,
      size: value,
    });
    setFields({ shared_disk_gb: normalized });
  };

  return (
    <div
      style={{
        background: COLORS.GRAY_LLL,
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 10,
        marginBottom: 8,
        padding: "8px 10px",
      }}
    >
      <Space orientation="vertical" style={{ width: "100%" }} size={8}>
        <Space style={{ justifyContent: "space-between", width: "100%" }}>
          <div>
            <Typography.Text strong>Shared scratch disk</Typography.Text>
            <Typography.Text
              type="secondary"
              style={{ display: "block", fontSize: 12 }}
            >
              Mounts a host-local shared filesystem at <code>/scratch</code> in
              projects on this host.
            </Typography.Text>
          </div>
          <Switch
            checked={enabled}
            disabled={disabled || currentSize > 0}
            onChange={(checked) => {
              setScratchEnabled(checked);
              if (checked) {
                setFields({
                  shared_disk_gb: Math.max(minSize, defaultSharedDiskGb),
                  shared_disk_type: defaultDiskType,
                });
              } else {
                setFields({
                  shared_disk_gb: undefined,
                  shared_disk_type: undefined,
                });
              }
            }}
          />
        </Space>
        {enabled && (
          <>
            <Row gutter={10}>
              <Col xs={24} md={12}>
                <Form.Item
                  name="shared_disk_gb"
                  label="Scratch size (GB)"
                  extra={
                    currentSizeGb
                      ? `Current minimum: ${minSize.toLocaleString()} GB (grow only)`
                      : undefined
                  }
                  rules={[
                    {
                      validator(_, value) {
                        const parsed = Number(value);
                        if (!Number.isFinite(parsed) || parsed < minSize) {
                          return Promise.reject(
                            new Error(
                              `Enter at least ${minSize.toLocaleString()} GB`,
                            ),
                          );
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <InputNumber
                    min={minSize}
                    max={10000}
                    step={step}
                    precision={0}
                    style={{ width: "100%" }}
                    disabled={disabled}
                    onChange={normalizeAndSetSize}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  name="shared_disk_type"
                  label="Scratch disk type"
                  extra={
                    currentSizeGb
                      ? "Changing disk type requires deleting and recreating scratch."
                      : undefined
                  }
                >
                  <Select
                    options={diskTypeOptions}
                    disabled={disabled || Number(currentSizeGb ?? 0) > 0}
                  />
                </Form.Item>
              </Col>
            </Row>
            <Alert
              type="warning"
              showIcon
              message="Not backed up by CoCalc"
              description={
                <>
                  Data in <code>/scratch</code> is shared by projects on this
                  host and does not move with projects or count toward project
                  quota. It is provider network block storage, not local SSD.
                  Projects must be restarted before they see newly added
                  scratch.
                  {provider === "nebius"
                    ? " Nebius scratch disks are sized in 93 GB increments."
                    : ""}
                </>
              }
            />
            {allowDelete && onDelete && Number(currentSizeGb ?? 0) > 0 && (
              <div>
                <Button danger loading={deleting} onClick={onDelete}>
                  Delete shared scratch disk
                </Button>
              </div>
            )}
          </>
        )}
      </Space>
    </div>
  );
};
