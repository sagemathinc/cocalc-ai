import { InboxOutlined } from "@ant-design/icons";
import { Alert, Button, Space, Typography, Upload } from "antd";
import ImgCrop from "antd-img-crop";
import { useMemo, useState } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { pastedBlobFilename } from "@cocalc/frontend/editors/slate/upload-utils";
import type { ThemeImageChoice } from "@cocalc/frontend/theme/types";
import { join } from "path";

export function blobImageUrl(
  blob: string | undefined | null,
  filename = "theme-image.png",
) {
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

function pickPastedImage(
  event: React.ClipboardEvent<HTMLDivElement>,
): Blob | undefined {
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (!item.type?.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
}

interface ThemeImageInputProps {
  projectId?: string;
  value?: string | null;
  onChange: (blob: string) => void;
  recentImageChoices?: ThemeImageChoice[];
  label?: string;
  modalTitle?: string;
  uploadText?: string;
  size?: number;
}

export function ThemeImageInput({
  projectId,
  value,
  onChange,
  recentImageChoices = [],
  label = "Image",
  modalTitle = "Edit Theme Image",
  uploadText = "Click or drag image",
  size = 72,
}: ThemeImageInputProps): React.JSX.Element {
  const [error, setError] = useState<string>("");
  const [uploading, setUploading] = useState<boolean>(false);
  const [pasteFocused, setPasteFocused] = useState<boolean>(false);

  const imageUrl = useMemo(() => blobImageUrl(value), [value]);
  const uniqueImages = useMemo(() => {
    const seen = new Set<string>();
    return recentImageChoices.filter(({ blob }) => {
      const trimmed = blob.trim();
      if (!trimmed || seen.has(trimmed)) return false;
      seen.add(trimmed);
      return true;
    });
  }, [recentImageChoices]);

  async function handleBlob(file: Blob & { name?: string }) {
    if (!projectId) {
      setError("Unable to upload an image without a project id.");
      return;
    }
    try {
      setUploading(true);
      setError("");
      const blob = await uploadThemeImageBlob(file, projectId);
      onChange(blob);
    } catch (err) {
      setError(`Image upload failed: ${err}`);
    } finally {
      setUploading(false);
    }
  }

  async function handlePastedImage(
    event: React.ClipboardEvent<HTMLDivElement>,
  ) {
    const file = pickPastedImage(event);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    await handleBlob(file);
  }

  return (
    <div>
      <Space
        align="center"
        style={{
          width: "100%",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <Typography.Text strong>{label}</Typography.Text>
        <Button
          size="small"
          disabled={!value?.trim()}
          onClick={() => onChange("")}
        >
          Clear image
        </Button>
      </Space>
      <ImgCrop
        modalTitle={modalTitle}
        cropShape="rect"
        rotationSlider
        maxZoom={5}
        onModalOk={(file) => {
          if (typeof file === "object" && file != null) {
            void handleBlob(file as Blob & { name?: string });
          } else {
            setError("Unable to read selected image.");
          }
        }}
      >
        <Upload.Dragger
          name="file"
          showUploadList={false}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt="Theme image preview"
              style={{
                width: size,
                height: size,
                objectFit: "cover",
                borderRadius: 12,
              }}
            />
          ) : (
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
          )}
          <p className="ant-upload-text">
            {uploading ? "Uploading..." : uploadText}
          </p>
          <p className="ant-upload-hint">
            Crop after upload. Paste below to use a screenshot from the
            clipboard.
          </p>
        </Upload.Dragger>
      </ImgCrop>
      <div
        tabIndex={0}
        onPaste={(event) => void handlePastedImage(event)}
        onFocus={() => setPasteFocused(true)}
        onBlur={() => setPasteFocused(false)}
        style={{
          marginTop: 8,
          border: `1px dashed ${pasteFocused ? "#1677ff" : "#bfbfbf"}`,
          borderRadius: 10,
          padding: "10px 12px",
          color: pasteFocused ? "#1677ff" : "#666",
          outline: "none",
          background: pasteFocused ? "#f0f7ff" : "#fafafa",
          boxShadow: pasteFocused ? "0 0 0 2px rgba(22,119,255,0.15)" : "none",
        }}
      >
        {pasteFocused
          ? "Paste mode enabled. Press Ctrl/Cmd+V to paste an image."
          : "Click here, then paste an image from the clipboard."}
      </div>
      {error ? (
        <Alert type="error" showIcon style={{ marginTop: 8 }} message={error} />
      ) : null}
      {uniqueImages.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <Typography.Text
            type="secondary"
            style={{ display: "block", marginBottom: 8 }}
          >
            Reuse an existing theme image
          </Typography.Text>
          <Space wrap size={[8, 8]}>
            {uniqueImages.map((choice) => {
              const url = blobImageUrl(choice.blob);
              const selected = value?.trim() === choice.blob;
              return (
                <button
                  key={choice.blob}
                  type="button"
                  onClick={() => onChange(choice.blob)}
                  style={{
                    border: selected
                      ? "2px solid #1677ff"
                      : "1px solid #d9d9d9",
                    borderRadius: 10,
                    padding: 4,
                    background: "#fff",
                    cursor: "pointer",
                  }}
                  title={choice.label ?? "Theme image"}
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
  );
}
