import { Button, Modal, Space, Tag } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useHostAvailability } from "../hooks/use-host-availability";
import { HostAvailabilityPanel } from "./host-availability-panel";

type Props = {
  host: Pick<Host, "id" | "name">;
  size?: "small" | "middle" | "large";
  type?: "default" | "link" | "text";
  compact?: boolean;
};

function formatDuration(ms?: number): string {
  const value = Math.max(0, Math.floor(Number(ms) || 0));
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatPercent(value?: number): string {
  const pct = Number(value);
  if (!Number.isFinite(pct)) return "Reliability";
  if (pct >= 99.995) return "100% uptime";
  if (pct >= 99) return `${pct.toFixed(2)}% uptime`;
  return `${pct.toFixed(1)}% uptime`;
}

export function HostReliabilityButton({
  host,
  size = "small",
  type = "default",
  compact,
}: Props): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const { availability, loadingAvailability } = useHostAvailability(
    webapp_client.conat_client.hub,
    host.id,
    {
      enabled: open,
      days: 90,
    },
  );
  const summary = availability?.summary;
  const buttonLabel = summary
    ? summary.current_state === "online"
      ? formatPercent(summary.window_uptime_percent)
      : summary.current_state
    : "Reliability";
  return (
    <>
      <Button
        size={size}
        type={type}
        loading={open && loadingAvailability && !availability}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {buttonLabel}
      </Button>
      {summary && !compact && (
        <Tag color={summary.unplanned_downtime_ms > 0 ? "orange" : "green"}>
          Exposure {formatDuration(summary.unplanned_downtime_ms)}
        </Tag>
      )}
      <Modal
        open={open}
        width={760}
        title={
          <Space>
            <span>Reliability</span>
            <Tag>{host.name ?? host.id}</Tag>
          </Space>
        }
        footer={null}
        destroyOnHidden
        onCancel={() => setOpen(false)}
      >
        <HostAvailabilityPanel
          availability={availability}
          loading={loadingAvailability}
        />
      </Modal>
    </>
  );
}
