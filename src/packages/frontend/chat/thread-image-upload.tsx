import { Alert, Upload } from "antd";
import ImgCrop from "antd-img-crop";
import { InboxOutlined } from "@ant-design/icons";
import { React, useState } from "@cocalc/frontend/app-framework";
import { uploadBlobImage } from "@cocalc/frontend/blobs/upload-image";

interface ThreadImageUploadProps {
  projectId?: string;
  value?: string;
  onChange: (value: string) => void;
  modalTitle: string;
  uploadText?: string;
  size?: number;
}

export function ThreadImageUpload({
  projectId,
  value,
  onChange,
  modalTitle,
  uploadText = "Click or drag image",
  size = 84,
}: ThreadImageUploadProps): React.JSX.Element {
  const [error, setError] = useState<string>("");
  const [uploading, setUploading] = useState<boolean>(false);
  const [pasteFocused, setPasteFocused] = useState<boolean>(false);

  async function handlePastedImage(
    event: React.ClipboardEvent<HTMLDivElement>,
  ) {
    for (const item of Array.from(event.clipboardData?.items ?? [])) {
      if (!item.type?.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      event.stopPropagation();
      await uploadCroppedImage({
        file,
        projectId,
        onChange,
        setError,
        setUploading,
      });
      return;
    }
  }

  return (
    <div>
      <ImgCrop
        modalTitle={modalTitle}
        cropShape="rect"
        rotationSlider
        maxZoom={5}
        onModalOk={(file) => {
          void uploadCroppedImage({
            file,
            projectId,
            onChange,
            setError,
            setUploading,
          });
        }}
      >
        <Upload.Dragger
          beforeUpload={() => false}
          name="file"
          showUploadList={false}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {value ? (
            <img
              src={value}
              alt="Chat image preview"
              style={{
                width: `${size}px`,
                height: `${size}px`,
                objectFit: "cover",
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
        <Alert
          style={{ marginTop: "10px" }}
          type="error"
          showIcon
          title={error}
        />
      ) : null}
    </div>
  );
}

async function uploadCroppedImage({
  file,
  projectId,
  onChange,
  setError,
  setUploading,
}: {
  file: unknown;
  projectId?: string;
  onChange: (value: string) => void;
  setError: (value: string) => void;
  setUploading: (value: boolean) => void;
}): Promise<void> {
  if (typeof file !== "object" || file == null) {
    setError("Unable to read selected image.");
    return;
  }
  setUploading(true);
  setError("");
  try {
    const blob =
      (file as any).originFileObj instanceof Blob
        ? ((file as any).originFileObj as Blob)
        : file instanceof Blob
          ? file
          : undefined;
    if (blob == null) {
      throw Error("unable to resolve image data");
    }
    const { url } = await uploadBlobImage({
      file: blob,
      filename:
        typeof (file as any).name === "string" ? (file as any).name : undefined,
      projectId,
    });
    onChange(url);
  } catch (err) {
    setError(`Image upload failed: ${err}`);
  } finally {
    setUploading(false);
  }
}
