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
  ManagedEgressAccountSummary,
  ManagedEgressAdminHistory,
  ManagedEgressAdminProjectSummary,
  ManagedEgressHistory,
  ManagedEgressHistoryBucketSize,
} from "@cocalc/conat/hub/api/purchases";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import {
  ManagedEgressRecentEventsList,
  formatManagedEgressCategory,
} from "@cocalc/frontend/purchases/managed-egress-recent-events";
import { humanSize } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_HISTORY_BUCKETS = 2000;
const RECENT_SUMMARY_WINDOW_MS = 6 * HOUR_MS;
const RECENT_SUMMARY_REFRESH_MS = 60 * 1000;
const TOP_PROJECTS_SUMMARY_WINDOW_MS = 24 * HOUR_MS;
const TOP_PROJECTS_SUMMARY_REFRESH_MS = 5 * 60 * 1000;

export type ManagedEgressHistoryRangeKey = "6h" | "24h" | "7d" | "30d";

export type RangeSpec = {
  key: ManagedEgressHistoryRangeKey;
  label: string;
  durationMs: number;
  defaultBucket: ManagedEgressHistoryBucketSize;
};

export const RANGE_SPECS: RangeSpec[] = [
  { key: "6h", label: "6h", durationMs: 6 * HOUR_MS, defaultBucket: "5m" },
  {
    key: "24h",
    label: "24h",
    durationMs: 24 * HOUR_MS,
    defaultBucket: "5m",
  },
  { key: "7d", label: "7d", durationMs: 7 * DAY_MS, defaultBucket: "1h" },
  { key: "30d", label: "30d", durationMs: 30 * DAY_MS, defaultBucket: "1d" },
] as const;

const BUCKET_MS: Record<ManagedEgressHistoryBucketSize, number> = {
  "5m": 5 * 60 * 1000,
  "1h": HOUR_MS,
  "1d": DAY_MS,
};

type ChartableManagedEgressHistory = Pick<
  ManagedEgressHistory,
  "start" | "end" | "total_bytes" | "points"
>;
type ChartCoordinate = { x: number; y: number };

export function getRangeSpec(key: ManagedEgressHistoryRangeKey): RangeSpec {
  return RANGE_SPECS.find((range) => range.key === key) ?? RANGE_SPECS[1];
}

export function getValidHistoryBuckets(
  rangeKey: ManagedEgressHistoryRangeKey,
): ManagedEgressHistoryBucketSize[] {
  const range = getRangeSpec(rangeKey);
  return (["5m", "1h", "1d"] as ManagedEgressHistoryBucketSize[]).filter(
    (bucket) =>
      Math.ceil(range.durationMs / BUCKET_MS[bucket]) <= MAX_HISTORY_BUCKETS,
  );
}

function bucketLabel(bucket: ManagedEgressHistoryBucketSize): string {
  switch (bucket) {
    case "5m":
      return "5-minute";
    case "1h":
      return "1-hour";
    case "1d":
      return "1-day";
  }
}

function bucketPeriodLabel(bucket: ManagedEgressHistoryBucketSize): string {
  switch (bucket) {
    case "5m":
      return "5 minutes";
    case "1h":
      return "1 hour";
    case "1d":
      return "1 day";
  }
}

function categoryEntries(categories: Record<string, number>): Array<{
  category: string;
  bytes: number;
}> {
  return Object.entries(categories)
    .map(([category, bytes]) => ({
      category,
      bytes: Math.max(0, Number(bytes) || 0),
    }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes || a.category.localeCompare(b.category));
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

export function nearestHistoryPointIndex(
  x: number,
  coordinates: ChartCoordinate[],
): number | null {
  if (coordinates.length === 0) return null;
  let bestIndex = 0;
  let bestDistance = Math.abs(coordinates[0].x - x);
  for (let i = 1; i < coordinates.length; i += 1) {
    const distance = Math.abs(coordinates[i].x - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function historyHoverPlacement(xFraction: number): {
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

export function summarizeManagedEgressHistory(
  history: ChartableManagedEgressHistory,
): {
  latestBytes: number;
  peakBytes: number;
  avgBytesPerHour: number;
} {
  const points = history.points ?? [];
  const latestBytes = Math.max(0, points.at(-1)?.bytes ?? 0);
  const peakBytes = Math.max(0, ...points.map((point) => point.bytes ?? 0));
  const start = Date.parse(history.start);
  const end = Date.parse(history.end);
  const hours =
    Number.isFinite(start) && Number.isFinite(end) && end > start
      ? (end - start) / HOUR_MS
      : 0;
  return {
    latestBytes,
    peakBytes,
    avgBytesPerHour: hours > 0 ? history.total_bytes / hours : 0,
  };
}

function sumRecentBytes(
  points: ManagedEgressHistory["points"],
  endMs: number,
  windowMs: number,
): number {
  return (points ?? []).reduce((sum, point) => {
    const pointEndMs = Date.parse(point.end);
    if (!Number.isFinite(pointEndMs) || pointEndMs <= endMs - windowMs) {
      return sum;
    }
    return sum + Math.max(0, point.bytes ?? 0);
  }, 0);
}

export function summarizeManagedEgressRecentUsage(
  history: ChartableManagedEgressHistory,
): {
  last5MinutesBytes: number;
  lastHourBytes: number;
} {
  const points = history.points ?? [];
  const endMs = Date.parse(history.end);
  if (!Number.isFinite(endMs) || points.length === 0) {
    return { last5MinutesBytes: 0, lastHourBytes: 0 };
  }
  return {
    last5MinutesBytes: sumRecentBytes(points, endMs, 5 * 60 * 1000),
    lastHourBytes: sumRecentBytes(points, endMs, HOUR_MS),
  };
}

function HistoryLine({
  history,
}: {
  history: ChartableManagedEgressHistory;
}): React.JSX.Element | null {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const points = history.points ?? [];
  if (points.length === 0) return null;
  const width = 560;
  const height = 160;
  const values = points.map((point) => Math.max(0, point.bytes ?? 0));
  const xs = xCoordinates(values, width);
  const ys = yCoordinates(values, height);
  const coordinates = points.map((_, i) => ({ x: xs[i], y: ys[i] }));
  const polyline = xs
    .map((x, i) => `${x.toFixed(2)},${ys[i].toFixed(2)}`)
    .join(" ");
  const hoveredPoint =
    hoveredIndex != null ? coordinates[hoveredIndex] : undefined;
  const hoveredHistoryPoint =
    hoveredIndex != null ? points[hoveredIndex] : undefined;
  const hoverPlacement = hoveredPoint
    ? historyHoverPlacement(hoveredPoint.x / width)
    : undefined;
  const hoverCategories = hoveredHistoryPoint
    ? categoryEntries(hoveredHistoryPoint.categories_bytes).slice(0, 3)
    : [];
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
          aria-label="Managed egress history"
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
        {hoveredPoint && hoveredHistoryPoint && hoverPlacement ? (
          <div
            style={{
              background: "white",
              border: `1px solid ${COLORS.GRAY_LL}`,
              borderRadius: "8px",
              boxShadow: "0 6px 18px rgba(15, 23, 42, 0.16)",
              color: COLORS.GRAY_D,
              left: hoverPlacement.left,
              maxWidth: "240px",
              padding: "8px 10px",
              pointerEvents: "none",
              position: "absolute",
              top: `${(hoveredPoint.y / height) * 100}%`,
              transform: hoverPlacement.transform,
              zIndex: 1,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: "4px" }}>
              {humanSize(Math.max(0, hoveredHistoryPoint.bytes ?? 0))}
            </div>
            <div style={{ fontSize: "12px", marginBottom: "4px" }}>
              {new Date(hoveredHistoryPoint.start).toLocaleString()}
              {" - "}
              {new Date(hoveredHistoryPoint.end).toLocaleString()}
            </div>
            {hoverCategories.length > 0 ? (
              <div style={{ color: COLORS.GRAY_M, fontSize: "12px" }}>
                {hoverCategories.map((entry) => (
                  <div key={entry.category}>
                    {formatManagedEgressCategory(entry.category)}:{" "}
                    {humanSize(entry.bytes)}
                  </div>
                ))}
              </div>
            ) : null}
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

function EgressSummaryCard({
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

export function ManagedEgressHistoryButton({
  project_id,
  user_account_id,
  buttonText = "View egress history",
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
        <ManagedEgressHistoryModal
          open={open}
          onClose={() => setOpen(false)}
          project_id={project_id}
          user_account_id={user_account_id}
        />
      ) : null}
    </>
  );
}

export function ManagedEgressCompactButton({
  project_id,
  user_account_id,
  label = "Egress",
}: {
  project_id?: string;
  user_account_id?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const { error, history, loading } = useManagedEgressHistorySnapshot({
    project_id,
    user_account_id,
    durationMs: RECENT_SUMMARY_WINDOW_MS,
    bucket: "5m",
    recentEventLimit: 1,
    topProjectLimit: 1,
    refreshMs: RECENT_SUMMARY_REFRESH_MS,
  });

  let primary = "No recent egress";
  let secondary: string | undefined;
  if (loading && history == null) {
    primary = "Loading recent usage…";
  } else if (error && history == null) {
    primary = "Recent usage unavailable";
  } else if (history != null) {
    const recent = summarizeManagedEgressRecentUsage(history);
    primary = `${humanSize(recent.lastHourBytes)} / hour`;
    secondary = `5 min ${humanSize(recent.last5MinutesBytes)}`;
  }

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        style={{
          alignItems: "center",
          display: "flex",
          gap: "8px",
          height: "auto",
          justifyContent: "flex-start",
          padding: "4px 8px",
          textAlign: "left",
        }}
      >
        <Icon name="network" />
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <Space size={8} wrap>
            <Text strong>{label}</Text>
            <Text>{primary}</Text>
          </Space>
          {secondary ? (
            <div
              style={{
                color: COLORS.GRAY_D,
                fontSize: "12px",
                lineHeight: 1.35,
                marginTop: "2px",
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {secondary}
            </div>
          ) : null}
        </div>
      </Button>
      {open ? (
        <ManagedEgressHistoryModal
          open={open}
          onClose={() => setOpen(false)}
          project_id={project_id}
          user_account_id={user_account_id}
        />
      ) : null}
    </>
  );
}

export function ManagedEgressAdminHistoryButton({
  buttonText = "Global history",
  initialRangeKey = "24h",
  size,
  type,
}: {
  buttonText?: string;
  initialRangeKey?: ManagedEgressHistoryRangeKey;
  size?: "small" | "middle" | "large";
  type?: "default" | "primary" | "dashed" | "link" | "text";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} type={type} onClick={() => setOpen(true)}>
        {buttonText}
      </Button>
      {open ? (
        <ManagedEgressAdminHistoryModal
          open={open}
          onClose={() => setOpen(false)}
          initialRangeKey={initialRangeKey}
        />
      ) : null}
    </>
  );
}

function useManagedEgressHistorySnapshot({
  project_id,
  user_account_id,
  durationMs,
  bucket,
  recentEventLimit,
  topProjectLimit,
  refreshMs,
}: {
  project_id?: string;
  user_account_id?: string;
  durationMs: number;
  bucket: ManagedEgressHistoryBucketSize;
  recentEventLimit: number;
  topProjectLimit: number;
  refreshMs: number;
}) {
  const [history, setHistory] = useState<ManagedEgressHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const requestKeyRef = useRef("");
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const end = new Date();
      const start = new Date(end.getTime() - durationMs);
      const requestKey = `${project_id ?? "account"}:${user_account_id ?? "self"}:${bucket}:${end.getTime()}`;
      requestKeyRef.current = requestKey;
      setError(null);
      if (!loadedOnceRef.current) {
        setLoading(true);
      }
      try {
        const next =
          (await webapp_client.conat_client.hub.purchases.getManagedEgressHistory(
            {
              project_id,
              user_account_id,
              start: start.toISOString(),
              end: end.toISOString(),
              bucket,
              recent_event_limit: recentEventLimit,
              top_project_limit: topProjectLimit,
            },
          )) as ManagedEgressHistory;
        if (cancelled || requestKeyRef.current !== requestKey) return;
        loadedOnceRef.current = true;
        setHistory(next);
      } catch (err) {
        if (cancelled || requestKeyRef.current !== requestKey) return;
        setError(err);
      } finally {
        if (!cancelled && requestKeyRef.current === requestKey) {
          setLoading(false);
        }
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, refreshMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    bucket,
    durationMs,
    project_id,
    recentEventLimit,
    refreshMs,
    topProjectLimit,
    user_account_id,
  ]);

  return { error, history, loading };
}

export function ManagedEgressRateSummary({
  project_id,
  user_account_id,
}: {
  project_id?: string;
  user_account_id?: string;
}) {
  const { error, history, loading } = useManagedEgressHistorySnapshot({
    project_id,
    user_account_id,
    durationMs: RECENT_SUMMARY_WINDOW_MS,
    bucket: "5m",
    recentEventLimit: 1,
    topProjectLimit: 1,
    refreshMs: RECENT_SUMMARY_REFRESH_MS,
  });

  if (loading && history == null) {
    return <Text type="secondary">Loading recent rates…</Text>;
  }
  if (error && history == null) {
    return <Text type="secondary">Recent rates unavailable.</Text>;
  }
  if (history == null) {
    return <Text type="secondary">No recent managed egress.</Text>;
  }

  const recent = summarizeManagedEgressRecentUsage(history);
  return (
    <Text type="secondary">
      Recent usage: {humanSize(recent.last5MinutesBytes)} in the last 5 minutes
      {" · "}
      {humanSize(recent.lastHourBytes)} in the last hour
    </Text>
  );
}

export function ManagedEgressSparkline({
  project_id,
  user_account_id,
  height = 28,
}: {
  project_id?: string;
  user_account_id?: string;
  height?: number;
}) {
  const { error, history, loading } = useManagedEgressHistorySnapshot({
    project_id,
    user_account_id,
    durationMs: RECENT_SUMMARY_WINDOW_MS,
    bucket: "5m",
    recentEventLimit: 1,
    topProjectLimit: 1,
    refreshMs: RECENT_SUMMARY_REFRESH_MS,
  });

  if (loading && history == null) {
    return <Text type="secondary">Loading...</Text>;
  }
  if (error && history == null) {
    return <Text type="secondary">Unavailable</Text>;
  }
  if (history == null || history.points.length === 0) {
    return <Text type="secondary">No recent egress</Text>;
  }

  const width = 120;
  const values = history.points.map((point) => Math.max(0, point.bytes ?? 0));
  const xs = xCoordinates(values, width);
  const ys = yCoordinates(values, height);
  const polyline = xs
    .map((x, i) => `${x.toFixed(2)},${ys[i].toFixed(2)}`)
    .join(" ");
  const recent = summarizeManagedEgressRecentUsage(history);

  return (
    <Space direction="vertical" size={2} style={{ width: "100%" }}>
      <svg
        aria-label="Recent managed egress"
        height={height}
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
          strokeWidth="2.5"
        />
      </svg>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {humanSize(recent.lastHourBytes)} last hour
      </Text>
    </Space>
  );
}

export function ManagedEgressTopProjectsSummary({
  user_account_id,
  limit = 5,
}: {
  user_account_id?: string;
  limit?: number;
}) {
  const { error, history, loading } = useManagedEgressHistorySnapshot({
    user_account_id,
    durationMs: TOP_PROJECTS_SUMMARY_WINDOW_MS,
    bucket: "1h",
    recentEventLimit: 1,
    topProjectLimit: limit,
    refreshMs: TOP_PROJECTS_SUMMARY_REFRESH_MS,
  });

  if (loading && history == null) {
    return <Text type="secondary">Loading top projects…</Text>;
  }
  if (error && history == null) {
    return <Text type="secondary">Top project summary unavailable.</Text>;
  }
  if (history == null || history.top_projects.length === 0) {
    return (
      <Text type="secondary">
        No project-attributed egress in the last 24 hours.
      </Text>
    );
  }

  return (
    <Space direction="vertical" size={4} style={{ width: "100%" }}>
      {history.top_projects.map((project, i) => (
        <div key={`${project.project_id ?? "none"}-${i}`}>
          <Text>
            {project.project_title ??
              project.project_id ??
              "Account-wide session traffic"}
          </Text>
          <Text type="secondary"> · {humanSize(project.bytes)}</Text>
        </div>
      ))}
    </Space>
  );
}

function AdminTopAccounts({
  accounts,
}: {
  accounts: ManagedEgressAccountSummary[];
}) {
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {accounts.map((account) => (
        <div key={account.account_id}>
          <Text>
            {`${account.first_name ?? ""} ${account.last_name ?? ""}`.trim() ||
              account.email_address ||
              account.account_id}
          </Text>
          <Text type="secondary">
            {" "}
            · {humanSize(account.bytes)}
            {account.email_address ? ` · ${account.email_address}` : ""}
          </Text>
        </div>
      ))}
    </Space>
  );
}

function AdminTopProjects({
  projects,
}: {
  projects: ManagedEgressAdminProjectSummary[];
}) {
  return (
    <Space direction="vertical" size={6} style={{ width: "100%" }}>
      {projects.map((project) => (
        <div key={`${project.account_id}:${project.project_id ?? "none"}`}>
          <Text>
            {project.project_title ??
              project.project_id ??
              "Account-wide session traffic"}
          </Text>
          <Text type="secondary">
            {" "}
            · {humanSize(project.bytes)}
            {" · "}
            {`${project.first_name ?? ""} ${project.last_name ?? ""}`.trim() ||
              project.email_address ||
              project.account_id}
          </Text>
        </div>
      ))}
    </Space>
  );
}

export function ManagedEgressHistoryModal({
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
  const [bucket, setBucket] = useState<ManagedEgressHistoryBucketSize>("5m");
  const [history, setHistory] = useState<ManagedEgressHistory | null>(null);
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
    const requestKey = `${project_id ?? "account"}:${user_account_id ?? "self"}:${rangeKey}:${effectiveBucket}:${reloadToken}`;
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError(null);
    void webapp_client.conat_client.hub.purchases
      .getManagedEgressHistory({
        project_id,
        user_account_id,
        start: start.toISOString(),
        end: end.toISOString(),
        bucket: effectiveBucket,
        recent_event_limit: 20,
        top_project_limit: project_id ? 1 : 10,
      })
      .then((next) => {
        if (requestKeyRef.current !== requestKey) return;
        setHistory(next as ManagedEgressHistory);
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

  const summary = history ? summarizeManagedEgressHistory(history) : null;
  const categoryTotals = history
    ? categoryEntries(history.categories_bytes)
    : [];
  const modalTitle = project_id
    ? "Project network egress"
    : "Account network egress";

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      width={760}
      closable={false}
      title={
        <span>
          <Icon name="network" /> {modalTitle}
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
          Managed egress includes metered outbound traffic attributed to this{" "}
          {project_id ? "project" : "account"}, including shared-host downloads,
          proxy traffic, interactive sessions, SSH, and raw outbound network
          usage on supported hosts.
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
          onChange={(value) =>
            setBucket(value as ManagedEgressHistoryBucketSize)
          }
          value={effectiveBucket}
        />
      </Space>
      {loading && history == null ? (
        <div style={{ padding: "24px 0", textAlign: "center" }}>
          <Spin />
        </div>
      ) : history == null ? (
        <Empty description="No egress history yet." />
      ) : (
        <>
          <Space
            size={24}
            wrap
            style={{ display: "flex", marginBottom: "16px" }}
          >
            <EgressSummaryCard
              label="Total usage"
              value={humanSize(history.total_bytes)}
              detail={`${history.points.length} ${bucketLabel(effectiveBucket)} buckets`}
            />
            <EgressSummaryCard
              label={`Latest ${bucketPeriodLabel(effectiveBucket)}`}
              value={humanSize(summary?.latestBytes ?? 0)}
            />
            <EgressSummaryCard
              label={`Peak ${bucketPeriodLabel(effectiveBucket)}`}
              value={humanSize(summary?.peakBytes ?? 0)}
            />
            <EgressSummaryCard
              label="Average rate"
              value={`${humanSize(summary?.avgBytesPerHour ?? 0)}/h`}
            />
          </Space>
          <HistoryLine history={history} />
          <div style={{ marginBottom: "16px" }}>
            <Text strong>Traffic categories</Text>
            <div style={{ marginTop: "6px" }}>
              {categoryTotals.length === 0 ? (
                <Text type="secondary">No category totals recorded.</Text>
              ) : (
                <Space wrap>
                  {categoryTotals.map((entry) => (
                    <Tag key={entry.category}>
                      {formatManagedEgressCategory(entry.category)}:{" "}
                      {humanSize(entry.bytes)}
                    </Tag>
                  ))}
                </Space>
              )}
            </div>
          </div>
          {!project_id && history.top_projects.length > 0 ? (
            <div style={{ marginBottom: "16px" }}>
              <Text strong>Top projects in this window</Text>
              <div style={{ marginTop: "6px" }}>
                <Space direction="vertical" size={6} style={{ width: "100%" }}>
                  {history.top_projects.map((project, i) => (
                    <div key={`${project.project_id ?? "none"}-${i}`}>
                      <Text>
                        {project.project_title ??
                          project.project_id ??
                          "Account-wide session traffic"}
                      </Text>
                      <Text type="secondary">
                        {" "}
                        · {humanSize(project.bytes)}
                      </Text>
                    </div>
                  ))}
                </Space>
              </div>
            </div>
          ) : null}
          <div>
            <Space align="center" size={8} wrap>
              <Text strong>Recent events</Text>
              <Tooltip title="These are the most recent raw egress events in the selected window. Quiet periods may have no events even when earlier buckets show traffic.">
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
              {history.recent_events.length === 0 ? (
                <Alert
                  showIcon
                  type="info"
                  message="No recent events in this window."
                />
              ) : (
                <ManagedEgressRecentEventsList events={history.recent_events} />
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

export function ManagedEgressAdminHistoryModal({
  open,
  onClose,
  initialRangeKey = "24h",
}: {
  open: boolean;
  onClose: () => void;
  initialRangeKey?: ManagedEgressHistoryRangeKey;
}) {
  const [rangeKey, setRangeKey] =
    useState<ManagedEgressHistoryRangeKey>(initialRangeKey);
  const [bucket, setBucket] = useState<ManagedEgressHistoryBucketSize>(
    getRangeSpec(initialRangeKey).defaultBucket,
  );
  const [history, setHistory] = useState<ManagedEgressAdminHistory | null>(
    null,
  );
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
    const requestKey = `admin:${rangeKey}:${effectiveBucket}:${reloadToken}`;
    requestKeyRef.current = requestKey;
    setLoading(true);
    setError(null);
    void webapp_client.conat_client.hub.purchases
      .getManagedEgressAdminHistory({
        start: start.toISOString(),
        end: end.toISOString(),
        bucket: effectiveBucket,
        recent_event_limit: 20,
        top_account_limit: 10,
        top_project_limit: 10,
      })
      .then((next) => {
        if (requestKeyRef.current !== requestKey) return;
        setHistory(next as ManagedEgressAdminHistory);
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
  }, [effectiveBucket, open, rangeKey, reloadToken]);

  const summary = history ? summarizeManagedEgressHistory(history) : null;
  const categoryTotals = history
    ? categoryEntries(history.categories_bytes)
    : [];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      width={860}
      closable={false}
      title={
        <span>
          <Icon name="network" /> Global network egress
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
        <div style={{ color: COLORS.GRAY_M, maxWidth: "620px" }}>
          Managed egress across all accounts, including shared-host downloads,
          proxy traffic, interactive sessions, SSH, and raw outbound network
          usage on supported hosts.
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
          onChange={(value) =>
            setBucket(value as ManagedEgressHistoryBucketSize)
          }
          value={effectiveBucket}
        />
      </Space>
      {loading && history == null ? (
        <div style={{ padding: "24px 0", textAlign: "center" }}>
          <Spin />
        </div>
      ) : history == null ? (
        <Empty description="No global egress history yet." />
      ) : (
        <>
          <Space
            size={24}
            wrap
            style={{ display: "flex", marginBottom: "16px" }}
          >
            <EgressSummaryCard
              label="Total usage"
              value={humanSize(history.total_bytes)}
              detail={`${history.points.length} ${bucketLabel(effectiveBucket)} buckets`}
            />
            <EgressSummaryCard
              label={`Latest ${bucketPeriodLabel(effectiveBucket)}`}
              value={humanSize(summary?.latestBytes ?? 0)}
            />
            <EgressSummaryCard
              label={`Peak ${bucketPeriodLabel(effectiveBucket)}`}
              value={humanSize(summary?.peakBytes ?? 0)}
            />
            <EgressSummaryCard
              label="Average rate"
              value={`${humanSize(summary?.avgBytesPerHour ?? 0)}/h`}
            />
          </Space>
          <HistoryLine history={history} />
          <div style={{ marginBottom: "16px" }}>
            <Text strong>Traffic categories</Text>
            <div style={{ marginTop: "6px" }}>
              {categoryTotals.length === 0 ? (
                <Text type="secondary">No category totals recorded.</Text>
              ) : (
                <Space wrap>
                  {categoryTotals.map((entry) => (
                    <Tag key={entry.category}>
                      {formatManagedEgressCategory(entry.category)}:{" "}
                      {humanSize(entry.bytes)}
                    </Tag>
                  ))}
                </Space>
              )}
            </div>
          </div>
          {history.top_accounts.length > 0 ? (
            <div style={{ marginBottom: "16px" }}>
              <Text strong>Top accounts in this window</Text>
              <div style={{ marginTop: "6px" }}>
                <AdminTopAccounts accounts={history.top_accounts} />
              </div>
            </div>
          ) : null}
          {history.top_projects.length > 0 ? (
            <div style={{ marginBottom: "16px" }}>
              <Text strong>Top projects in this window</Text>
              <div style={{ marginTop: "6px" }}>
                <AdminTopProjects projects={history.top_projects} />
              </div>
            </div>
          ) : null}
          <div>
            <Space align="center" size={8} wrap>
              <Text strong>Recent events</Text>
              <Tooltip title="These are the most recent raw egress events in the selected window. Quiet periods may have no events even when earlier buckets show traffic.">
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
              {history.recent_events.length === 0 ? (
                <Alert
                  showIcon
                  type="info"
                  message="No recent events in this window."
                />
              ) : (
                <ManagedEgressRecentEventsList events={history.recent_events} />
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
