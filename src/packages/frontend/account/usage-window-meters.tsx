/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Progress, Typography } from "antd";
import type { CSSProperties, ReactElement } from "react";

import { TimeAgo } from "@cocalc/frontend/components/time-ago";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const { Text } = Typography;

export type UsageWindowMeter = {
  key: string;
  label: string;
  remainingPercent?: number;
  resetAt?: Date;
};

const usageLimitStyle: CSSProperties = {
  background: UI_COLORS.surface,
  border: `1px solid ${UI_COLORS.border}`,
  borderRadius: 8,
  minWidth: 0,
  padding: 14,
};

const compactUsageLimitStyle: CSSProperties = {
  ...usageLimitStyle,
  padding: "8px 10px",
};

export function UsageWindowMeters({
  windows,
  compact = false,
  stale = false,
  updating = false,
  statusLabel = "usage",
}: {
  windows: UsageWindowMeter[];
  compact?: boolean;
  stale?: boolean;
  updating?: boolean;
  statusLabel?: string;
}): ReactElement | null {
  if (!windows.length) return null;
  const showStaleState = stale || updating;
  return (
    <div
      style={{
        display: "grid",
        gap: compact ? 8 : 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
        position: "relative",
        width: "100%",
      }}
    >
      {showStaleState ? (
        <div
          aria-label={
            updating ? `Updating ${statusLabel}` : `Stale ${statusLabel}`
          }
          style={{
            alignItems: "center",
            background: UI_COLORS.inset,
            border: `1px solid ${UI_COLORS.border}`,
            borderRadius: 999,
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.06)",
            display: "inline-flex",
            gap: 5,
            lineHeight: 1,
            padding: compact ? "3px 7px" : "4px 8px",
            pointerEvents: "none",
            position: "absolute",
            right: compact ? 6 : 10,
            top: compact ? 6 : 10,
            zIndex: 1,
          }}
        >
          <span
            style={{
              background: updating ? UI_COLORS.info : UI_COLORS.secondary,
              borderRadius: "50%",
              display: "inline-block",
              height: 6,
              width: 6,
            }}
          />
          <Text type="secondary" style={{ fontSize: compact ? 10 : 11 }}>
            {updating ? "Updating..." : "Stale"}
          </Text>
        </div>
      ) : null}
      {windows.map((window) => (
        <div
          key={window.key}
          style={{
            ...(compact ? compactUsageLimitStyle : usageLimitStyle),
            opacity: showStaleState ? 0.58 : 1,
            transition: "opacity 120ms ease",
          }}
        >
          <div
            style={{
              alignItems: "baseline",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              justifyContent: "space-between",
            }}
          >
            <Text style={{ fontSize: compact ? 12 : 14 }}>{window.label}</Text>
            {compact && window.resetAt ? (
              <Text type="secondary" style={{ fontSize: 11 }}>
                <TimeAgo date={window.resetAt} />
              </Text>
            ) : null}
          </div>
          {typeof window.remainingPercent === "number" ? (
            <>
              <div
                style={{
                  alignItems: "baseline",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: compact ? 4 : 6,
                  marginTop: compact ? 2 : 6,
                }}
              >
                <Text
                  strong
                  style={{
                    fontSize: compact ? 18 : 26,
                    lineHeight: compact ? "22px" : "30px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {`${window.remainingPercent}%`}
                </Text>
                <Text style={{ fontSize: compact ? 12 : 14 }}>Remaining</Text>
              </div>
              <Progress
                aria-label={`${window.label}: ${window.remainingPercent}% remaining`}
                percent={window.remainingPercent}
                showInfo={false}
                size="small"
                strokeColor={UI_COLORS.info}
                style={{ margin: compact ? "3px 0 0" : "6px 0 2px" }}
              />
            </>
          ) : null}
          {!compact ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Resets{" "}
              {window.resetAt ? (
                <TimeAgo date={window.resetAt} />
              ) : (
                "when the usage window resets"
              )}
            </Text>
          ) : null}
        </div>
      ))}
    </div>
  );
}
