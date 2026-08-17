/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { Empty, Space, theme, Typography } from "antd";

import Plot from "@cocalc/frontend/components/plotly";
import { COLORS } from "@cocalc/util/theme";

import type {
  MembershipAnalyticsBreakdown,
  MembershipAnalyticsSeries,
  MembershipAnalyticsView,
} from "./personal-membership-analytics-view";
import { totalMembershipAnalyticsPoints } from "./personal-membership-analytics-view";

export type MembershipAnalyticsChartMode = "stacked" | "lines";
export type MembershipAnalyticsMetric = "revenue" | "memberships";
export type MembershipAnalyticsLineDash = "solid" | "dash" | "dot" | "dashdot";

export interface MembershipAnalyticsSeriesVisual {
  series: MembershipAnalyticsSeries;
  color: string;
  fillColor: string;
  lineDash: MembershipAnalyticsLineDash;
  opacity: number;
}

export interface MembershipAnalyticsHoverRow {
  key: string;
  label: string;
  color: string;
  fillColor: string;
  lineDash: MembershipAnalyticsLineDash;
  opacity: number;
  current: number;
  comparison: number;
}

export interface MembershipAnalyticsHoverModel {
  currentDay: string;
  comparisonDay?: string;
  rows: MembershipAnalyticsHoverRow[];
  currentTotal: number;
  comparisonTotal: number;
}

interface MembershipAnalyticsHoverState {
  day: string;
  clientX: number;
  clientY: number;
  seriesKey?: string;
  comparison?: boolean;
}

interface MembershipAnalyticsTraceMeta {
  seriesKey: string;
  comparison: boolean;
}

function membershipAnalyticsTraceMeta(
  value: unknown,
): MembershipAnalyticsTraceMeta | undefined {
  if (value == null || typeof value !== "object") return;
  const { seriesKey, comparison } =
    value as Partial<MembershipAnalyticsTraceMeta>;
  if (typeof seriesKey !== "string" || typeof comparison !== "boolean") return;
  return { seriesKey, comparison };
}

export function nearestMembershipAnalyticsHoverPointIndex(
  points: Array<{ y?: unknown; data?: { meta?: unknown } }>,
  pointerY: unknown,
): number {
  const numericPointerY =
    typeof pointerY === "number" && Number.isFinite(pointerY)
      ? pointerY
      : undefined;
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    if (membershipAnalyticsTraceMeta(point.data?.meta) == null) return;
    const pointY =
      typeof point.y === "number" && Number.isFinite(point.y)
        ? point.y
        : undefined;
    if (numericPointerY == null || pointY == null) {
      if (nearestIndex < 0) nearestIndex = index;
      return;
    }
    const distance = Math.abs(pointY - numericPointerY);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  });
  return nearestIndex < 0 ? 0 : nearestIndex;
}

const TIER_COLORS = COLORS.CATEGORICAL;

function variantLineDash(
  variant: MembershipAnalyticsSeries["variant"],
): MembershipAnalyticsLineDash {
  switch (variant) {
    case "first_paid":
    case "month":
      return "solid";
    case "renewal":
    case "year":
      return "dash";
    case "plan_change":
    case "fixed":
      return "dot";
    case "trial":
      return "dashdot";
  }
  return "solid";
}

function variantTint(
  breakdown: MembershipAnalyticsBreakdown,
  variant: MembershipAnalyticsSeries["variant"],
): number {
  if (breakdown === "tier-lifecycle") {
    switch (variant) {
      case "first_paid":
        return 0;
      case "plan_change":
        return 0.18;
      case "renewal":
        return 0.34;
      case "trial":
        return 0.5;
    }
  }
  if (breakdown === "tier-interval") {
    switch (variant) {
      case "month":
        return 0;
      case "fixed":
        return 0.18;
      case "year":
        return 0.34;
      case "trial":
        return 0.5;
    }
  }
  return 0;
}

function tintMembershipAnalyticsColor(color: string, amount: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (match == null || amount <= 0) return color;
  const value = Number.parseInt(match[1], 16);
  const channel = (shift: number) => {
    const original = (value >> shift) & 0xff;
    return Math.round(original + (0xff - original) * Math.min(amount, 1));
  };
  return `#${[channel(16), channel(8), channel(0)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function buildMembershipAnalyticsSeriesVisuals({
  series,
  tiers,
  breakdown,
}: {
  series: MembershipAnalyticsSeries[];
  tiers: Array<{ id: string; priority: number }>;
  breakdown: MembershipAnalyticsBreakdown;
}): MembershipAnalyticsSeriesVisual[] {
  const usedTierIds = new Set(
    series.map(({ tierId }) => tierId).filter((tierId) => tierId != null),
  );
  const sortedTierIds = tiers
    .filter(({ id }) => usedTierIds.has(id))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map(({ id }) => id);
  for (const tierId of usedTierIds) {
    if (!sortedTierIds.includes(tierId)) sortedTierIds.push(tierId);
  }
  const tierColors = new Map(
    sortedTierIds.map((tierId, index) => [
      tierId,
      TIER_COLORS[index % TIER_COLORS.length],
    ]),
  );
  return series.map((item, index) => {
    const color =
      (item.tierId == null ? undefined : tierColors.get(item.tierId)) ??
      TIER_COLORS[index % TIER_COLORS.length];
    return {
      series: item,
      color,
      fillColor: tintMembershipAnalyticsColor(
        color,
        variantTint(breakdown, item.variant),
      ),
      lineDash:
        breakdown === "tier-interval" || breakdown === "tier-lifecycle"
          ? variantLineDash(item.variant)
          : "solid",
      opacity: 1,
    };
  });
}

function lineDashArray(
  dash: MembershipAnalyticsLineDash,
  width: number,
): string | undefined {
  switch (dash) {
    case "dash":
      return "6 4";
    case "dot":
      return `1 ${Math.max(5, width + 4)}`;
    case "dashdot":
      return `6 3 1 ${Math.max(5, width + 3)}`;
    case "solid":
      return;
  }
}

export function MembershipAnalyticsLineSwatch({
  color,
  dash = "solid",
  opacity = 1,
  width = 3,
}: {
  color: string;
  dash?: MembershipAnalyticsLineDash;
  opacity?: number;
  width?: number;
}) {
  const height = Math.max(5, width);
  return (
    <svg
      aria-hidden
      height={height}
      width={20}
      style={{
        display: "inline-block",
        overflow: "visible",
        verticalAlign: "middle",
      }}
    >
      <line
        x1={0}
        x2={20}
        y1={height / 2}
        y2={height / 2}
        stroke={color}
        strokeDasharray={lineDashArray(dash, width)}
        strokeLinecap={dash === "dot" ? "round" : "butt"}
        strokeWidth={width}
        opacity={opacity}
      />
    </svg>
  );
}

function MembershipAnalyticsHaloLineSwatch({
  color = COLORS.GRAY_DD,
  dash = "solid",
  opacity = 1,
  width = 3,
}: {
  color?: string;
  dash?: MembershipAnalyticsLineDash;
  opacity?: number;
  width?: number;
}) {
  const haloWidth = width + 2;
  const dashArray = lineDashArray(dash, width);
  return (
    <svg
      aria-hidden
      height={haloWidth}
      width={20}
      style={{
        display: "inline-block",
        overflow: "visible",
        verticalAlign: "middle",
      }}
    >
      <line
        x1={0}
        x2={20}
        y1={haloWidth / 2}
        y2={haloWidth / 2}
        stroke={COLORS.GRAY_LLL}
        strokeDasharray={dashArray}
        strokeLinecap={dash === "dot" ? "round" : "butt"}
        strokeWidth={haloWidth}
      />
      <line
        x1={0}
        x2={20}
        y1={haloWidth / 2}
        y2={haloWidth / 2}
        stroke={color}
        strokeDasharray={dashArray}
        strokeLinecap={dash === "dot" ? "round" : "butt"}
        strokeWidth={width}
        opacity={opacity}
      />
    </svg>
  );
}

function MembershipAnalyticsAreaSwatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        background: color,
        display: "inline-block",
        height: 10,
        verticalAlign: "middle",
        width: 20,
      }}
    />
  );
}

export function MembershipAnalyticsSeriesSwatch({
  visual,
  chartMode,
}: {
  visual: MembershipAnalyticsSeriesVisual;
  chartMode: MembershipAnalyticsChartMode;
}) {
  return chartMode === "stacked" ? (
    <MembershipAnalyticsAreaSwatch color={visual.fillColor} />
  ) : (
    <MembershipAnalyticsLineSwatch
      color={visual.color}
      dash={visual.lineDash}
      opacity={visual.opacity}
    />
  );
}

function LegendItem({
  visual,
  compact = false,
  chartMode,
}: {
  visual: MembershipAnalyticsSeriesVisual;
  compact?: boolean;
  chartMode: MembershipAnalyticsChartMode;
}) {
  return (
    <Space>
      <MembershipAnalyticsSeriesSwatch visual={visual} chartMode={chartMode} />
      <Typography.Text>
        {compact ? visual.series.detailLabel : visual.series.label}
      </Typography.Text>
    </Space>
  );
}

export function MembershipAnalyticsLegend({
  visuals,
  breakdown,
  comparisonLabel,
  chartMode,
}: {
  visuals: MembershipAnalyticsSeriesVisual[];
  breakdown: MembershipAnalyticsBreakdown;
  comparisonLabel?: string;
  chartMode: MembershipAnalyticsChartMode;
}) {
  const grouped =
    breakdown === "tier-interval" || breakdown === "tier-lifecycle";
  const tierGroups = new Map<string, MembershipAnalyticsSeriesVisual[]>();
  if (grouped) {
    for (const visual of visuals) {
      const key = visual.series.tierId ?? visual.series.key;
      tierGroups.set(key, [...(tierGroups.get(key) ?? []), visual]);
    }
  }
  return (
    <Space wrap>
      {grouped
        ? [...tierGroups.entries()].map(([key, group]) => (
            <Space key={key}>
              <Typography.Text strong>
                {group[0].series.groupLabel}
              </Typography.Text>
              {group.map((visual) => (
                <LegendItem
                  key={visual.series.key}
                  visual={visual}
                  compact
                  chartMode={chartMode}
                />
              ))}
            </Space>
          ))
        : visuals.map((visual) => (
            <LegendItem
              key={visual.series.key}
              visual={visual}
              chartMode={chartMode}
            />
          ))}
      {comparisonLabel ? (
        chartMode === "stacked" ? (
          <Space>
            <MembershipAnalyticsHaloLineSwatch />
            <Typography.Text type="secondary">
              Total {comparisonLabel.toLowerCase()} ago
            </Typography.Text>
          </Space>
        ) : (
          <Space>
            <Space>
              <MembershipAnalyticsLineSwatch color={COLORS.GRAY_D} />
              <Typography.Text type="secondary">Current</Typography.Text>
            </Space>
            <Space>
              <MembershipAnalyticsLineSwatch
                color={COLORS.GRAY_D}
                opacity={0.55}
                width={1}
              />
              <Typography.Text type="secondary">
                {comparisonLabel} ago
              </Typography.Text>
            </Space>
          </Space>
        )
      ) : null}
    </Space>
  );
}

function pointValue(
  point: MembershipAnalyticsSeries["current"][number],
  metric: MembershipAnalyticsMetric,
): number {
  return metric === "revenue"
    ? point.revenueCents / 100
    : point.activeMemberships;
}

export function buildMembershipAnalyticsHoverModel({
  day,
  visuals,
  metric,
  includeComparison,
}: {
  day: string;
  visuals: MembershipAnalyticsSeriesVisual[];
  metric: MembershipAnalyticsMetric;
  includeComparison: boolean;
}): MembershipAnalyticsHoverModel | undefined {
  const rows = visuals
    .map((visual) => {
      const currentPoint = visual.series.current.find(
        ({ displayDay }) => displayDay === day,
      );
      const comparisonPoint = includeComparison
        ? visual.series.comparison.find(({ displayDay }) => displayDay === day)
        : undefined;
      if (currentPoint == null) return;
      return {
        key: visual.series.key,
        label: visual.series.label,
        color: visual.color,
        fillColor: visual.fillColor,
        lineDash: visual.lineDash,
        opacity: visual.opacity,
        current: pointValue(currentPoint, metric),
        comparison:
          comparisonPoint == null ? 0 : pointValue(comparisonPoint, metric),
        currentDay: currentPoint.actualDay,
        comparisonDay: comparisonPoint?.actualDay,
      };
    })
    .filter((row) => row != null)
    .filter(
      ({ current, comparison }) =>
        metric !== "revenue" || current !== 0 || comparison !== 0,
    );
  const first = rows[0];
  if (first == null) return;
  return {
    currentDay: first.currentDay,
    comparisonDay: includeComparison ? first.comparisonDay : undefined,
    rows: rows.map(
      ({ currentDay: _currentDay, comparisonDay: _comparisonDay, ...row }) =>
        row,
    ),
    currentTotal: rows.reduce((total, { current }) => total + current, 0),
    comparisonTotal: rows.reduce(
      (total, { comparison }) => total + comparison,
      0,
    ),
  };
}

function trace({
  visual,
  metric,
  comparison,
  stacked,
  highlighted = false,
  halo = false,
}: {
  visual: MembershipAnalyticsSeriesVisual;
  metric: MembershipAnalyticsMetric;
  comparison: boolean;
  stacked: boolean;
  highlighted?: boolean;
  halo?: boolean;
}) {
  const points = comparison ? visual.series.comparison : visual.series.current;
  const stackedArea = stacked && !comparison;
  const traceMeta: MembershipAnalyticsTraceMeta = {
    seriesKey: visual.series.key,
    comparison,
  };
  return {
    x: points.map(({ displayDay }) => displayDay),
    y: points.map((point) => pointValue(point, metric)),
    type: "scatter" as const,
    mode: "lines" as const,
    connectgaps: false,
    hoverinfo: "none" as const,
    line: {
      color: halo
        ? COLORS.GRAY_LLL
        : stackedArea
          ? visual.fillColor
          : visual.color,
      dash: visual.lineDash,
      width: stackedArea
        ? 0
        : halo
          ? comparison
            ? 4
            : 7
          : highlighted
            ? comparison
              ? 2
              : 5
            : comparison
              ? 1
              : 3,
    },
    ...(stackedArea ? { fillcolor: visual.fillColor } : {}),
    meta: traceMeta,
    name: halo ? `${visual.series.label} halo` : visual.series.label,
    opacity: halo ? 1 : comparison ? (highlighted ? 0.75 : 0.5) : 1,
    ...(stackedArea ? { stackgroup: "current" } : {}),
  };
}

function comparisonTotalTraces({
  view,
  metric,
}: {
  view: MembershipAnalyticsView;
  metric: MembershipAnalyticsMetric;
}) {
  const points = totalMembershipAnalyticsPoints(view.series, "comparison");
  const common = {
    x: points.map(({ displayDay }) => displayDay),
    y: points.map((point) => pointValue(point, metric)),
    type: "scatter" as const,
    mode: "lines" as const,
    connectgaps: false,
    hoverinfo: "none" as const,
  };
  return [
    {
      ...common,
      line: { color: COLORS.GRAY_LLL, width: 5 },
      name: "Total halo",
    },
    {
      ...common,
      line: { color: COLORS.GRAY_DD, width: 3 },
      name: "Total",
    },
  ];
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function formatHoverDay(day: string): string {
  return `${DATE_FORMAT.format(new Date(`${day}T00:00:00.000Z`))} UTC`;
}

function formatHoverValue(
  value: number,
  metric: MembershipAnalyticsMetric,
): string {
  const formatted = NUMBER_FORMAT.format(value);
  return metric === "revenue" ? `$${formatted}` : formatted;
}

function HoverValueRow({
  label,
  value,
  metric,
  color,
  fillColor,
  lineDash,
  opacity,
  lineWidth,
  swatch,
  highlighted = false,
}: {
  label: string;
  value: number;
  metric: MembershipAnalyticsMetric;
  color: string;
  fillColor: string;
  lineDash: MembershipAnalyticsLineDash;
  opacity: number;
  lineWidth: number;
  swatch: "area" | "empty" | "halo" | "line";
  highlighted?: boolean;
}) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        alignItems: "center",
        background: highlighted ? token.colorInfoBg : undefined,
        display: "grid",
        gap: 8,
        gridTemplateColumns: "20px minmax(0, 1fr) auto",
      }}
    >
      {swatch === "area" ? (
        <MembershipAnalyticsAreaSwatch color={fillColor} />
      ) : swatch === "empty" ? (
        <span aria-hidden />
      ) : swatch === "halo" ? (
        <MembershipAnalyticsHaloLineSwatch
          color={color}
          dash={lineDash}
          opacity={opacity}
          width={lineWidth}
        />
      ) : (
        <MembershipAnalyticsLineSwatch
          color={color}
          dash={lineDash}
          opacity={opacity}
          width={lineWidth}
        />
      )}
      <Typography.Text strong={highlighted}>{label}:</Typography.Text>
      <Typography.Text strong={highlighted}>
        {formatHoverValue(value, metric)}
      </Typography.Text>
    </div>
  );
}

function HoverSection({
  day,
  rows,
  metric,
  comparison,
  lineWidth,
  swatch,
  total,
  highlightedKey,
  highlightedComparison,
  highlightedLineWidth,
  comparisonOpacity = 0.5,
}: {
  day: string;
  rows: MembershipAnalyticsHoverRow[];
  metric: MembershipAnalyticsMetric;
  comparison: boolean;
  lineWidth: number;
  swatch: "area" | "empty" | "halo" | "line";
  total?: number;
  highlightedKey?: string;
  highlightedComparison?: boolean;
  highlightedLineWidth?: number;
  comparisonOpacity?: number;
}) {
  return (
    <div style={{ minWidth: 180 }}>
      <Typography.Text strong>{formatHoverDay(day)}</Typography.Text>
      <div style={{ marginTop: 4 }}>
        {rows.map((row) => {
          const highlighted =
            row.key === highlightedKey && comparison === highlightedComparison;
          return (
            <HoverValueRow
              key={row.key}
              label={row.label}
              value={comparison ? row.comparison : row.current}
              metric={metric}
              color={row.color}
              fillColor={row.fillColor}
              lineDash={row.lineDash}
              opacity={
                comparison
                  ? highlighted
                    ? 0.75
                    : comparisonOpacity
                  : row.opacity
              }
              lineWidth={
                highlighted ? (highlightedLineWidth ?? lineWidth) : lineWidth
              }
              swatch={swatch === "line" && highlighted ? "halo" : swatch}
              highlighted={highlighted}
            />
          );
        })}
        {total != null ? (
          <HoverValueRow
            label="Total"
            value={total}
            metric={metric}
            color={COLORS.GRAY_DD}
            fillColor={COLORS.GRAY_DD}
            lineDash="solid"
            opacity={1}
            lineWidth={0}
            swatch="empty"
          />
        ) : null}
      </div>
    </div>
  );
}

function MembershipAnalyticsHoverOverlay({
  hover,
  model,
  metric,
  chartMode,
  highlightedKey,
  highlightedComparison,
}: {
  hover: MembershipAnalyticsHoverState;
  model: MembershipAnalyticsHoverModel;
  metric: MembershipAnalyticsMetric;
  chartMode: MembershipAnalyticsChartMode;
  highlightedKey?: string;
  highlightedComparison?: boolean;
}) {
  const { token } = theme.useToken();
  const hasComparison = model.comparisonDay != null;
  const horizontal = chartMode === "lines" && hasComparison;
  const position =
    hover.clientX < window.innerWidth / 2
      ? { left: hover.clientX + 12 }
      : { right: window.innerWidth - hover.clientX + 12 };
  const vertical = { bottom: window.innerHeight - hover.clientY + 12 };
  const comparisonRows =
    chartMode === "stacked"
      ? [
          {
            key: "comparison-total",
            label: "Total",
            color: COLORS.GRAY_DD,
            fillColor: COLORS.GRAY_DD,
            lineDash: "solid" as const,
            opacity: 1,
            current: 0,
            comparison: model.comparisonTotal,
          },
        ]
      : model.rows;
  return createPortal(
    <div
      style={{
        ...position,
        ...vertical,
        background: token.colorBgElevated,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        boxShadow: token.boxShadowSecondary,
        display: "grid",
        gap: 12,
        gridTemplateColumns: horizontal ? "repeat(2, auto)" : "auto",
        maxWidth: "calc(100vw - 24px)",
        padding: "8px 10px",
        pointerEvents: "none",
        position: "fixed",
        zIndex: token.zIndexPopupBase,
      }}
    >
      {horizontal && model.comparisonDay ? (
        <HoverSection
          day={model.comparisonDay}
          rows={comparisonRows}
          metric={metric}
          comparison
          lineWidth={1}
          swatch="line"
          highlightedKey={highlightedKey}
          highlightedComparison={highlightedComparison}
          highlightedLineWidth={2}
        />
      ) : null}
      <HoverSection
        day={model.currentDay}
        rows={model.rows}
        metric={metric}
        comparison={false}
        lineWidth={3}
        swatch={chartMode === "stacked" ? "area" : "line"}
        total={chartMode === "stacked" ? model.currentTotal : undefined}
        highlightedKey={highlightedKey}
        highlightedComparison={highlightedComparison}
        highlightedLineWidth={5}
      />
      {!horizontal && model.comparisonDay ? (
        <HoverSection
          day={model.comparisonDay}
          rows={comparisonRows}
          metric={metric}
          comparison
          lineWidth={3}
          swatch="halo"
          comparisonOpacity={chartMode === "stacked" ? 1 : undefined}
        />
      ) : null}
    </div>,
    document.body,
  );
}

export function MembershipAnalyticsPlot({
  view,
  visuals,
  metric,
  chartMode,
  comparisonLabel,
  hoverDay,
  onHoverDay,
}: {
  view: MembershipAnalyticsView;
  visuals: MembershipAnalyticsSeriesVisual[];
  metric: MembershipAnalyticsMetric;
  chartMode: MembershipAnalyticsChartMode;
  comparisonLabel?: string;
  hoverDay?: string;
  onHoverDay: (day?: string) => void;
}) {
  const [hover, setHover] = useState<MembershipAnalyticsHoverState>();
  if (!visuals.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No personal membership allocation data is available."
      />
    );
  }
  const stacked = chartMode === "stacked";
  const currentVisuals = stacked ? [...visuals].reverse() : visuals;
  const displayedVisuals =
    metric === "revenue"
      ? visuals.filter(({ series }) =>
          [...series.current, ...series.comparison].some(
            ({ revenueCents }) => revenueCents !== 0,
          ),
        )
      : visuals;
  const comparisonTraces =
    comparisonLabel && view.comparisonAvailable
      ? stacked
        ? comparisonTotalTraces({ view, metric })
        : displayedVisuals.map((visual) =>
            trace({
              visual,
              metric,
              comparison: true,
              stacked: false,
            }),
          )
      : [];
  const currentTraces = currentVisuals
    .filter((visual) => displayedVisuals.includes(visual))
    .map((visual) =>
      trace({
        visual,
        metric,
        comparison: false,
        stacked,
      }),
    );
  const plotTraces = [...currentTraces, ...comparisonTraces];
  if (!stacked && hover?.seriesKey != null) {
    const hoveredTraceIndex = plotTraces.findIndex((candidate) => {
      const traceMeta =
        "meta" in candidate
          ? (candidate.meta as MembershipAnalyticsTraceMeta)
          : undefined;
      return (
        traceMeta?.seriesKey === hover.seriesKey &&
        traceMeta?.comparison === hover.comparison
      );
    });
    const hoveredVisual = displayedVisuals.find(
      ({ series }) => series.key === hover.seriesKey,
    );
    if (hoveredTraceIndex >= 0 && hoveredVisual != null) {
      plotTraces.splice(hoveredTraceIndex, 1);
      plotTraces.push(
        trace({
          visual: hoveredVisual,
          metric,
          comparison: hover.comparison ?? false,
          stacked: false,
          halo: true,
        }),
        trace({
          visual: hoveredVisual,
          metric,
          comparison: hover.comparison ?? false,
          stacked: false,
          highlighted: true,
        }),
      );
    }
  }
  const hoverModel = hover
    ? buildMembershipAnalyticsHoverModel({
        day: hover.day,
        visuals: displayedVisuals,
        metric,
        includeComparison: comparisonLabel != null && view.comparisonAvailable,
      })
    : undefined;
  return (
    <>
      <Plot
        style={{ width: "100%" }}
        data={plotTraces}
        layout={{
          height: 320,
          hovermode: "x",
          margin: { l: 20, r: 75, t: 12, b: 45 },
          showlegend: false,
          shapes: hoverDay
            ? [
                {
                  type: "line",
                  x0: hoverDay,
                  x1: hoverDay,
                  y0: 0,
                  y1: 1,
                  yref: "paper",
                  line: { color: COLORS.GRAY, width: 1 },
                },
              ]
            : [],
          xaxis: { type: "date" },
          yaxis:
            metric === "revenue"
              ? {
                  rangemode: "tozero",
                  side: "right",
                  tickformat: ",.0f",
                  tickprefix: "$",
                }
              : {
                  rangemode: "tozero",
                  side: "right",
                  tickformat: ",.0f",
                },
        }}
        config={{ displayModeBar: false, responsive: true }}
        onHover={(event) => {
          const points = event?.points ?? [];
          const point =
            points[
              nearestMembershipAnalyticsHoverPointIndex(
                points,
                event?.yvals?.[0],
              )
            ];
          const day = point?.x;
          const pointer = event?.event;
          if (
            typeof day === "string" &&
            Number.isFinite(pointer?.clientX) &&
            Number.isFinite(pointer?.clientY)
          ) {
            const normalizedDay = day.slice(0, 10);
            const traceMeta = membershipAnalyticsTraceMeta(point?.data?.meta);
            setHover({
              day: normalizedDay,
              clientX: pointer.clientX,
              clientY: pointer.clientY,
              seriesKey: traceMeta?.seriesKey,
              comparison: traceMeta?.comparison,
            });
            onHoverDay(normalizedDay);
          }
        }}
        onUnhover={() => {
          setHover(undefined);
          onHoverDay(undefined);
        }}
      />
      {hover && hoverModel ? (
        <MembershipAnalyticsHoverOverlay
          hover={hover}
          model={hoverModel}
          metric={metric}
          chartMode={chartMode}
          highlightedKey={stacked ? undefined : hover.seriesKey}
          highlightedComparison={stacked ? undefined : hover.comparison}
        />
      ) : null}
    </>
  );
}
