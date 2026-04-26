import { Alert } from "antd";
import { CSSProperties } from "react";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";

interface Props {
  error: any;
  setError?: (error: any) => void;
  style?: CSSProperties;
  message?;
  banner?;
  noMarkdown?: boolean;
}
export default function ShowError({
  message = "Error",
  error,
  setError,
  style,
  banner,
  noMarkdown,
}: Props) {
  if (!error) return null;
  const err = normalizeUserFacingError(
    `${error}`.replace(/Error:/g, "").trim(),
  );
  return (
    <Alert
      banner={banner}
      style={style}
      showIcon
      title={message}
      type="error"
      description={
        <div style={{ maxHeight: "150px", overflow: "auto", textWrap: "wrap" }}>
          {noMarkdown ? err : <StaticMarkdown value={err} />}
        </div>
      }
      onClose={() => setError?.("")}
      closable={setError != null}
    />
  );
}

function normalizeUserFacingError(error: string): string {
  const normalized = error.trim();
  if (
    normalized.includes("openat2 is required in safe mode") &&
    normalized.includes("native addon initialization failed")
  ) {
    return "Project filesystem is not available right now. If this project is archived, start it to restore it from backup. If it is stopped, start it to make the filesystem available again.";
  }
  return normalized;
}
