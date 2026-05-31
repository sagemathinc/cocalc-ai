/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Empty,
  Modal,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  ManagedCpuAccountSummary,
  ManagedCpuAdminHistory,
  ManagedCpuAdminProjectSummary,
  ManagedCpuEventSummary,
  ManagedCpuHistoryBucketSize,
  ManagedCpuHistoryPoint,
} from "@cocalc/conat/hub/api/purchases";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import {
  getRangeSpec,
  getValidHistoryBuckets,
  nearestHistoryPointIndex,
  RANGE_SPECS,
  type ManagedEgressHistoryRangeKey,
} from "@cocalc/frontend/purchases/managed-egress-history";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;

function formatCpuSeconds(seconds: number): string {
  const hours = Math.max(0, Number(seconds) || 0) / 3600;
  let digits = 0;
  if (hours < 1) {
    digits = 3;
  } else if (hours < 10) {
    digits = 2;
  } else if (hours < 100) {
    digits = 1;
  }
  return `${hours.toFixed(digits)} CPU-hours`;
}

function formatAverageCpus(value: number): string {
  const cpus = Math.max(0, Number(value) || 0);
  let digits = 0;
  if (cpus < 1) {
    digits = 3;
  } else if (cpus < 10) {
    digits = 2;
  } else if (cpus < 100) {
    digits = 1;
  }
  return `${cpus.toFixed(digits)} average CPUs`;
}

function pointDurationSeconds(point: ManagedCpuHistoryPoint): number {
  const start = Date.parse(point.start);
  const end = Date.parse(point.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return (end - start) / 1000;
}

function averageCpusForPoint(point: ManagedCpuHistoryPoint): number {
  const seconds = pointDurationSeconds(point);
  return seconds > 0 ? Math.max(0, point.cpu_seconds ?? 0) / seconds : 0;
}

function bucketLabel(bucket: ManagedCpuHistoryBucketSize): string {
  switch (bucket) {
    case "5m":
      return "5-minute";
    case "1h":
      return "1-hour";
    case "1d":
      return "1-day";
  }
}

function bucketPeriodLabel(bucket: ManagedCpuHistoryBucketSize): string {
  switch (bucket) {
    case "5m":
      return "5 minutes";
    case "1h":
      return "1 hour";
    case "1d":
      return "1 day";
  }
}

function getAccountLabel(account: {
  account_id?: string;
  email_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  const fullName =
    `${account.first_name ?? ""} ${account.last_name ?? ""}`.trim();
  if (fullName && account.email_address) {
    return `${fullName} (${account.email_address})`;
  }
  return fullName || account.email_address || account.account_id || "";
}

function getProjectLabel(project: {
  project_id?: string | null;
  project_title?: string | null;
}): string {
  return `${project.project_title ?? project.project_id ?? ""}`.trim();
}

function xCoordinates(values: number[], width: number): number[] {
  if (values.length <= 1) return [width / 2];
  return values.map((_, i) => (i * width) / Math.max(1, values.length - 1));
}

function yCoordinates(values: number[], height: number): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return values.map((value) => {
    if (max === min) return height / 2;
    return height - ((value - min) / (max - min)) * (height - 16) - 8;
  });
}

function hoverPlacement(xFraction: number): {
  left: string;
  transform: string;
} {
  if (xFraction <= 0.18) {
    return {
      left: `${xFraction * 100}%`,
      transform: "translate(0, calc(-100% - 14px))",
    };
  }
  if (xFraction >= 0.82) {
    return {
      left: `${xFraction * 100}%`,
      transform: "translate(-100%, calc(-100% - 14px))",
    };
  }
  return {
    left: `${xFraction * 100}%`,
    transform: "translate(-50%, calc(-100% - 14px))",
  };
}

function summarizeCpuHistory(history: ManagedCpuAdminHistory): {
  latestAverageCpus: number;
  latestCpuSeconds: number;
  peakAverageCpus: number;
  peakCpuSeconds: number;
  averageCpus: number;
} {
  const points = history.points ?? [];
  const latestPoint = points.at(-1);
  const latestCpuSeconds = Math.max(0, latestPoint?.cpu_seconds ?? 0);
  const latestAverageCpus = latestPoint ? averageCpusForPoint(latestPoint) : 0;
  let peakAverageCpus = 0;
  let peakCpuSeconds = 0;
  for (const point of points) {
    const averageCpus = averageCpusForPoint(point);
    if (averageCpus > peakAverageCpus) {
      peakAverageCpus = averageCpus;
      peakCpuSeconds = Math.max(0, point.cpu_seconds ?? 0);
    }
  }
  const start = Date.parse(history.start);
  const end = Date.parse(history.end);
  const seconds =
    Number.isFinite(start) && Number.isFinite(end) && end > start
      ? (end - start) / 1000
      : 0;
  return {
    latestAverageCpus,
    latestCpuSeconds,
    peakAverageCpus,
    peakCpuSeconds,
    averageCpus: seconds > 0 ? history.total_cpu_seconds / seconds : 0,
  };
}

function CpuHistoryLine({
  history,
}: {
  history: ManagedCpuAdminHistory;
}): React.JSX.Element | null {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const points = history.points ?? [];
  if (points.length === 0) return null;
  const width = 560;
  const height = 160;
  const values = points.map(averageCpusForPoint);
  const xs = xCoordinates(values, width);
  const ys = yCoordinates(values, height);
  const coordinates = points.map((_, i) => ({ x: xs[i], y: ys[i] }));
  const polyline = xs
    .map((x, i) => `${x.toFixed(2)},${ys[i].toFixed(2)}`)
    .join(" ");
  const hoveredPoint =
    hoveredIndex != null ? coordinates[hoveredIndex] : undefined;
  const hoveredHistoryPoint: ManagedCpuHistoryPoint | undefined =
    hoveredIndex != null ? points[hoveredIndex] : undefined;
  const placement = hoveredPoint
    ? hoverPlacement(hoveredPoint.x / width)
    : undefined;

  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: "8px",
        marginBottom: "12px",
        padding: "14px",
      }}
    >
      <div
        onMouseLeave={() => setHoveredIndex(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width <= 0) return;
          const relativeX = Math.max(
            0,
            Math.min(1, (event.clientX - rect.left) / rect.width),
          );
          setHoveredIndex(
            nearestHistoryPointIndex(relativeX * width, coordinates),
          );
        }}
        style={{ cursor: "crosshair", position: "relative" }}
      >
        <svg
          aria-label="Managed CPU history"
          height="160"
          preserveAspectRatio="none"
          style={{ display: "block", width: "100%" }}
          viewBox={`0 0 ${width} ${height}`}
        >
          <polyline
            fill="none"
            points={polyline}
            stroke={COLORS.BLUE_D}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
          />
          {hoveredPoint ? (
            <>
              <line
                x1={hoveredPoint.x}
                x2={hoveredPoint.x}
                y1={0}
                y2={height}
                stroke={COLORS.BLUE_D}
                strokeOpacity="0.25"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <circle
                cx={hoveredPoint.x}
                cy={hoveredPoint.y}
                r="4"
                fill={COLORS.BLUE_D}
                stroke="white"
                strokeWidth="1.5"
              />
            </>
          ) : null}
        </svg>
        {hoveredPoint && hoveredHistoryPoint && placement ? (
          <div
            style={{
              background: "white",
              border: `1px solid ${COLORS.GRAY_LL}`,
              borderRadius: "8px",
              boxShadow: "0 6px 18px rgba(15, 23, 42, 0.16)",
              color: COLORS.GRAY_D,
              left: placement.left,
              maxWidth: "240px",
              padding: "8px 10px",
              pointerEvents: "none",
              position: "absolute",
              top: `${(hoveredPoint.y / height) * 100}%`,
              transform: placement.transform,
              zIndex: 1,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: "4px" }}>
              {formatAverageCpus(averageCpusForPoint(hoveredHistoryPoint))}
            </div>
            <div style={{ fontSize: "12px", marginBottom: "4px" }}>
              Usage in bucket:{" "}
              {formatCpuSeconds(hoveredHistoryPoint.cpu_seconds)}
            </div>
            <div style={{ fontSize: "12px" }}>
              {new Date(hoveredHistoryPoint.start).toLocaleString()}
              {" - "}
              {new Date(hoveredHistoryPoint.end).toLocaleString()}
            </div>
          </div>
        ) : null}
      </div>
      <div
        style={{
          color: COLORS.GRAY_M,
          display: "flex",
          fontSize: "12px",
          justifyContent: "space-between",
          marginTop: "4px",
        }}
      >
        <span>{new Date(history.start).toLocaleString()}</span>
        <span>{new Date(history.end).toLocaleString()}</span>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div style={{ minWidth: 160 }}>
      <Text strong>{label}</Text>
      <div style={{ fontSize: "20px", marginTop: "4px" }}>{value}</div>
      {detail ? (
        <div style={{ color: COLORS.GRAY_M, marginTop: "4px" }}>{detail}</div>
      ) : null}
    </div>
  );
}

function TopProjects({
  projects,
}: {
  projects: ManagedCpuAdminProjectSummary[];
}) {
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {projects.map((project) => (
        <div
          key={`${project.account_id}:${project.project_id ?? "none"}:${project.host_id ?? "none"}`}
        >
          <Text>{getProjectLabel(project) || "Account-wide CPU"}</Text>
          <Text type="secondary">
            {" "}
            · {formatCpuSeconds(project.cpu_seconds)}
            {project.host_id ? ` · host ${project.host_id}` : ""}
            {" · "}
            {getAccountLabel(project)}
          </Text>
        </div>
      ))}
    </Space>
  );
}

function TopAccounts({ accounts }: { accounts: ManagedCpuAccountSummary[] }) {
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {accounts.map((account) => (
        <div key={account.account_id}>
          <Text>{getAccountLabel(account)}</Text>
          <Text type="secondary">
            {" "}
            · {formatCpuSeconds(account.cpu_seconds)}
          </Text>
        </div>
      ))}
    </Space>
  );
}

function RecentEvents({ events }: { events: ManagedCpuEventSummary[] }) {
  if (events.length === 0) {
    return (
      <Alert showIcon type="info" message="No recent events in this window." />
    );
  }
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {events.map((event, i) => (
        <div
          key={`${event.account_id ?? "none"}:${event.project_id ?? "none"}:${event.sample_ended_at}:${i}`}
        >
          <Tag>{formatCpuSeconds(event.cpu_seconds)}</Tag>
          <Text>{getProjectLabel(event) || "Account-wide CPU"}</Text>
          {event.host_id ? (
            <Text type="secondary"> · {event.host_id}</Text>
          ) : null}
          <Text type="secondary">
            {" "}
            · {new Date(event.sample_ended_at).toLocaleString()}
          </Text>
        </div>
      ))}
    </Space>
  );
}

export function ManagedCpuHistoryButton({
  project_id,
  user_account_id,
  buttonText = "CPU history",
  size,
  type,
  style,
}: {
  project_id?: string;
  user_account_id?: string;
  buttonText?: string;
  size?: "small" | "middle" | "large";
  type?: "default" | "primary" | "dashed" | "link" | "text";
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size={size}
        type={type}
        style={style}
        onClick={() => setOpen(true)}
      >
        {buttonText}
      </Button>
      {open ? (
        <ManagedCpuHistoryModal
          open={open}
          onClose={() => setOpen(false)}
          project_id={project_id}
          user_account_id={user_account_id}
        />
      ) : null}
    </>
  );
}

export function ManagedCpuHistoryModal({
  project_id,
  user_account_id,
  open,
  onClose,
}: {
  project_id?: string;
  user_account_id?: string;
  open: boolean;
  onClose: () => void;
}) {
  const [rangeKey, setRangeKey] = useState<ManagedEgressHistoryRangeKey>("24h");
  const [bucket, setBucket] = useState<ManagedCpuHistoryBucketSize>("5m");
  const [history, setHistory] = useState<ManagedCpuAdminHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<any>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const requestKeyRef = useRef("");

  const validBuckets = useMemo(
    () => getValidHistoryBuckets(rangeKey),
    [rangeKey],
  );
  const effectiveBucket = validBuckets.includes(bucket)
    ? bucket
    : getRangeSpec(rangeKey).defaultBucket;

  useEffect(() => {
    if (!validBuckets.includes(bucket)) {
      setBucket(getRangeSpec(rangeKey).defaultBucket);
    }
  }, [bucket, rangeKey, validBuckets]);

  useEffect(() => {
    if (!open) return;
    const range = getRangeSpec(rangeKey);
    const end = new Date();
    const start = new Date(end.getTime() - range.durationMs);
    const requestKey = `${project_id ?? "all-projects"}:${user_account_id ?? "all-accounts"}:${rangeKey}:${effectiveBucket}:${reloadToken}`;
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError(null);
    void webapp_client.conat_client.hub.purchases
      .getManagedCpuAdminHistory({
        project_id,
        user_account_id,
        start: start.toISOString(),
        end: end.toISOString(),
        bucket: effectiveBucket,
        recent_event_limit: 20,
        top_account_limit: 10,
        top_project_limit: project_id ? 1 : 10,
      })
      .then((next) => {
        if (requestKeyRef.current !== requestKey) return;
        setHistory(next as ManagedCpuAdminHistory);
      })
      .catch((err) => {
        if (requestKeyRef.current !== requestKey) return;
        setError(err);
      })
      .finally(() => {
        if (requestKeyRef.current === requestKey) {
          setLoading(false);
        }
      });
  }, [
    effectiveBucket,
    open,
    project_id,
    rangeKey,
    reloadToken,
    user_account_id,
  ]);

  const summary = history ? summarizeCpuHistory(history) : null;
  const title = project_id
    ? "Project CPU history"
    : user_account_id
      ? "Account CPU history"
      : "Global CPU history";

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      width={760}
      closable={false}
      title={
        <span>
          <Icon name="tachometer-alt" /> {title}
        </span>
      }
    >
      <ShowError error={error} setError={setError} />
      <div
        style={{
          alignItems: "flex-start",
          display: "flex",
          gap: "16px",
          justifyContent: "space-between",
          marginBottom: "16px",
        }}
      >
        <div style={{ color: COLORS.GRAY_M, maxWidth: "520px" }}>
          Managed CPU is sampled from project-host process trees and attributed
          to accounts and projects. Spikes are review signals; they are not by
          themselves abuse verdicts.
        </div>
        <Button onClick={() => setReloadToken((value) => value + 1)}>
          Reload
        </Button>
      </div>
      <Space size={12} wrap style={{ marginBottom: "12px" }}>
        <Text strong>Range</Text>
        <Segmented
          options={RANGE_SPECS.map((range) => ({
            label: range.label,
            value: range.key,
          }))}
          onChange={(value) =>
            setRangeKey(value as ManagedEgressHistoryRangeKey)
          }
          value={rangeKey}
        />
        <Text strong>Bucket</Text>
        <Segmented
          options={validBuckets.map((value) => ({
            label: value,
            value,
          }))}
          onChange={(value) => setBucket(value as ManagedCpuHistoryBucketSize)}
          value={effectiveBucket}
        />
      </Space>
      {loading && history == null ? (
        <div style={{ padding: "24px 0", textAlign: "center" }}>
          <Spin />
        </div>
      ) : history == null ? (
        <Empty description="No CPU history yet." />
      ) : (
        <>
          <Space
            size={24}
            wrap
            style={{ display: "flex", marginBottom: "16px" }}
          >
            <SummaryCard
              label="Total usage"
              value={formatCpuSeconds(history.total_cpu_seconds)}
              detail={`${history.points.length} ${bucketLabel(effectiveBucket)} buckets`}
            />
            <SummaryCard
              label={`Latest avg CPU`}
              value={formatAverageCpus(summary?.latestAverageCpus ?? 0)}
              detail={`${formatCpuSeconds(summary?.latestCpuSeconds ?? 0)} in latest ${bucketPeriodLabel(effectiveBucket)} bucket`}
            />
            <SummaryCard
              label={`Peak avg CPU`}
              value={formatAverageCpus(summary?.peakAverageCpus ?? 0)}
              detail={`${formatCpuSeconds(summary?.peakCpuSeconds ?? 0)} in peak ${bucketPeriodLabel(effectiveBucket)} bucket`}
            />
            <SummaryCard
              label="Window avg CPU"
              value={formatAverageCpus(summary?.averageCpus ?? 0)}
            />
          </Space>
          <CpuHistoryLine history={history} />
          {!user_account_id && history.top_accounts.length > 0 ? (
            <div style={{ marginBottom: "16px" }}>
              <Text strong>Top accounts in this window</Text>
              <div style={{ marginTop: "6px" }}>
                <TopAccounts accounts={history.top_accounts} />
              </div>
            </div>
          ) : null}
          {history.top_projects.length > 0 ? (
            <div style={{ marginBottom: "16px" }}>
              <Text strong>Top projects in this window</Text>
              <div style={{ marginTop: "6px" }}>
                <TopProjects projects={history.top_projects} />
              </div>
            </div>
          ) : null}
          <div>
            <Space align="center" size={8} wrap>
              <Text strong>Recent samples</Text>
              <Tooltip title="These are the most recent raw CPU samples in the selected window. Quiet periods may have no samples even when earlier buckets show CPU usage.">
                <Text type="secondary">({history.recent_events.length})</Text>
              </Tooltip>
            </Space>
            <div
              style={{
                marginTop: "6px",
                maxHeight: "260px",
                overflowY: "auto",
              }}
            >
              <RecentEvents events={history.recent_events} />
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
