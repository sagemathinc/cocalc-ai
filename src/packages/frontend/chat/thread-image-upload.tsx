import { Alert, Upload } from "antd";
import ImgCrop from "antd-img-crop";
import { InboxOutlined } from "@ant-design/icons";
import { React, useState } from "@cocalc/frontend/app-framework";
import { BASE_URL } from "@cocalc/frontend/misc";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { join } from "path";

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
              style={{ width: `${size}px`, height: `${size}px`, objectFit: "cover" }}
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
      {error ? (
        <Alert
          style={{ marginTop: "10px" }}
          type="error"
          showIcon
          message={error}
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
    const blob = file as Blob;
    const filename =
      typeof (file as any).name === "string" && (file as any).name.trim()
        ? (file as any).name.trim()
        : "chat-image.png";
    const formData = new FormData();
    formData.append("file", blob, filename);
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
    if (!uuid) {
      throw Error("missing upload uuid");
    }
    const url = `${BASE_URL}/blobs/${encodeURIComponent(filename)}?uuid=${uuid}`;
    onChange(url);
  } catch (err) {
    setError(`Image upload failed: ${err}`);
  } finally {
    setUploading(false);
  }
}
