import { Button } from "antd";
import { RelativeTimeText } from "@cocalc/frontend/components/time-ago";

export default function VmShutdownButton({
  name,
  stopAt,
  onClick,
}: {
  name: string;
  stopAt: string | Date;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={`Auto Shutdown: change shutdown timer for ${name}`}
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        height: "auto",
        padding: "6px 8px",
        textAlign: "left",
        whiteSpace: "normal",
      }}
    >
      <span style={{ display: "block", fontWeight: 600 }}>Auto Shutdown</span>
      <span style={{ display: "block" }}>
        <RelativeTimeText date={new Date(stopAt)} live />
      </span>
    </Button>
  );
}
