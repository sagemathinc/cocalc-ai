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
  | "interrupted"
  | "retrying_spot"
  | "verify_ready"
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

export const HostSpotRecoveryDiagram: React.FC<
  HostSpotRecoveryDiagramProps
> = ({ policyActive, policy, host }) => {
  const activeNode = activeNodeId(host);
  const phase = host?.recovery_phase ?? host?.spot_recovery_state?.phase;
  const standardFallbackEnabled = policy.standard_fallback_enabled !== false;
  const probeRequired = policy.spot_return_requires_probe !== false;
  const retryWindow = policy.spot_restore_retry_window_minutes;
  const retryBackoff = policy.spot_restore_backoff_seconds;
  const fallbackMin = policy.standard_fallback_min_minutes;
  const probeInterval = policy.spot_probe_interval_minutes;
  const liveState = host?.spot_recovery_state;

  const nodes: DiagramNode[] = [
    {
      id: "running_spot",
      x: 30,
      y: 30,
      width: 166,
      height: 58,
      accent: COLORS.BS_GREEN,
      lines: ["Running on Spot"],
    },
    {
      id: "interrupted",
      x: 226,
      y: 30,
      width: 172,
      height: 58,
      accent: COLORS.BG_WARNING,
      lines: ["Spot Interrupted", "VM Off"],
    },
    {
      id: "retrying_spot",
      x: 432,
      y: 20,
      width: 214,
      height: 90,
      accent: COLORS.BLUE,
      lines: [
        "Retrying Spot Start",
        `${retryBackoff}s base backoff`,
        `${retryWindow} min window`,
      ],
    },
    {
      id: "verify_ready",
      x: 432,
      y: 132,
      width: 214,
      height: 96,
      accent: COLORS.BLUE_LL,
      lines: [
        "Verify Host Ready",
        "provider + runtime OK",
        "heartbeat + daemon OK",
      ],
    },
    {
      id: "running_standard_fallback",
      x: 24,
      y: 270,
      width: 220,
      height: 84,
      accent: COLORS.COCALC_ORANGE,
      enabled: standardFallbackEnabled,
      lines: standardFallbackEnabled
        ? ["Running on Standard", "Fallback", `minimum ${fallbackMin} min`]
        : ["Standard Fallback", "Disabled"],
    },
    {
      id: "probing_spot",
      x: 286,
      y: 278,
      width: 176,
      height: 76,
      accent: COLORS.BLUE_D,
      enabled: standardFallbackEnabled,
      lines: standardFallbackEnabled
        ? [
            "Probe Spot Availability",
            `every ${probeInterval} min`,
            probeRequired ? "probe required" : "probe optional",
          ]
        : ["Spot Probe", "Inactive"],
    },
    {
      id: "returning_to_spot",
      x: 500,
      y: 270,
      width: 232,
      height: 84,
      accent: COLORS.ANTD_GREEN_D,
      enabled: standardFallbackEnabled,
      lines: standardFallbackEnabled
        ? ["Return to Spot", "flip VM back", "start and verify"]
        : ["Return to Spot", "Inactive"],
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Space wrap size={[8, 8]}>
        <Tag style={statusTagStyle(COLORS.BLUE_D)}>
          Retry window {retryWindow} min
        </Tag>
        <Tag style={statusTagStyle(COLORS.BLUE)}>
          Backoff base {retryBackoff}s
        </Tag>
        <Tag
          style={statusTagStyle(
            standardFallbackEnabled ? COLORS.COCALC_ORANGE : COLORS.GRAY,
          )}
        >
          Standard fallback {standardFallbackEnabled ? "enabled" : "disabled"}
        </Tag>
        {standardFallbackEnabled && (
          <>
            <Tag style={statusTagStyle(COLORS.COCALC_ORANGE)}>
              Minimum fallback {fallbackMin} min
            </Tag>
            <Tag style={statusTagStyle(COLORS.BLUE_D)}>
              Probe every {probeInterval} min
            </Tag>
            <Tag
              style={statusTagStyle(
                probeRequired ? COLORS.ANTD_GREEN_D : COLORS.GRAY_M,
              )}
            >
              {probeRequired ? "Probe required" : "Probe optional"}
            </Tag>
          </>
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
          viewBox="0 0 760 390"
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
            width={760}
            height={390}
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
            d="M196 59 H226"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel("preemption", 210, 48)}

          <path
            d="M398 59 H432"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel("retry", 414, 48)}

          <path
            d="M539 110 V132"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel("start attempt", 555, 126, { anchor: "start" })}

          <path
            d="M432 180 H198 V88"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel("verified", 310, 168)}

          <path
            d="M646 180 H686 V60 H646"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
          />
          {renderArrowLabel("not ready", 692, 122, { anchor: "start" })}

          <path
            d="M432 78 H408 V314 H244"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
            opacity={standardFallbackEnabled ? 1 : 0.35}
          />
          {renderArrowLabel("retry window expired", 250, 258, {
            anchor: "start",
            color: standardFallbackEnabled ? MUTED_TEXT_COLOR : COLORS.GRAY,
          })}

          <path
            d="M244 312 H286"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
            opacity={standardFallbackEnabled ? 1 : 0.35}
          />
          {renderArrowLabel(`after ${fallbackMin} min`, 264, 300, {
            color: standardFallbackEnabled ? MUTED_TEXT_COLOR : COLORS.GRAY,
          })}

          <path
            d="M462 316 H500"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
            opacity={standardFallbackEnabled ? 1 : 0.35}
          />
          {renderArrowLabel(
            probeRequired ? "probe ok" : "probe ok / optional",
            481,
            303,
            {
              anchor: "middle",
              color: standardFallbackEnabled ? MUTED_TEXT_COLOR : COLORS.GRAY,
            },
          )}

          <path
            d="M616 270 V228"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
            opacity={standardFallbackEnabled ? 1 : 0.35}
          />
          {renderArrowLabel("start spot host", 628, 250, {
            anchor: "start",
            color: standardFallbackEnabled ? MUTED_TEXT_COLOR : COLORS.GRAY,
          })}

          <path
            d="M374 278 C374 252, 374 238, 374 238"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
            opacity={standardFallbackEnabled ? 1 : 0.35}
          />
          {renderArrowLabel(
            `probe failed; wait ${probeInterval} min`,
            374,
            262,
            {
              anchor: "middle",
              color: standardFallbackEnabled ? MUTED_TEXT_COLOR : COLORS.GRAY,
            },
          )}

          {!probeRequired && standardFallbackEnabled && (
            <>
              <path
                d="M244 344 C320 372, 430 372, 500 344"
                stroke={COLORS.GRAY}
                strokeWidth={2}
                strokeDasharray="5 5"
                fill="none"
                markerEnd="url(#spot-recovery-arrow)"
              />
              {renderArrowLabel("direct return allowed", 372, 376)}
            </>
          )}

          <path
            d="M732 312 H748 V172 H646"
            stroke={COLORS.GRAY}
            strokeWidth={2}
            fill="none"
            markerEnd="url(#spot-recovery-arrow)"
            opacity={standardFallbackEnabled ? 1 : 0.35}
          />
          {renderArrowLabel("switchback failed", 678, 250, {
            anchor: "middle",
            color: standardFallbackEnabled ? MUTED_TEXT_COLOR : COLORS.GRAY,
          })}
        </svg>
      </div>

      <Typography.Text type="secondary">
        Recovery work is durable and survives hub restarts. CoCalc only counts a
        restore as successful after provider state, runtime refresh, heartbeat,
        and project-host health all converge.
      </Typography.Text>
    </Space>
  );
};
