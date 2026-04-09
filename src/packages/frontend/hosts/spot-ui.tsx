import { Alert, Popover, Tag } from "antd";
import type { Host } from "@cocalc/conat/hub/api/hosts";

type HostLike = Pick<Host, "pricing_model"> | { pricing_model?: string };

export function isSpotHost(host?: HostLike | null): boolean {
  return host?.pricing_model === "spot";
}

function spotDescription() {
  return (
    <div style={{ maxWidth: 320 }}>
      Spot hosts are cheaper, but the cloud provider can interrupt them at any
      time. CoCalc will try to restart them automatically, but active work can
      still be disrupted.
    </div>
  );
}

export function SpotHostTag() {
  return (
    <Popover
      trigger={["hover", "click"]}
      title="Spot host"
      content={spotDescription()}
    >
      <Tag color="orange" style={{ cursor: "help" }}>
        spot
      </Tag>
    </Popover>
  );
}

export function SpotHostAlert() {
  return (
    <Alert
      type="warning"
      showIcon
      message="Spot host"
      description={spotDescription()}
    />
  );
}
