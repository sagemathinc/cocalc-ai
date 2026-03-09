import { Alert, Button, Input, Modal, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { pastedBlobFilename } from "@cocalc/frontend/editors/slate/upload-utils";
import { ColorPicker } from "@cocalc/frontend/colorpicker";
import { Icon } from "./icon";
import type { IconName } from "./icon";
import { IconPickerInput } from "./icon-picker-input";
import type { ThemeEditorDraft, ThemeImageChoice } from "@cocalc/frontend/theme/types";
import { join } from "path";

function blobImageUrl(blob: string | undefined | null, filename = "theme-image.png") {
  const trimmed = `${blob ?? ""}`.trim();
  if (!trimmed) return undefined;
  return `${join(appBasePath, "blobs", encodeURIComponent(filename))}?uuid=${encodeURIComponent(trimmed)}`;
}

async function uploadThemeImageBlob(
  file: Blob & { name?: string },
  projectId?: string,
): Promise<string> {
  const filename =
    typeof file.name === "string" && file.name.trim()
      ? file.name.trim()
      : pastedBlobFilename(file.type);
  const formData = new FormData();
  formData.append("file", file, filename);
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  const response = await fetch(`${join(appBasePath, "blobs")}${query}`, {
    method: "POST",
    body: formData,
    credentials: "include",
  });
  if (!response.ok) {
    const message = await response.text();
    throw Error(message || `HTTP ${response.status}`);
  }
  const { uuid } = await response.json();
  if (!uuid) throw Error("missing upload uuid");
  return uuid;
}

function pickPastedImage(event: React.ClipboardEvent<HTMLDivElement>): Blob | undefined {
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (!item.type?.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
}

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
}: ThemeEditorModalProps): React.JSX.Element {
  const [imageError, setImageError] = useState<string>("");
  const imageUrl = useMemo(
    () => blobImageUrl(value?.image_blob),
    [value?.image_blob],
  );
  const iconName = useMemo(
    () => ((value?.icon?.trim() || defaultIcon) as IconName),
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

  async function handlePastedImage(event: React.ClipboardEvent<HTMLDivElement>) {
    const file = pickPastedImage(event);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    if (!projectId) {
      setImageError("Unable to upload an image without a project id.");
      return;
    }
    try {
      setImageError("");
      const blob = await uploadThemeImageBlob(file, projectId);
      onChange({ image_blob: blob });
    } catch (err) {
      setImageError(`Image upload failed: ${err}`);
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onCancel}
      onOk={() => void onSave()}
      confirmLoading={confirmLoading}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        {error ? <Alert type="error" showIcon message={error} /> : null}
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
              <div>
                <Typography.Text type="secondary">
                  {value?.description?.trim() || "No description"}
                </Typography.Text>
              </div>
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
        <div>
          <Typography.Text strong>Description</Typography.Text>
          <Input.TextArea
            rows={3}
            value={value?.description ?? ""}
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </div>
        <div>
          <Typography.Text strong>Icon</Typography.Text>
          <IconPickerInput
            value={value?.icon ?? ""}
            onChange={(icon) => onChange({ icon: icon ?? "" })}
            modalTitle="Select Theme Icon"
            placeholder="Select an icon"
          />
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <Typography.Text strong>Color</Typography.Text>
            <ColorPicker
              color={value?.color ?? undefined}
              onChange={(color) => onChange({ color })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <Typography.Text strong>Accent color</Typography.Text>
            <ColorPicker
              color={value?.accent_color ?? undefined}
              onChange={(color) => onChange({ accent_color: color })}
            />
          </div>
        </div>
        <div>
          <Space
            align="center"
            style={{ width: "100%", justifyContent: "space-between" }}
          >
            <Typography.Text strong>Image</Typography.Text>
            <Button
              size="small"
              disabled={!value?.image_blob?.trim()}
              onClick={() => onChange({ image_blob: "" })}
            >
              Clear image
            </Button>
          </Space>
          <div
            tabIndex={0}
            onPaste={(event) => void handlePastedImage(event)}
            style={{
              marginTop: 8,
              border: "1px dashed #bfbfbf",
              borderRadius: 10,
              padding: "14px 12px",
              color: "#666",
              outline: "none",
              background: "#fafafa",
            }}
          >
            Click here, then paste an image from the clipboard.
          </div>
          {imageError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 8 }}
              message={imageError}
            />
          ) : null}
          <Input
            style={{ marginTop: 8 }}
            placeholder="optional blob hash"
            value={value?.image_blob ?? ""}
            onChange={(e) => onChange({ image_blob: e.target.value })}
          />
          {uniqueImages.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="secondary">
                Reuse an existing theme image
              </Typography.Text>
              <Space wrap size={[8, 8]} style={{ marginTop: 8 }}>
                {uniqueImages.map((choice) => {
                  const url = blobImageUrl(choice.blob);
                  const selected = value?.image_blob?.trim() === choice.blob;
                  return (
                    <button
                      key={choice.blob}
                      type="button"
                      onClick={() => onChange({ image_blob: choice.blob })}
                      style={{
                        border: selected
                          ? `2px solid ${value?.color ?? "#1677ff"}`
                          : "1px solid #d9d9d9",
                        borderRadius: 10,
                        padding: 4,
                        background: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      {url ? (
                        <img
                          src={url}
                          alt={choice.label ?? "Theme image"}
                          style={{
                            width: 52,
                            height: 52,
                            objectFit: "cover",
                            display: "block",
                            borderRadius: 8,
                          }}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </Space>
            </div>
          ) : null}
        </div>
        {extraAfterTheme}
      </Space>
    </Modal>
  );
}
