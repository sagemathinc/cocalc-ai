/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { React } from "@cocalc/frontend/app-framework";
import { Button, Popover, Space, Tag, Typography } from "antd";
import type {
  Host,
  HostPressureState,
  HostPressureZone,
} from "@cocalc/conat/hub/api/hosts";
import { Tooltip } from "@cocalc/frontend/components";

const PRESSURE_ORDER: Record<HostPressureZone, number> = {
  normal: 0,
  observe: 1,
  pressure: 2,
  emergency: 3,
};

const PRESSURE_COLOR: Partial<Record<HostPressureZone, string>> = {
  normal: "green",
  observe: "gold",
  pressure: "orange",
  emergency: "red",
};

const PRESSURE_LABEL: Partial<Record<HostPressureZone, string>> = {
  normal: "Normal",
  observe: "Observe",
  pressure: "Pressure",
  emergency: "Emergency",
};

function formatTimestamp(ms?: number): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toLocaleString();
}

function pressureTooltip(pressure?: HostPressureState): React.ReactNode {
  const zone = pressure?.zone;
  if (!zone) return undefined;
  const lines: string[] = [];
  if (pressure?.reason) {
    lines.push(pressure.reason);
  }
  const since = formatTimestamp(pressure?.since_ms);
  if (since) {
    lines.push(`Since ${since}`);
  }
  const evaluatedAt = formatTimestamp(pressure?.evaluated_at_ms);
  if (evaluatedAt) {
    lines.push(`Evaluated ${evaluatedAt}`);
  }
  if (pressure?.candidate_count != null) {
    lines.push(`${pressure.candidate_count} stop candidate(s)`);
  }
  if (pressure?.recent_pressure_stop_count != null) {
    lines.push(
      `${pressure.recent_pressure_stop_count} recent pressure stop(s)`,
    );
  }
  if (pressure?.last_action_status) {
    const detail = [
      pressure.last_action_status,
      pressure.last_action_project_id
        ? `project ${pressure.last_action_project_id}`
        : undefined,
      formatTimestamp(pressure.last_action_at_ms),
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`Last pressure action: ${detail}`);
  }
  if (pressure?.last_action_reason) {
    lines.push(pressure.last_action_reason);
  }
  if (!lines.length) return undefined;
  return (
    <Space orientation="vertical" size={2}>
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </Space>
  );
}

function placementSummary(
  host: Pick<Host, "pressure" | "can_place" | "reason_unavailable">,
): {
  color: string;
  label: string;
  detail: string;
} {
  if (host.can_place === false) {
    return {
      color: "red",
      label: "Placement blocked",
      detail: host.reason_unavailable ?? "This host is not currently eligible.",
    };
  }
  const zone = host.pressure?.zone;
  switch (zone) {
    case "observe":
      return {
        color: PRESSURE_COLOR.observe ?? "gold",
        label: "Placement observe",
        detail:
          host.pressure?.reason ??
          "Auto placement still works here, but calmer hosts are preferred first.",
      };
    case "pressure":
      return {
        color: PRESSURE_COLOR.pressure ?? "orange",
        label: "Placement pressure",
        detail:
          host.pressure?.reason ??
          "Auto placement deprioritizes this host while it is under pressure.",
      };
    case "emergency":
      return {
        color: PRESSURE_COLOR.emergency ?? "red",
        label: "Placement emergency",
        detail:
          host.pressure?.reason ??
          "Auto placement strongly avoids this host while it is in emergency pressure.",
      };
    default:
      return {
        color: PRESSURE_COLOR.normal ?? "green",
        label: "Placement normal",
        detail:
          "Auto placement currently considers this host a normal candidate.",
      };
  }
}

export function hostPressureRank(host?: Pick<Host, "pressure">): number {
  const zone = host?.pressure?.zone;
  if (!zone) return PRESSURE_ORDER.normal;
  return PRESSURE_ORDER[zone] ?? PRESSURE_ORDER.normal;
}

export function HostPressureTag({
  pressure,
  showNormal = false,
}: {
  pressure?: HostPressureState;
  showNormal?: boolean;
}) {
  const zone = pressure?.zone;
  if (!zone || (zone === "normal" && !showNormal)) return null;
  const label = PRESSURE_LABEL[zone] ?? zone;
  const tag = <Tag color={PRESSURE_COLOR[zone]}>{label}</Tag>;
  const title = pressureTooltip(pressure);
  if (!title) return tag;
  return <Tooltip title={title}>{tag}</Tooltip>;
}

export function HostPlacementSummary({
  host,
  showNormal = false,
  compact = false,
  detailMode = "inline",
}: {
  host: Pick<Host, "pressure" | "can_place" | "reason_unavailable">;
  showNormal?: boolean;
  compact?: boolean;
  detailMode?: "inline" | "popover";
}) {
  const summary = placementSummary(host);
  if (
    !showNormal &&
    host.can_place !== false &&
    (!host.pressure?.zone || host.pressure.zone === "normal")
  ) {
    return null;
  }
  if (detailMode === "popover") {
    return (
      <Space size="small" wrap>
        <Tag color={summary.color}>{summary.label}</Tag>
        <Popover
          content={
            <Typography.Text style={{ maxWidth: 320, display: "block" }}>
              {summary.detail}
            </Typography.Text>
          }
          title="Placement"
          trigger="click"
        >
          <Button
            size="small"
            type="link"
            style={{ padding: 0, height: "auto" }}
          >
            Why?
          </Button>
        </Popover>
      </Space>
    );
  }
  const content = (
    <Space
      orientation="vertical"
      size={compact ? 2 : 4}
      style={{ width: "100%" }}
    >
      <Space size="small" wrap>
        <Tag color={summary.color}>{summary.label}</Tag>
        <HostPressureTag pressure={host.pressure} />
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: compact ? 12 : 13 }}>
        {summary.detail}
      </Typography.Text>
    </Space>
  );
  return content;
}
