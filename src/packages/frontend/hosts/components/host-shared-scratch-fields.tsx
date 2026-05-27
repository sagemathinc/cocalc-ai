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
import type { HostCatalog } from "@cocalc/conat/hub/api/hosts";
import { MIN_PROJECT_HOST_DISK_GB } from "@cocalc/util/project-host-limits";
import { COLORS } from "@cocalc/util/theme";

const DEFAULT_SHARED_DISK_GB = 500;
const NEBIUS_IO_M3_GB = 93;

const DURABILITY_LABELS = {
  "single-copy": "single copy",
  replicated: "replicated",
  "highly-replicated": "highly replicated",
} as const;

const normalizeSharedDiskSize = ({
  provider,
  diskType,
  size,
}: {
  provider?: HostProvider;
  diskType?: string;
  size: number;
}) => {
  const min = MIN_PROJECT_HOST_DISK_GB;
  const next = Math.max(min, Math.floor(size));
  if (provider === "nebius" && diskType === "ssd_io_m3") {
    return Math.ceil(next / NEBIUS_IO_M3_GB) * NEBIUS_IO_M3_GB;
  }
  return next;
};

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
}) => {
  const form = Form.useFormInstance();
  const cap = provider
    ? catalog?.provider_capabilities?.[provider]?.sharedScratchDisk
    : undefined;
  const supported = !!cap?.supported;
  const watchedSize = Form.useWatch("shared_disk_gb", form);
  const watchedType = Form.useWatch("shared_disk_type", form);
  const enabled =
    typeof watchedSize === "number" && Number.isFinite(watchedSize)
      ? watchedSize > 0
      : Number(currentSizeGb ?? 0) > 0;
  const diskTypes = cap?.disk_types ?? [];
  const defaultDiskType =
    diskTypes.find((entry) => entry.default)?.value ?? diskTypes[0]?.value;
  const diskTypeOptions = diskTypes.map((entry) => ({
    value: entry.value,
    label: `${entry.label} (${DURABILITY_LABELS[entry.durability]})`,
  }));
  const selectedDiskType = watchedType ?? defaultDiskType;
  const step =
    provider === "nebius" && selectedDiskType === "ssd_io_m3"
      ? NEBIUS_IO_M3_GB
      : 1;
  const minSize = Math.max(
    MIN_PROJECT_HOST_DISK_GB,
    Number(currentSizeGb ?? 0) || 0,
  );

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
      if (watchedSize != null || watchedType != null) {
        setFields({
          shared_disk_gb: undefined,
          shared_disk_type: undefined,
        });
      }
      return;
    }
    if (enabled && !watchedType && defaultDiskType) {
      setFields({ shared_disk_type: defaultDiskType });
    }
  }, [
    defaultDiskType,
    enabled,
    setFields,
    supported,
    watchedSize,
    watchedType,
  ]);

  if (!supported) return null;

  const normalizeAndSetSize = (value: number | null) => {
    if (typeof value !== "number" || Number.isNaN(value)) return;
    const normalized = normalizeSharedDiskSize({
      provider,
      diskType: selectedDiskType,
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
      <Space direction="vertical" style={{ width: "100%" }} size={8}>
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
            disabled={disabled || Number(currentSizeGb ?? 0) > 0}
            onChange={(checked) => {
              if (checked) {
                setFields({
                  shared_disk_gb: Math.max(
                    minSize,
                    normalizeSharedDiskSize({
                      provider,
                      diskType: defaultDiskType,
                      size: DEFAULT_SHARED_DISK_GB,
                    }),
                  ),
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
