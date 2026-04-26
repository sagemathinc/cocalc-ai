import { Button, Popover } from "antd";
import { React } from "@cocalc/frontend/app-framework";

type HostErrorDetailsProps = {
  message: string;
  title?: React.ReactNode;
  buttonLabel?: React.ReactNode;
  variant?: "popover" | "inline";
  maxHeight?: number;
};

const contentStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  fontFamily:
    'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 12,
  lineHeight: 1.4,
};

function ErrorContent({
  message,
  maxHeight = 320,
}: {
  message: string;
  maxHeight?: number;
}) {
  return (
    <div
      style={{
        width: "min(80vw, 560px)",
        maxHeight,
        overflow: "auto",
        paddingRight: 8,
      }}
    >
      <div style={contentStyle}>{message}</div>
    </div>
  );
}

export const HostErrorDetails: React.FC<HostErrorDetailsProps> = ({
  message,
  title = "Error details",
  buttonLabel = "Details",
  variant = "inline",
  maxHeight,
}) => {
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (variant === "popover") {
    return (
      <Popover
        trigger="click"
        title={title}
        content={<ErrorContent message={trimmed} maxHeight={maxHeight} />}
      >
        <Button
          size="small"
          type="link"
          style={{ padding: 0, height: "auto", lineHeight: 1.2 }}
        >
          {buttonLabel}
        </Button>
      </Popover>
    );
  }
  return (
    <div
      style={{ marginBottom: 0, maxHeight, overflow: "auto", paddingRight: 8 }}
    >
      <div style={contentStyle}>{trimmed}</div>
    </div>
  );
};
