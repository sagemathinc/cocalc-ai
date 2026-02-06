import { Button, Modal, Space, Tooltip, Typography } from "antd";
import { React, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";

const BUTTON_STYLE: React.CSSProperties = {
  margin: "2.5px 0 0 6px",
  maxWidth: "240px",
  display: "inline-flex",
  alignItems: "center",
} as const;

const LABEL_STYLE: React.CSSProperties = {
  marginLeft: "6px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "180px",
} as const;

export default function RemoteSshButton() {
  const target = useTypedRedux("customize", "ssh_remote_target") ?? "";
  const localUrl =
    useTypedRedux("customize", "ssh_remote_url") ?? "";
  const [open, setOpen] = React.useState(false);

  if (!target) return null;

  const url =
    typeof window !== "undefined" ? window.location.href : undefined;
  const localUrlFromReferrer =
    typeof document !== "undefined" && document.referrer
      ? document.referrer
      : undefined;
  const localUrlFromName =
    typeof window !== "undefined" && window.name?.startsWith("cocalc|")
      ? window.name.slice("cocalc|".length)
      : undefined;
  const effectiveLocalUrl =
    localUrlFromReferrer || localUrlFromName || localUrl || undefined;

  return (
    <>
      <Tooltip title={`Remote session: ${target}`}>
        <Button type="text" style={BUTTON_STYLE} onClick={() => setOpen(true)}>
          <Icon name="server" />
          <span style={LABEL_STYLE}>{`Remote: ${target}`}</span>
        </Button>
      </Tooltip>
      <Modal
        title="Remote SSH Session"
        open={open}
        onCancel={() => setOpen(false)}
        footer={[
          <Button key="close" onClick={() => setOpen(false)}>
            Close
          </Button>,
        ]}
      >
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Paragraph>
            You are viewing a remote session started via{" "}
            <Typography.Text code>cocalc-plus ssh</Typography.Text>. Managing
            SSH sessions is disabled in this remote instance to avoid
            double-hop confusion.
          </Typography.Paragraph>
          <Typography.Paragraph>
            Target:{" "}
            <Typography.Text code copyable={{ text: target }}>
              {target}
            </Typography.Text>
          </Typography.Paragraph>
          {effectiveLocalUrl && (
            <>
              <Typography.Paragraph>
                Local session URL:{" "}
                <Typography.Text
                  code
                  copyable={{ text: effectiveLocalUrl }}
                >
                  {effectiveLocalUrl}
                </Typography.Text>
              </Typography.Paragraph>
              <Button
                onClick={() => {
                  window.open(effectiveLocalUrl, "_blank", "noopener");
                }}
              >
                Open local session
              </Button>
            </>
          )}
          {url && (
            <>
              <Typography.Paragraph>
                Current session URL:{" "}
                <Typography.Text code copyable={{ text: url }}>
                  {url}
                </Typography.Text>
              </Typography.Paragraph>
              <Button
                onClick={() => {
                  window.open(url, "_blank", "noopener");
                }}
              >
                Open in new tab
              </Button>
            </>
          )}
        </Space>
      </Modal>
    </>
  );
}
