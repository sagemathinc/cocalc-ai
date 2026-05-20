import {
  CloudOutlined,
  CloudServerOutlined,
  EnvironmentOutlined,
  HddOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { React } from "@cocalc/frontend/app-framework";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import { COLORS } from "@cocalc/util/theme";
import { Space, Typography } from "antd";
import { Tooltip } from "@cocalc/frontend/components";
import { getProviderDescriptor, isKnownProvider } from "../providers/registry";
import {
  formatBinaryBytes,
  getHostCpuCount,
  getHostRamGiB,
  getHostSizeDisplay,
} from "../utils/format";
import { isSpotHost, isSpotStandardFallbackHost } from "../spot-ui";

function getProviderLabel(host: Host): string {
  const cloud = host.machine?.cloud;
  if (!cloud) return "n/a";
  if (isKnownProvider(cloud)) {
    return getProviderDescriptor(cloud).label;
  }
  return cloud;
}

function getSelfHostDetail(host: Host): string | undefined {
  if (host.machine?.cloud !== "self-host") return undefined;
  const kind = host.machine?.metadata?.self_host_kind as string | undefined;
  const mode = host.machine?.metadata?.self_host_mode as string | undefined;
  const kindLabel =
    kind === "direct"
      ? "Direct"
      : kind === "multipass"
        ? "Multipass"
        : undefined;
  const modeLabel =
    mode === "cloudflare"
      ? "Cloudflare tunnel"
      : mode === "local"
        ? "Local network"
        : undefined;
  if (kindLabel && modeLabel) return `${kindLabel} / ${modeLabel}`;
  return kindLabel ?? modeLabel ?? undefined;
}

function HostConfigChip({
  icon,
  label,
  detail,
  tone = "default",
  tooltip,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  detail?: React.ReactNode;
  tone?: "default" | "blue" | "amber" | "muted";
  tooltip?: React.ReactNode;
}) {
  const colors =
    tone === "blue"
      ? {
          border: COLORS.BLUE_LL,
          background: COLORS.BLUE_LLLL,
          text: COLORS.ANTD_LINK_BLUE,
        }
      : tone === "amber"
        ? {
            border: COLORS.YELL_LL,
            background: COLORS.YELL_LLL,
            text: COLORS.YELL_D,
          }
        : tone === "muted"
          ? {
              border: COLORS.GRAY_LL,
              background: COLORS.GRAY_LLL,
              text: COLORS.GRAY_M,
            }
          : {
              border: COLORS.GRAY_LL,
              background: "white",
              text: COLORS.GRAY_D,
            };
  const chip = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        border: `1px solid ${colors.border}`,
        borderRadius: 10,
        background: colors.background,
        padding: "5px 8px",
        minHeight: 30,
        lineHeight: 1.1,
      }}
    >
      <span style={{ color: colors.text, fontSize: 15, lineHeight: 1 }}>
        {icon}
      </span>
      <span>
        <Typography.Text strong style={{ color: colors.text, fontSize: 12 }}>
          {label}
        </Typography.Text>
        {detail ? (
          <Typography.Text
            type="secondary"
            style={{ display: "block", fontSize: 11 }}
          >
            {detail}
          </Typography.Text>
        ) : null}
      </span>
    </span>
  );
  return tooltip ? <Tooltip title={tooltip}>{chip}</Tooltip> : chip;
}

export function HostConfigurationCell({
  host,
  maxWidth = 430,
}: {
  host: Host;
  maxWidth?: number | string;
}) {
  const providerLabel = getProviderLabel(host);
  const selfHostDetail = getSelfHostDetail(host);
  const size = getHostSizeDisplay(host);
  const cpu = getHostCpuCount(host);
  const ramGiB = getHostRamGiB(host);
  const disk =
    host.machine?.disk_gb != null && Number.isFinite(host.machine.disk_gb)
      ? `${host.machine.disk_gb} GB disk`
      : formatBinaryBytes(host.metrics?.current?.disk_device_total_bytes, {
          compact: true,
        });
  const gpuCount = host.machine?.gpu_count ?? (host.gpu ? 1 : 0);
  const gpuLabel = host.gpu
    ? `${gpuCount > 0 ? `${gpuCount}x ` : ""}${host.machine?.gpu_type ?? "GPU"}`
    : "No GPU";
  const spot = isSpotHost(host);
  const fallback = isSpotStandardFallbackHost(host);
  return (
    <Space
      size={[6, 6]}
      wrap
      style={{
        maxWidth,
      }}
    >
      <HostConfigChip
        icon={<CloudOutlined />}
        label={providerLabel}
        detail={selfHostDetail}
        tone="blue"
      />
      <HostConfigChip
        icon={<EnvironmentOutlined />}
        label={host.machine?.cloud === "self-host" ? "Connector" : host.region}
        detail={host.machine?.cloud === "self-host" ? host.region : undefined}
        tone="blue"
      />
      {spot ? (
        <HostConfigChip
          icon={<ThunderboltOutlined />}
          label="Spot default"
          detail={fallback ? "fallback active" : "starts on spot"}
          tone="amber"
          tooltip={
            fallback
              ? "This host is configured to prefer spot pricing. It is temporarily using standard fallback; after it is stopped, Start will try to return it to spot."
              : "This host is configured to start as a spot instance by default."
          }
        />
      ) : null}
      <HostConfigChip
        icon={<HddOutlined />}
        label={size.secondary ?? size.primary}
        detail={size.secondary ? size.primary : undefined}
      />
      {cpu != null ? (
        <HostConfigChip icon={<CloudServerOutlined />} label={`${cpu} vCPU`} />
      ) : null}
      {ramGiB != null ? (
        <HostConfigChip icon={<HddOutlined />} label={`${ramGiB} GB RAM`} />
      ) : null}
      {disk ? <HostConfigChip icon={<HddOutlined />} label={disk} /> : null}
      <HostConfigChip
        icon={<ThunderboltOutlined />}
        label={gpuLabel}
        tone={host.gpu ? "amber" : "muted"}
      />
    </Space>
  );
}
