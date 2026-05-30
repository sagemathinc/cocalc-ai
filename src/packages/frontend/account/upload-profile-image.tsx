// Upload user avatar image

// similar to code in next/components/account/config/account/avatar.tsx

import {
  type CSSProperties,
  type DragEvent,
  useState,
  type ReactNode,
} from "react";
import { Alert, Button, Upload } from "antd";
import ImgCrop from "antd-img-crop";
import imageToDataURL from "@cocalc/frontend/misc/image-to-data";
import { Tooltip } from "@cocalc/frontend/components";

// This is what facebook uses, and it makes
// 40x40 look very good.  It takes about 20KB
// per image.

const AVATAR_SIZE: number = 160;

interface Props {
  children?: ReactNode;
  dropTarget?: boolean;
  onChange: (data: string) => void;
  tooltip?: ReactNode;
}

export default function UploadProfileImage({
  children,
  dropTarget,
  onChange,
  tooltip = "Upload and crop an image.",
}: Props) {
  const [error, setError] = useState<string>("");
  const button = <Button type="primary">{children ?? "Upload"}</Button>;
  const trigger = dropTarget ? children : button;
  const uploadProps = {
    name: "file",
    showUploadList: false,
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
    },
  };
  const draggerStyle: CSSProperties = {
    background: "transparent",
    border: 0,
    padding: 0,
  };
  const upload = dropTarget ? (
    <Upload.Dragger {...uploadProps} style={draggerStyle}>
      {trigger}
    </Upload.Dragger>
  ) : (
    <Upload {...uploadProps}>{trigger}</Upload>
  );
  const croppedUpload = (
    <ImgCrop
      modalTitle={"Edit Profile Image"}
      cropShape="round"
      rotationSlider
      maxZoom={5}
      onModalOk={(file) => {
        const reader = new FileReader();
        reader.addEventListener(
          "load",
          async (e) => {
            if (!e.target?.result) return; // typescript
            const src = e.target.result as string;
            onChange(
              await imageToDataURL(src, AVATAR_SIZE, AVATAR_SIZE, "image/png"),
            );
          },
          false,
        );
        if (typeof file != "object") {
          setError(
            "WARNING: unable to read, since avatar is assumed to be a Blob",
          );
          return;
        }
        reader.readAsDataURL(file as any);
      }}
    >
      {upload}
    </ImgCrop>
  );

  return (
    <div style={dropTarget ? { display: "inline-block" } : undefined}>
      {tooltip ? (
        <Tooltip title={tooltip}>
          <span style={dropTarget ? { display: "inline-block" } : undefined}>
            {croppedUpload}
          </span>
        </Tooltip>
      ) : (
        croppedUpload
      )}
      {error && (
        <Alert
          style={{ marginTop: "15px" }}
          type="error"
          title={error}
          showIcon
        />
      )}
    </div>
  );
}
