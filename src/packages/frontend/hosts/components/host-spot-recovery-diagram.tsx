/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space, Tag, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type {
  Host,
  HostPricingModel,
  HostSpotRecoveryPhase,
  HostSpotRecoveryPolicy,
} from "@cocalc/conat/hub/api/hosts";
import { COLORS } from "@cocalc/util/theme";

type HostSpotRecoveryDiagramProps = {
  policyActive: boolean;
  policy: Required<HostSpotRecoveryPolicy>;
  host?: Host;
};

type DiagramNodeId =
  | "running_spot"
  | "retrying_spot"
  | "running_standard_fallback"
  | "probing_spot"
  | "returning_to_spot";

type DiagramNode = {
  id: DiagramNodeId;
  x: number;
  y: number;
  width: number;
  height: number;
  accent: string;
  lines: string[];
  enabled?: boolean;
};

const BOX_FILL = "white";
const TEXT_COLOR = COLORS.GRAY_D;
const MUTED_TEXT_COLOR = COLORS.GRAY_M;
const GRID_BORDER = COLORS.GRAY_L0;
const ACTIVE_GLOW = COLORS.BLUE_LLLL;
const NOTE_FILL = COLORS.GRAY_LLL;

function phaseLabel(phase: HostSpotRecoveryPhase | undefined): string {
  switch (phase) {
    case "retrying_spot":
      return "Retrying spot start";
    case "running_standard_fallback":
      return "Running on standard fallback";
    case "probing_spot":
      return "Probing spot availability";
    case "returning_to_spot":
      return "Returning to spot";
    case "idle":
    default:
      return "Running on spot";
  }
}

function pricingLabel(model: HostPricingModel | undefined): string {
  return model === "spot" ? "Spot" : "Standard";
}

function formatShortDateTime(value: string | undefined): string | undefined {
  if (!value) return;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function activeNodeId(host: Host | undefined): DiagramNodeId | undefined {
  const phase = host?.recovery_phase ?? host?.spot_recovery_state?.phase;
  switch (phase) {
    case "retrying_spot":
      return "retrying_spot";
    case "running_standard_fallback":
      return "running_standard_fallback";
    case "probing_spot":
      return "probing_spot";
    case "returning_to_spot":
      return "returning_to_spot";
    case "idle":
      return "running_spot";
    default:
      return host ? "running_spot" : undefined;
  }
}

function statusTagStyle(color: string) {
  return {
    color,
    borderColor: color,
    background: "white",
  };
}

function renderTextLines(lines: string[], x: number, y: number) {
  const lineHeight = 15;
  const firstBaseline = y - ((lines.length - 1) * lineHeight) / 2;
  return (
    <text
      x={x}
      y={firstBaseline}
      textAnchor="middle"
      fontSize={12.5}
      fill={TEXT_COLOR}
      fontFamily="system-ui, sans-serif"
      fontWeight={500}
    >
      {lines.map((line, index) => (
        <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? 0 : lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function renderArrowLabel(
  text: string,
  x: number,
  y: number,
  {
    anchor = "middle",
    color = MUTED_TEXT_COLOR,
  }: {
    anchor?: "start" | "middle" | "end";
    color?: string;
  } = {},
) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={11}
      fill={color}
      fontFamily="system-ui, sans-serif"
      fontWeight={500}
    >
      {text}
    </text>
  );
}

function renderNoteChip(
  text: string,
  x: number,
  y: number,
  {
    fill = NOTE_FILL,
    stroke = GRID_BORDER,
    textColor = MUTED_TEXT_COLOR,
    width = 112,
  }: {
    fill?: string;
    stroke?: string;
    textColor?: string;
    width?: number;
  } = {},
) {
  return (
    <g>
      <rect
        x={x - width / 2}
        y={y - 12}
        width={width}
        height={24}
        rx={12}
        fill={fill}
        stroke={stroke}
      />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        fontSize={11}
        fill={textColor}
        fontFamily="system-ui, sans-serif"
        fontWeight={600}
      >
        {text}
      </text>
    </g>
  );
}

export const HostSpotRecoveryDiagram: React.FC<
  HostSpotRecoveryDiagramProps
> = ({ policyActive, policy, host }) => {
  const activeNode = activeNodeId(host);
  const phase = host?.recovery_phase ?? host?.spot_recovery_state?.phase;
  const standardFallbackEnabled = policy.standard_fallback_enabled !== false;
  const probeRequired = policy.spot_return_requires_probe !== false;
  const retryWindow = policy.spot_restore_retry_window_minutes;
  const retryBackoff = policy.spot_restore_backoff_seconds;
  const maxRestoreAttempts = policy.max_restore_attempts_before_fallback;
  const fallbackMin = policy.standard_fallback_min_minutes;
  const probeInterval = policy.spot_probe_interval_minutes;
  const liveState = host?.spot_recovery_state;

  const nodes: DiagramNode[] = [
    {
      id: "running_spot",
      x: 36,
      y: 34,
      width: 174,
      height: 58,
      accent: COLORS.BS_GREEN,
      lines: ["Running on Spot"],
    },
    {
      id: "retrying_spot",
      x: 300,
      y: 34,
      width: 184,
      height: 58,
      accent: COLORS.BLUE,
      lines: ["Retry Spot"],
    },
    {
      id: "running_standard_fallback",
      x: 616,
      y: 34,
      width: 188,
      height: 58,
      accent: COLORS.COCALC_ORANGE,
      enabled: standardFallbackEnabled,
      lines: standardFallbackEnabled
        ? ["Standard Fallback"]
        : ["Fallback Disabled"],
    },
    {
      id: "probing_spot",
      x: 560,
      y: 176,
      width: 168,
      height: 58,
      accent: COLORS.BLUE_D,
      enabled: standardFallbackEnabled,
      lines: standardFallbackEnabled ? ["Probe Spot"] : ["Probe Inactive"],
    },
    {
      id: "returning_to_spot",
      x: 272,
      y: 176,
      width: 192,
      height: 58,
      accent: COLORS.ANTD_GREEN_D,
      enabled: standardFallbackEnabled,
      lines: standardFallbackEnabled ? ["Return to Spot"] : ["Return Inactive"],
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Space wrap size={[8, 8]}>
        <Tag style={statusTagStyle(COLORS.BLUE_D)}>
          Retry {retryWindow} min / {retryBackoff}s base
        </Tag>
        <Tag
          style={statusTagStyle(
            standardFallbackEnabled ? COLORS.COCALC_ORANGE : COLORS.GRAY,
          )}
        >
          {standardFallbackEnabled
            ? `Fallback to standard after ${
                maxRestoreAttempts > 0
                  ? `${maxRestoreAttempts} attempts or `
                  : ""
              }retry window`
            : "Standard fallback disabled"}
        </Tag>
        {standardFallbackEnabled && (
          <Tag style={statusTagStyle(COLORS.ANTD_GREEN_D)}>
            Return check every {probeInterval} min{" "}
            {probeRequired ? "(probe required)" : "(direct return allowed)"}
          </Tag>
        )}
      </Space>

      {host && (
        <Space wrap size={[8, 8]}>
          <Tag color={phase === "idle" ? "success" : "processing"}>
            Current phase: {phaseLabel(phase)}
          </Tag>
          <Tag color="blue">
            Desired pricing:{" "}
            {pricingLabel(host.desired_pricing_model ?? "spot")}
          </Tag>
          <Tag
            color={
              (host.effective_pricing_model ?? host.pricing_model ?? "spot") ===
              "spot"
                ? "green"
                : "orange"
            }
          >
            Effective pricing:{" "}
            {pricingLabel(host.effective_pricing_model ?? host.pricing_model)}
          </Tag>
          {liveState?.attempt != null && (
            <Tag color="purple">Attempt {liveState.attempt}</Tag>
          )}
          {liveState?.next_retry_at && (
            <Tag color="cyan">
              Next retry {formatShortDateTime(liveState.next_retry_at)}
            </Tag>
          )}
          {liveState?.last_probe_result && (
            <Tag
              color={
                liveState.last_probe_result === "success" ? "green" : "red"
              }
            >
              Last probe {liveState.last_probe_result}
            </Tag>
          )}
        </Space>
      )}

      <div
        style={{
          border: `1px solid ${GRID_BORDER}`,
          borderRadius: 12,
          padding: 12,
          background: policyActive ? "white" : COLORS.GRAY_LLL,
        }}
      >
        <svg
          viewBox="0 0 840 276"
          width="100%"
          role="img"
          aria-label="Spot instance recovery state machine"
        >
          <defs>
            <marker
              id="spot-recovery-arrow"
              markerWidth="10"
              markerHeight="10"
              refX="8"
              refY="5"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L10,5 L0,10 z" fill={COLORS.GRAY} />
            </marker>
          </defs>

          <rect
            x={0}
            y={0}
            width={840}
            height={276}
            rx={16}
            fill={policyActive ? "white" : COLORS.GRAY_LLL}
          />

          {nodes.map((node) => {
            const active = policyActive && activeNode === node.id;
            const enabled = node.enabled !== false;
            return (
              <g key={node.id} opacity={enabled ? 1 : 0.35}>
                {active && (
                  <rect
                    x={node.x - 6}
                    y={node.y - 6}
                    width={node.width + 12}
                    height={node.height + 12}
                    rx={18}
                    fill={ACTIVE_GLOW}
                  />
                )}
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx={14}
                  fill={BOX_FILL}
                  stroke={active ? node.accent : GRID_BORDER}
                  strokeWidth={active ? 3 : 1.5}
                />
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={8}
                  rx={14}
                  fill={node.accent}
                />
                {renderTextLines(
                  node.lines,
                  node.x + node.width / 2,
                  node.y + node.height / 2 + 6,
                )}
              </g>
            );
          })}

          <path
            d="M210 60 C236 28, 274 28, 300 60"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel("interrupted", 255, 24)}

          <path
            d="M300 68 C268 112, 238 112, 210 76"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel("spot restored", 252, 118)}

          <path
            d="M484 62 H616"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel("retry limit reached", 550, 48)}

          <path
            d="M710 92 V176"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel(`after ${fallbackMin} min`, 722, 138, {
            anchor: "start",
          })}

          <path
            d="M560 206 H464"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
            opacity={standardFallbackEnabled ? 1 : 0.35}
          />
          {renderArrowLabel(
            probeRequired ? "probe succeeded" : "probe or direct return",
            512,
            194,
            {
              color: standardFallbackEnabled ? MUTED_TEXT_COLOR : COLORS.GRAY,
            },
          )}

          <path
            d="M272 206 C182 206, 110 180, 110 92"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel("back on spot", 148, 176)}

          {standardFallbackEnabled && (
            <>
              <path
                d="M644 176 C628 146, 628 132, 646 110"
                stroke={COLORS.GRAY}
                strokeWidth={2}
                fill="none"
                markerEnd="url(#spot-recovery-arrow)"
              />
              {renderArrowLabel(`wait ${probeInterval} min`, 618, 148, {
                anchor: "end",
              })}
            </>
          )}

          {renderNoteChip(`retry up to ${retryWindow} min`, 392, 112, {
            width: 132,
          })}

          {standardFallbackEnabled &&
            renderNoteChip(`probe every ${probeInterval} min`, 644, 252, {
              width: 134,
            })}

          {standardFallbackEnabled &&
            renderNoteChip(
              probeRequired ? "probe required" : "direct return allowed",
              368,
              252,
              {
                width: 142,
                fill: probeRequired ? NOTE_FILL : COLORS.BLUE_LLL,
                stroke: probeRequired ? GRID_BORDER : COLORS.BLUE_LL,
              },
            )}
        </svg>
      </div>

      <Space direction="vertical" size={2}>
        <Typography.Text type="secondary">
          CoCalc retries the interrupted spot VM first. If that does not recover
          within the configured window, it can switch the same host to standard
          temporarily.
        </Typography.Text>
        <Typography.Text type="secondary">
          Return to spot only completes after provider state, runtime refresh,
          heartbeat, and project-host health all converge.
        </Typography.Text>
      </Space>
    </Space>
  );
};
