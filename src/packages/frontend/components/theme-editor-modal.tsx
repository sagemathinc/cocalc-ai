import { Alert, Button, Input, Modal, Space, Tag, Typography } from "antd";
import { useMemo } from "react";
import { Icon } from "./icon";
import type { IconName } from "./icon";
import { ColorButton } from "./color-picker";
import { IconPickerInput } from "./icon-picker-input";
import { ThemeImageInput, blobImageUrl } from "./theme-image-input";
import type {
  ThemeEditorDraft,
  ThemeImageChoice,
} from "@cocalc/frontend/theme/types";

interface ThemeEditorModalProps {
  open: boolean;
  title: string;
  value: ThemeEditorDraft | null;
  onChange: (patch: Partial<ThemeEditorDraft>) => void;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
  confirmLoading?: boolean;
  error?: string;
  projectId?: string;
  defaultIcon?: IconName;
  extraBeforeTheme?: React.ReactNode;
  extraAfterTheme?: React.ReactNode;
  recentImageChoices?: ThemeImageChoice[];
  showIcon?: boolean;
  showDescription?: boolean;
  showAccentColor?: boolean;
  previewImageUrl?: string;
  renderImageInput?: (args: {
    projectId?: string;
    value: ThemeEditorDraft | null;
    onChange: (patch: Partial<ThemeEditorDraft>) => void;
    recentImageChoices: ThemeImageChoice[];
  }) => React.ReactNode;
}

export function ThemeEditorModal({
  open,
  title,
  value,
  onChange,
  onCancel,
  onSave,
  confirmLoading = false,
  error,
  projectId,
  defaultIcon = "file",
  extraBeforeTheme,
  extraAfterTheme,
  recentImageChoices = [],
  showIcon = true,
  showDescription = true,
  showAccentColor = true,
  previewImageUrl,
  renderImageInput,
}: ThemeEditorModalProps): React.JSX.Element {
  const imageUrl = useMemo(
    () => previewImageUrl ?? blobImageUrl(value?.image_blob),
    [previewImageUrl, value?.image_blob],
  );
  const iconName = useMemo(
    () => (value?.icon?.trim() || defaultIcon) as IconName,
    [defaultIcon, value?.icon],
  );
  const uniqueImages = useMemo(() => {
    const seen = new Set<string>();
    return recentImageChoices.filter(({ blob }) => {
      const trimmed = blob.trim();
      if (!trimmed || seen.has(trimmed)) return false;
      seen.add(trimmed);
      return true;
    });
  }, [recentImageChoices]);

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onCancel}
      onOk={() => void onSave()}
      confirmLoading={confirmLoading}
      destroyOnHidden
      width={680}
    >
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {extraBeforeTheme}
        <div
          style={{
            border: `1px solid ${value?.color ?? "#d9d9d9"}`,
            borderRadius: 12,
            padding: 12,
            background:
              value?.accent_color != null
                ? `${value.accent_color}22`
                : "rgba(0, 0, 0, 0.02)",
          }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            {imageUrl ? (
              <img
                src={imageUrl}
                alt="Theme preview"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 12,
                  objectFit: "cover",
                  flex: "0 0 auto",
                }}
              />
            ) : (
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: value?.accent_color ?? "#f5f5f5",
                  color: value?.color ?? undefined,
                  flex: "0 0 auto",
                }}
              >
                <Icon name={iconName} style={{ fontSize: "26px" }} />
              </div>
            )}
            <div style={{ minWidth: 0, flex: 1 }}>
              <Typography.Text strong>
                {value?.title?.trim() || "Untitled"}
              </Typography.Text>
              {showDescription ? (
                <div>
                  <Typography.Text type="secondary">
                    {value?.description?.trim() || "No description"}
                  </Typography.Text>
                </div>
              ) : null}
              <Space size={6} wrap style={{ marginTop: 8 }}>
                {value?.color ? <Tag color={value.color}>Primary</Tag> : null}
                {value?.accent_color ? (
                  <Tag color={value.accent_color}>Accent</Tag>
                ) : null}
                {value?.image_blob?.trim() ? <Tag>Image</Tag> : null}
                <Tag icon={<Icon name={iconName} />}>{iconName}</Tag>
              </Space>
            </div>
          </div>
        </div>
        <div>
          <Typography.Text strong>Title</Typography.Text>
          <Input
            value={value?.title ?? ""}
            onChange={(e) => onChange({ title: e.target.value })}
          />
        </div>
        {showDescription ? (
          <div>
            <Typography.Text strong>Description</Typography.Text>
            <Input.TextArea
              autoSize={{ minRows: 1, maxRows: 4 }}
              value={value?.description ?? ""}
              onChange={(e) => onChange({ description: e.target.value })}
            />
          </div>
        ) : null}
        <div>
          <div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${(showIcon ? 1 : 0) + 1 + (showAccentColor ? 1 : 0)}, minmax(0, 1fr))`,
                gap: 12,
                alignItems: "start",
              }}
            >
              {showIcon ? (
                <div style={{ minWidth: 0 }}>
                  <Typography.Text strong>Icon</Typography.Text>
                  <div style={{ marginTop: 8 }}>
                    <IconPickerInput
                      value={value?.icon ?? ""}
                      onChange={(icon) => onChange({ icon: icon ?? "" })}
                      modalTitle="Select Theme Icon"
                      placeholder="Select an icon"
                    />
                  </div>
                </div>
              ) : null}
              <div style={{ minWidth: 0, margin: "0 auto" }}>
                <Typography.Text strong>Color</Typography.Text>
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    minHeight: 32,
                  }}
                >
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      background: value?.color ?? "#f5f5f5",
                      border: "1px solid #d9d9d9",
                    }}
                  />
                  <ColorButton
                    onChange={(color) => onChange({ color })}
                    title="Select theme color"
                  />
                  {value?.color ? (
                    <Button
                      size="small"
                      onClick={() => onChange({ color: null })}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
              </div>
              {showAccentColor ? (
                <div style={{ minWidth: 0 }}>
                  <Typography.Text strong>Accent color</Typography.Text>
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minHeight: 32,
                    }}
                  >
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: value?.accent_color ?? "#f5f5f5",
                        border: "1px solid #d9d9d9",
                      }}
                    />
                    <ColorButton
                      onChange={(color) => onChange({ accent_color: color })}
                      title="Select accent color"
                    />
                    {value?.accent_color ? (
                      <Button
                        size="small"
                        onClick={() => onChange({ accent_color: null })}
                      >
                        Clear
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {renderImageInput ? (
          renderImageInput({
            projectId,
            value,
            onChange,
            recentImageChoices: uniqueImages,
          })
        ) : (
          <ThemeImageInput
            projectId={projectId}
            value={value?.image_blob}
            onChange={(image_blob) => onChange({ image_blob })}
            recentImageChoices={uniqueImages}
            modalTitle="Edit Theme Image"
            uploadText="Click or drag theme image"
          />
        )}
        {extraAfterTheme}
      </Space>
    </Modal>
  );
}
