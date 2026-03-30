import { Alert, Button, Modal, Space, Typography } from "antd";
import { Loading } from "@cocalc/frontend/components";
import StaticCodeBlock from "@cocalc/frontend/components/static-code-block";
import { filename_extension } from "@cocalc/util/misc";

export default function FindRestoreModal({
  open,
  title,
  path,
  openLabel,
  loading,
  error,
  onRestoreOriginal,
  onRestoreScratch,
  onOpenDirectory,
  onCancel,
  preview,
}: {
  open: boolean;
  title: string;
  path: string;
  openLabel: string;
  loading: boolean;
  error?: string | null;
  preview?: {
    loading?: boolean;
    error?: string | null;
    content?: string;
    truncated?: boolean;
  };
  onRestoreOriginal: () => void;
  onRestoreScratch: () => void;
  onOpenDirectory: () => void;
  onCancel: () => void;
}) {
  const ext = filename_extension(path).toLowerCase();
  return (
    <Modal
      title={title}
      open={open}
      width={900}
      style={{ maxWidth: "90vw" }}
      onCancel={onCancel}
      footer={null}
      destroyOnHidden
    >
      <Space orientation="vertical" style={{ width: "100%" }} size="middle">
        <div>
          <div style={{ marginBottom: "4px", color: "#666" }}>
            Selected path
          </div>
          <Typography.Text code>{path}</Typography.Text>
        </div>
        {error ? <Alert type="error" title={error} /> : null}
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Button
            type="primary"
            block
            loading={loading}
            onClick={onRestoreOriginal}
          >
            Restore to original path (overwrite)
          </Button>
          <Button block loading={loading} onClick={onRestoreScratch}>
            Restore to /scratch/&lt;path&gt;
          </Button>
          <Button block onClick={onOpenDirectory} disabled={loading}>
            {openLabel}
          </Button>
        </Space>
        {preview ? (
          <div>
            <div style={{ marginBottom: "6px", color: "#666" }}>Preview</div>
            {preview.error ? (
              <Alert type="warning" title={preview.error} />
            ) : preview.loading ? (
              <Loading />
            ) : preview.content != null ? (
              <div
                style={{
                  border: "1px solid #e5e5e5",
                  borderRadius: "6px",
                  padding: "8px",
                  maxHeight: "60vh",
                  overflow: "auto",
                  background: "#fff",
                }}
              >
                <StaticCodeBlock
                  value={preview.content}
                  info={ext}
                  borderless
                  noWrap
                />
                {preview.truncated ? (
                  <Alert
                    style={{ marginTop: "8px" }}
                    type="info"
                    title="Preview truncated to 10MB."
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </Space>
    </Modal>
  );
}
