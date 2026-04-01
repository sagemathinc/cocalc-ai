import dust from "./dust";
import getStorageHistory from "./storage-history";
import getStorageOverview from "./storage-overview";
import useDiskUsage, {
  type DiskUsageTree,
  type StorageVisibleSummary,
} from "./use-disk-usage";
import {
  Alert,
  Breadcrumb,
  Button,
  Modal,
  Progress,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import ShowError from "@cocalc/frontend/components/error";
import type {
  ProjectStorageHistory,
  ProjectStorageHistoryPoint,
} from "@cocalc/conat/hub/api/projects";
import { human_readable_size } from "@cocalc/util/misc";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { redux, useAsyncEffect } from "@cocalc/frontend/app-framework";
import { dirname, posix } from "path";
import { COLORS } from "@cocalc/util/theme";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";

const { Text } = Typography;
type VisibleBucketKey = StorageVisibleSummary["key"];
type DrillSelection = { bucketKey: VisibleBucketKey; path: string };
type StorageAnnotation = {
  label: string;
  detail: string;
  tone?: "warning" | "info";
};
type StorageHistoryMetricKey =
  | "quota"
  | "home"
  | "scratch"
  | "environment"
  | "snapshots";
type HistorySeriesPoint = { collected_at: string; value: number };

const HISTORY_MAX_POINTS = 96;
const HISTORY_WINDOW_OPTIONS = [
  { label: "6h", value: 6 * 60 },
  { label: "24h", value: 24 * 60 },
  { label: "7d", value: 7 * 24 * 60 },
] as const;

function bucketPercent(bytes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((100 * bytes) / total);
}

function relativeLabel(bucket: StorageVisibleSummary): string {
  return bucket.summaryLabel;
}

function isWithinPath(root: string, candidate?: string): boolean {
  if (!candidate) return false;
  const normalizedRoot = posix.normalize(root);
  const normalizedCandidate = posix.normalize(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

export function suggestFindSpaceSelection(
  visible: StorageVisibleSummary[],
  currentPath?: string,
): DrillSelection | undefined {
  if (!currentPath) return;
  for (const key of ["scratch", "environment", "home"] as VisibleBucketKey[]) {
    const bucket = visible.find((candidate) => candidate.key === key);
    if (!bucket) continue;
    if (isWithinPath(bucket.path, currentPath)) {
      return { bucketKey: bucket.key, path: currentPath };
    }
  }
}

function environmentOverlayPath(bucket: StorageVisibleSummary): string {
  return bucket.key === "environment"
    ? bucket.path
    : posix.join(bucket.path, ".local/share/cocalc/rootfs");
}

export function getStorageAnnotation(
  bucket: StorageVisibleSummary,
  absolutePath: string,
): StorageAnnotation | undefined {
  const normalizedPath = posix.normalize(absolutePath);
  const environmentRoot = environmentOverlayPath(bucket);
  if (
    bucket.key === "environment" &&
    isWithinPath(environmentRoot, normalizedPath)
  ) {
    return {
      label: "Environment overlay",
      detail:
        "Writable software and system changes live here. Deleting this blindly can break the environment.",
      tone: "warning",
    };
  }
  if (isWithinPath(environmentRoot, normalizedPath)) {
    return {
      label: "Environment data",
      detail:
        "This path stores writable root filesystem changes and related runtime metadata. Deleting it blindly can break installed software.",
      tone: "warning",
    };
  }
  const base = posix.basename(normalizedPath);
  if (
    [
      ".cache",
      ".npm",
      ".cargo",
      ".pnpm-store",
      ".ivy2",
      ".m2",
      ".rustup",
    ].includes(base)
  ) {
    return {
      label: "Cache-like data",
      detail:
        "Often a reasonable place to review for cleanup, though you may need to rebuild or redownload data later.",
      tone: "info",
    };
  }
  if (bucket.key === "scratch") {
    return {
      label: "Scratch storage",
      detail:
        "Scratch is temporary project storage. Cleaning it is often safe if no running process still needs the data.",
      tone: "info",
    };
  }
}

function pathSegments(rootPath: string, currentPath: string): string[] {
  const normalizedRoot = posix.normalize(rootPath);
  const normalizedCurrent = posix.normalize(currentPath);
  if (!isWithinPath(normalizedRoot, normalizedCurrent)) {
    return [normalizedRoot];
  }
  if (normalizedRoot === normalizedCurrent) {
    return [normalizedRoot];
  }
  const suffix = normalizedCurrent.slice(normalizedRoot.length + 1);
  const segments = suffix.split("/").filter(Boolean);
  const result = [normalizedRoot];
  let current = normalizedRoot;
  for (const segment of segments) {
    current = posix.join(current, segment);
    result.push(current);
  }
  return result;
}

function labelForSegment(bucket: StorageVisibleSummary, path: string): string {
  if (path === bucket.path) return relativeLabel(bucket);
  return posix.basename(path);
}

function historyMetricLabel(metric: StorageHistoryMetricKey): string {
  switch (metric) {
    case "quota":
      return "Quota";
    case "home":
      return "Home";
    case "scratch":
      return "Scratch";
    case "environment":
      return "Environment";
    case "snapshots":
      return "Snapshots";
  }
}

function historyMetricValue(
  point: ProjectStorageHistoryPoint,
  metric: StorageHistoryMetricKey,
): number | undefined {
  switch (metric) {
    case "quota":
      return point.quota_used_bytes;
    case "home":
      return point.home_visible_bytes;
    case "scratch":
      return point.scratch_visible_bytes;
    case "environment":
      return point.environment_visible_bytes;
    case "snapshots":
      return point.snapshot_counted_bytes;
  }
}

function collectHistorySeries(
  history: ProjectStorageHistory | null,
  metric: StorageHistoryMetricKey,
): HistorySeriesPoint[] {
  if (!history) return [];
  const result: HistorySeriesPoint[] = [];
  for (const point of history.points) {
    const value = historyMetricValue(point, metric);
    if (value == null || !Number.isFinite(value)) continue;
    result.push({ collected_at: point.collected_at, value });
  }
  return result.sort((left, right) => {
    const leftAt = Date.parse(left.collected_at);
    const rightAt = Date.parse(right.collected_at);
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt)) {
      return leftAt - rightAt;
    }
    if (Number.isFinite(leftAt)) return -1;
    if (Number.isFinite(rightAt)) return 1;
    return left.collected_at.localeCompare(right.collected_at);
  });
}

function historyMetricAvailable(
  history: ProjectStorageHistory | null,
  metric: StorageHistoryMetricKey,
): boolean {
  return collectHistorySeries(history, metric).length > 0;
}

function chartYCoordinates(values: number[], height: number): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) {
    return [height / 2];
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const y = (value: number) => {
    if (max === min) return height / 2;
    return height - ((value - min) / (max - min)) * (height - 12) - 6;
  };
  return values.map((value) => y(value));
}

function chartXCoordinates(timestamps: number[], width = 560): number[] {
  if (timestamps.length === 0) return [];
  if (timestamps.length === 1) return [width / 2];
  const valid = timestamps.filter((timestamp) => Number.isFinite(timestamp));
  if (valid.length !== timestamps.length) {
    return timestamps.map(
      (_, i) => (i * width) / Math.max(1, timestamps.length - 1),
    );
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  if (max <= min) {
    return timestamps.map(
      (_, i) => (i * width) / Math.max(1, timestamps.length - 1),
    );
  }
  return timestamps.map(
    (timestamp) => ((timestamp - min) / (max - min)) * width,
  );
}

export function historyLineCoordinates(
  points: HistorySeriesPoint[],
  width = 560,
  height = 160,
): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const xCoordinates = chartXCoordinates(
    points.map((point) => Date.parse(point.collected_at)),
    width,
  );
  const yCoordinates = chartYCoordinates(
    points.map((point) => point.value),
    height,
  );
  return points.map((_, i) => ({
    x: xCoordinates[i],
    y: yCoordinates[i],
  }));
}

function historyLinePoints(coordinates: { x: number; y: number }[]): string {
  return coordinates
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

export function nearestCoordinateIndex(
  x: number,
  coordinates: { x: number; y: number }[],
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

function formatSignedSize(bytes: number): string {
  const sign = bytes > 0 ? "+" : bytes < 0 ? "-" : "";
  return `${sign}${human_readable_size(Math.abs(bytes))}`;
}

function formatHistoryWindow(windowMinutes: number): string {
  if (windowMinutes % (24 * 60) === 0) {
    const days = windowMinutes / (24 * 60);
    return days === 1 ? "24 hours" : `${days} days`;
  }
  if (windowMinutes % 60 === 0) {
    const hours = windowMinutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${windowMinutes} minutes`;
}

function historyMetricColor(metric: StorageHistoryMetricKey): string {
  switch (metric) {
    case "quota":
      return COLORS.BLUE_D;
    case "home":
      return COLORS.BS_GREEN_D;
    case "scratch":
      return COLORS.BLUE;
    case "environment":
      return COLORS.ORANGE_WARN;
    case "snapshots":
      return COLORS.ANTD_RED;
  }
}

function renderDrillError(
  error: any,
  setError?: (error: any) => void,
): ReactNode {
  if (!error) return null;
  const message = `${error}`.replace(/Error:/g, "").trim();
  if (/disk usage scan .* took too long/i.test(message)) {
    return (
      <Alert
        closable={setError != null}
        description={message}
        message="Folder too large for a quick scan"
        onClose={() => setError?.("")}
        showIcon
        style={{ marginBottom: "12px" }}
        type="warning"
      />
    );
  }
  return <ShowError error={error} setError={setError} />;
}

function historyTooltip({
  metric,
  point,
  quotaSizeBytes,
}: {
  metric: StorageHistoryMetricKey;
  point: HistorySeriesPoint;
  quotaSizeBytes?: number;
}): ReactNode {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{historyMetricLabel(metric)}</div>
      <div>{human_readable_size(point.value)}</div>
      {metric === "quota" &&
        quotaSizeBytes != null &&
        Number.isFinite(quotaSizeBytes) && (
          <div>
            {Math.round((100 * point.value) / Math.max(1, quotaSizeBytes))}% of{" "}
            {human_readable_size(quotaSizeBytes)}
          </div>
        )}
      <div>{new Date(point.collected_at).toLocaleString()}</div>
    </div>
  );
}

function HistorySparkline({
  metric,
  points,
  quotaSizeBytes,
}: {
  metric: StorageHistoryMetricKey;
  points: HistorySeriesPoint[];
  quotaSizeBytes?: number;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const chartWidth = 560;
  const chartHeight = 160;
  if (points.length < 2) return null;
  const coordinates = historyLineCoordinates(points, chartWidth, chartHeight);
  const hoveredPoint =
    hoveredIndex != null ? coordinates[hoveredIndex] : undefined;
  return (
    <div
      style={{
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: "8px",
        marginBottom: "12px",
        padding: "14px",
        position: "relative",
        width: "100%",
        cursor: "crosshair",
      }}
      onMouseLeave={() => setHoveredIndex(null)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const relativeX = Math.max(
          0,
          Math.min(1, (event.clientX - rect.left) / rect.width),
        );
        setHoveredIndex(
          nearestCoordinateIndex(relativeX * chartWidth, coordinates),
        );
      }}
    >
      <svg
        aria-label={`${historyMetricLabel(metric)} history`}
        height="160"
        style={{ display: "block", width: "100%" }}
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        preserveAspectRatio="none"
      >
        <polyline
          fill="none"
          points={historyLinePoints(coordinates)}
          stroke={historyMetricColor(metric)}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
        />
        {hoveredPoint && (
          <>
            <line
              x1={hoveredPoint.x}
              x2={hoveredPoint.x}
              y1={0}
              y2={chartHeight}
              stroke={historyMetricColor(metric)}
              strokeOpacity="0.25"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle
              cx={hoveredPoint.x}
              cy={hoveredPoint.y}
              r="4"
              fill={historyMetricColor(metric)}
              stroke="white"
              strokeWidth="1.5"
            />
          </>
        )}
      </svg>
      <div
        style={{
          color: COLORS.GRAY_M,
          display: "flex",
          fontSize: "12px",
          justifyContent: "space-between",
          marginTop: "4px",
        }}
      >
        <span>{new Date(points[0].collected_at).toLocaleString()}</span>
        <span>
          {new Date(points.at(-1)?.collected_at ?? "").toLocaleString()}
        </span>
      </div>
      {hoveredPoint && hoveredIndex != null && (
        <div
          style={{
            position: "absolute",
            left: `${(hoveredPoint.x / chartWidth) * 100}%`,
            top: `${(hoveredPoint.y / chartHeight) * 100}%`,
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
          }}
        >
          <Tooltip
            open
            title={historyTooltip({
              metric,
              point: points[hoveredIndex],
              quotaSizeBytes,
            })}
            placement="top"
          >
            <div style={{ width: 1, height: 1 }} />
          </Tooltip>
        </div>
      )}
    </div>
  );
}

export default function DiskUsage({
  project_id,
  style,
  compact = false,
  current_path,
}: {
  project_id: string;
  style?;
  compact?: boolean;
  current_path?: string;
}) {
  const [expand, setExpand] = useState<boolean>(false);
  const [activePanel, setActivePanel] = useState<"overview" | "history">(
    "overview",
  );
  const { visible, counted, loading, error, setError, refresh, quotas } =
    useDiskUsage({
      project_id,
    });
  const [selectedBucketKey, setSelectedBucketKey] =
    useState<VisibleBucketKey>("home");
  const [drillPathByBucket, setDrillPathByBucket] = useState<
    Partial<Record<VisibleBucketKey, string>>
  >({});
  const [drillUsage, setDrillUsage] = useState<DiskUsageTree | null>(null);
  const [drillLoading, setDrillLoading] = useState<boolean>(false);
  const [drillError, setDrillError] = useState<any>(null);
  const [drillCounter, setDrillCounter] = useState<number>(0);
  const lastDrillCounterRef = useRef<number>(0);
  const drillRequestKeyRef = useRef<string>("");
  const [historyWindow, setHistoryWindow] = useState<number>(24 * 60);
  const [historyMetric, setHistoryMetric] =
    useState<StorageHistoryMetricKey>("quota");
  const [history, setHistory] = useState<ProjectStorageHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [historyError, setHistoryError] = useState<any>(null);
  const [historyCounter, setHistoryCounter] = useState<number>(0);
  const lastHistoryCounterRef = useRef<number>(0);
  const historyRequestKeyRef = useRef<string>("");
  const [reloadPending, setReloadPending] = useState<boolean>(false);
  const [reloadStatus, setReloadStatus] = useState<string>("");
  const reloadStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const prevExpandRef = useRef<boolean>(false);
  const quota = quotas[0] ?? null;

  const selectedBucket =
    visible.find((bucket) => bucket.key === selectedBucketKey) ?? visible[0];
  const selectedDrillPath =
    selectedBucket == null
      ? undefined
      : (drillPathByBucket[selectedBucket.key] ?? selectedBucket.path);
  const currentBucketSelection = useMemo(
    () => suggestFindSpaceSelection(visible, current_path),
    [visible, current_path],
  );
  const currentFolderPath =
    selectedBucket != null &&
    currentBucketSelection?.bucketKey === selectedBucket.key &&
    currentBucketSelection.path !== selectedBucket.path
      ? currentBucketSelection.path
      : undefined;
  const breadcrumbPaths =
    selectedBucket != null && selectedDrillPath != null
      ? pathSegments(selectedBucket.path, selectedDrillPath)
      : [];
  const drillChildren = useMemo(
    () =>
      [...(drillUsage?.children ?? [])].sort((a, b) => {
        if (b.bytes !== a.bytes) return b.bytes - a.bytes;
        return a.path.localeCompare(b.path);
      }),
    [drillUsage],
  );
  const drillSummaryAnnotation =
    selectedBucket != null && selectedDrillPath != null
      ? getStorageAnnotation(selectedBucket, selectedDrillPath)
      : undefined;

  const percent =
    quota == null || quota.size <= 0
      ? 0
      : Math.round((100 * quota.used) / quota.size);
  const quotaStatus = percent > 80 ? "exception" : undefined;
  const summaryVisible = visible.filter(
    (bucket) => bucket.key !== "environment",
  );
  const visibleTotal = Math.max(
    visible.reduce((sum, bucket) => sum + bucket.summaryBytes, 0),
    1,
  );
  const historyMetricOptions = useMemo(
    () =>
      (
        [
          "quota",
          "home",
          "scratch",
          "environment",
          "snapshots",
        ] as StorageHistoryMetricKey[]
      )
        .filter((metric) => historyMetricAvailable(history, metric))
        .map((metric) => ({
          label: historyMetricLabel(metric),
          value: metric,
        })),
    [history],
  );
  const historySeries = useMemo(
    () => collectHistorySeries(history, historyMetric),
    [history, historyMetric],
  );
  const latestHistoryPoint = historySeries.at(-1);
  const firstHistoryPoint = historySeries[0];
  const historyDelta =
    latestHistoryPoint != null && firstHistoryPoint != null
      ? latestHistoryPoint.value - firstHistoryPoint.value
      : undefined;
  const historyGrowth =
    historyMetric === "quota"
      ? history?.growth?.quota_used_bytes_per_hour
      : latestHistoryPoint != null &&
          firstHistoryPoint != null &&
          Date.parse(latestHistoryPoint.collected_at) >
            Date.parse(firstHistoryPoint.collected_at)
        ? (latestHistoryPoint.value - firstHistoryPoint.value) /
          ((Date.parse(latestHistoryPoint.collected_at) -
            Date.parse(firstHistoryPoint.collected_at)) /
            (60 * 60 * 1000))
        : undefined;
  useAsyncEffect(async () => {
    if (!expand || selectedBucket == null || selectedDrillPath == null) {
      setDrillUsage(null);
      setDrillError(null);
      setDrillLoading(false);
      return;
    }
    const cache = drillCounter === lastDrillCounterRef.current;
    const requestKey = `${project_id}:${selectedBucket.key}:${selectedDrillPath}:${drillCounter}`;
    drillRequestKeyRef.current = requestKey;
    try {
      setDrillLoading(true);
      setDrillError(null);
      const nextUsage = await dust({
        project_id,
        path: selectedDrillPath,
        cache,
      });
      if (drillRequestKeyRef.current !== requestKey) {
        return;
      }
      setDrillUsage(nextUsage);
    } catch (err) {
      if (drillRequestKeyRef.current !== requestKey) {
        return;
      }
      setDrillError(err);
    } finally {
      if (drillRequestKeyRef.current === requestKey) {
        setDrillLoading(false);
      }
      lastDrillCounterRef.current = drillCounter;
    }
  }, [expand, project_id, selectedBucket, selectedDrillPath, drillCounter]);

  useAsyncEffect(async () => {
    if (!expand || activePanel !== "history") {
      setHistoryLoading(false);
      return;
    }
    const requestKey = `${project_id}:${historyWindow}:${historyCounter}`;
    historyRequestKeyRef.current = requestKey;
    try {
      setHistoryLoading(true);
      setHistoryError(null);
      const cache = historyCounter === lastHistoryCounterRef.current;
      const nextHistory = await getStorageHistory({
        project_id,
        window_minutes: historyWindow,
        max_points: HISTORY_MAX_POINTS,
        cache,
      });
      if (historyRequestKeyRef.current !== requestKey) {
        return;
      }
      setHistory(nextHistory);
    } catch (err) {
      if (historyRequestKeyRef.current === requestKey) {
        setHistoryError(err);
      }
    } finally {
      if (historyRequestKeyRef.current === requestKey) {
        setHistoryLoading(false);
      }
      lastHistoryCounterRef.current = historyCounter;
    }
  }, [expand, activePanel, project_id, historyWindow, historyCounter]);

  useEffect(() => {
    if (expand && !prevExpandRef.current) {
      prevExpandRef.current = true;
      if (currentBucketSelection != null) {
        if (selectedBucketKey !== currentBucketSelection.bucketKey) {
          setSelectedBucketKey(currentBucketSelection.bucketKey);
        }
        setDrillPathByBucket((prev) => {
          if (
            prev[currentBucketSelection.bucketKey] ===
            currentBucketSelection.path
          ) {
            return prev;
          }
          return {
            ...prev,
            [currentBucketSelection.bucketKey]: currentBucketSelection.path,
          };
        });
      }
      return;
    }
    if (!expand && prevExpandRef.current) {
      prevExpandRef.current = false;
    }
  }, [currentBucketSelection, expand, selectedBucketKey]);

  useEffect(() => {
    if (
      historyMetricOptions.length > 0 &&
      !historyMetricOptions.some((option) => option.value === historyMetric)
    ) {
      setHistoryMetric(
        historyMetricOptions[0].value as StorageHistoryMetricKey,
      );
    }
  }, [historyMetric, historyMetricOptions]);

  useEffect(() => {
    return () => {
      if (reloadStatusTimeoutRef.current != null) {
        clearTimeout(reloadStatusTimeoutRef.current);
        reloadStatusTimeoutRef.current = null;
      }
    };
  }, []);

  async function handleBrowsePath(path: string) {
    const actions = redux.getProjectActions(project_id);
    actions.set_current_path(path);
    setExpand(false);
  }

  async function handleDrillEntryClick(absolutePath: string) {
    const actions = redux.getProjectActions(project_id);
    const fs = actions.fs();
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory() && selectedBucket != null) {
      setDrillPathByBucket((prev) => ({
        ...prev,
        [selectedBucket.key]: absolutePath,
      }));
      return;
    }
    await handleBrowsePath(dirname(absolutePath));
  }

  async function handleOpenSnapshots() {
    const actions = redux.getProjectActions(project_id);
    await actions.open_directory(SNAPSHOTS);
    setExpand(false);
  }

  async function handleReload() {
    if (reloadPending) return;
    if (reloadStatusTimeoutRef.current != null) {
      clearTimeout(reloadStatusTimeoutRef.current);
      reloadStatusTimeoutRef.current = null;
    }
    setReloadPending(true);
    setReloadStatus("");
    try {
      const homePath =
        visible.find((bucket) => bucket.key === "home")?.path ?? "/root";
      await getStorageOverview({
        project_id,
        home: homePath,
        cache: false,
        force_sample: true,
      });
      refresh();
      setDrillCounter((prev) => prev + 1);
      setHistoryCounter((prev) => prev + 1);
      setReloadStatus("Updated just now.");
      reloadStatusTimeoutRef.current = setTimeout(() => {
        setReloadStatus("");
        reloadStatusTimeoutRef.current = null;
      }, 4000);
    } catch (err) {
      setError(err);
      setReloadStatus("");
    } finally {
      setReloadPending(false);
    }
  }

  const summary = (
    <Button
      onClick={() => {
        setExpand(!expand);
      }}
      style={{
        ...style,
        alignItems: "center",
        display: "flex",
        gap: compact ? "8px" : "10px",
        height: "auto",
        justifyContent: "flex-start",
        padding: compact ? "4px 8px" : "6px 10px",
        textAlign: "left",
      }}
    >
      <Icon name="disk-round" />
      {compact ? (
        <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
          <Space size={8} wrap>
            <Text strong>Disk</Text>
            {quota != null ? (
              <>
                <Progress
                  style={{ width: "52px", marginBottom: 0 }}
                  percent={percent}
                  status={quotaStatus}
                  showInfo={false}
                />
                <Text>
                  {human_readable_size(quota.used)} /{" "}
                  {human_readable_size(quota.size)}
                </Text>
              </>
            ) : (
              <Spin delay={1000} />
            )}
            {loading && <Spin delay={1000} size="small" />}
          </Space>
          {(visible.length > 0 || counted.length > 0) && (
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
              {[
                ...summaryVisible.map(
                  (bucket) =>
                    `${relativeLabel(bucket)} ${human_readable_size(bucket.summaryBytes)}`,
                ),
              ].join(" • ")}
            </div>
          )}
        </div>
      ) : (
        <Space size={10} wrap>
          <Text strong>Disk</Text>
          {quota != null ? (
            <>
              <Progress
                style={{ width: "60px", marginBottom: 0 }}
                percent={percent}
                status={quotaStatus}
                showInfo={false}
              />
              <Text>
                {human_readable_size(quota.used)} /{" "}
                {human_readable_size(quota.size)}
              </Text>
            </>
          ) : (
            <Spin delay={1000} />
          )}
          {summaryVisible.map((bucket) => (
            <Tag key={bucket.key}>
              {relativeLabel(bucket)} {human_readable_size(bucket.summaryBytes)}
            </Tag>
          ))}
          {loading && <Spin delay={1000} />}
        </Space>
      )}
    </Button>
  );

  return (
    <>
      {summary}
      {expand && (
        <Modal
          closable={false}
          onOk={() => setExpand(false)}
          onCancel={() => setExpand(false)}
          open
          width={700}
        >
          <ShowError error={error} setError={setError} />
          {activePanel === "history" && (
            <ShowError error={historyError} setError={setHistoryError} />
          )}
          <div
            style={{
              alignItems: "flex-start",
              display: "flex",
              gap: "16px",
              justifyContent: "space-between",
              marginBottom: "16px",
            }}
          >
            <h5 style={{ margin: 0 }}>
              <Icon name="disk-round" /> Project storage overview
            </h5>
            <div
              style={{
                alignItems: "flex-end",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div style={{ display: "flex", gap: "8px" }}>
                <Button
                  loading={reloadPending}
                  onClick={() => void handleReload()}
                >
                  Reload
                </Button>
                <Button
                  aria-label="Close storage overview"
                  icon={<Icon name="times" />}
                  onClick={() => setExpand(false)}
                  type="text"
                />
              </div>
              {reloadStatus ? (
                <Text type="secondary" style={{ fontSize: "12px" }}>
                  {reloadStatus}
                </Text>
              ) : null}
            </div>
          </div>
          <div style={{ marginBottom: "16px" }}>
            <Segmented
              options={[
                { label: "Overview", value: "overview" },
                { label: "History", value: "history" },
              ]}
              onChange={(value) =>
                setActivePanel(value as "overview" | "history")
              }
              value={activePanel}
            />
          </div>
          {activePanel === "history" ? (
            <>
              <div style={{ marginBottom: "14px" }}>
                <Space size={12} wrap>
                  <Text strong>Range</Text>
                  <Segmented
                    options={HISTORY_WINDOW_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    onChange={(value) => setHistoryWindow(value as number)}
                    value={historyWindow}
                  />
                  {historyMetricOptions.length > 1 && (
                    <>
                      <Text strong>Metric</Text>
                      <Segmented
                        options={historyMetricOptions}
                        onChange={(value) =>
                          setHistoryMetric(value as StorageHistoryMetricKey)
                        }
                        value={historyMetric}
                      />
                    </>
                  )}
                </Space>
              </div>
              <div style={{ color: COLORS.GRAY_M, marginBottom: "12px" }}>
                Storage history is sampled when the backend refreshes project
                storage overview data, so quiet projects may have gaps. Reload
                also forces a fresh sample immediately.
              </div>
              {historyLoading && history == null ? (
                <div style={{ padding: "24px 0", textAlign: "center" }}>
                  <Spin />
                </div>
              ) : history == null || history.point_count === 0 ? (
                <Alert
                  showIcon
                  type="info"
                  message="No storage history yet"
                  description="Storage history starts once the backend has recorded storage overview samples for this project."
                />
              ) : (
                <>
                  <Space
                    size={24}
                    wrap
                    style={{ display: "flex", marginBottom: "16px" }}
                  >
                    <div>
                      <Text strong>
                        Current {historyMetricLabel(historyMetric)}
                      </Text>
                      <div style={{ fontSize: "20px", marginTop: "4px" }}>
                        {latestHistoryPoint == null
                          ? "?"
                          : historyMetric === "quota"
                            ? `${human_readable_size(latestHistoryPoint.value)} / ${human_readable_size(history.points.at(-1)?.quota_size_bytes ?? quota?.size ?? 0)}`
                            : human_readable_size(latestHistoryPoint.value)}
                      </div>
                    </div>
                    <div>
                      <Text strong>
                        Change over{" "}
                        {formatHistoryWindow(history.window_minutes)}
                      </Text>
                      <div style={{ fontSize: "20px", marginTop: "4px" }}>
                        {historyDelta == null
                          ? "?"
                          : formatSignedSize(historyDelta)}
                      </div>
                    </div>
                    <div>
                      <Text strong>Recent slope</Text>
                      <div style={{ fontSize: "20px", marginTop: "4px" }}>
                        {historyGrowth == null
                          ? "?"
                          : `${formatSignedSize(historyGrowth)}/h`}
                      </div>
                    </div>
                  </Space>
                  {historySeries.length < 2 ? (
                    <Alert
                      showIcon
                      type="info"
                      message="Need more samples for a trend"
                      description="Only one storage sample is available so far. Reopen this later after the project has been active for a while."
                    />
                  ) : (
                    <HistorySparkline
                      metric={historyMetric}
                      points={historySeries}
                      quotaSizeBytes={
                        history.points.at(-1)?.quota_size_bytes ?? quota?.size
                      }
                    />
                  )}
                  <div style={{ color: COLORS.GRAY_M, marginTop: "10px" }}>
                    Showing {history.point_count} sampled points over{" "}
                    {formatHistoryWindow(history.window_minutes)}.
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              {quota != null && (
                <>
                  <div style={{ textAlign: "center" }}>
                    <Progress
                      type="circle"
                      percent={percent}
                      status={quotaStatus}
                      format={() => `${percent}%`}
                    />
                  </div>
                  <div style={{ marginTop: "15px" }}>
                    <b>{quota.label}:</b> {human_readable_size(quota.used)} out
                    of {human_readable_size(quota.size)}
                    {quota.warning ? (
                      <Alert
                        style={{ marginTop: "12px" }}
                        showIcon
                        type="warning"
                        message="Quota accounting warning"
                        description={quota.warning}
                      />
                    ) : null}
                    <div style={{ color: COLORS.GRAY_M, marginTop: "8px" }}>
                      Counted quota usage may differ from visible file sizes
                      because compression, deduplication, snapshots, and storage
                      accounting do not have the same semantics as browsing
                      `/root` or `/scratch`.
                    </div>
                    {visible.some((bucket) => bucket.key === "environment") && (
                      <div style={{ color: COLORS.GRAY_M, marginTop: "8px" }}>
                        This project uses a root filesystem image. Environment
                        changes measure writable overlay modifications stored
                        under{" "}
                        <code>
                          {
                            visible.find(
                              (bucket) => bucket.key === "environment",
                            )?.path
                          }
                        </code>
                        , not the shared base image itself.
                      </div>
                    )}
                  </div>
                </>
              )}
              {counted.length > 0 && (
                <>
                  <hr />
                  <div style={{ marginBottom: "10px" }}>
                    <b>Counted storage</b>
                  </div>
                  {counted.map((bucket) => (
                    <div
                      key={bucket.key}
                      style={{ marginBottom: "10px", color: COLORS.GRAY_D }}
                    >
                      <div>
                        <Text strong>{bucket.label}</Text>:{" "}
                        {human_readable_size(bucket.bytes)}
                      </div>
                      {bucket.detail ? (
                        <div style={{ color: COLORS.GRAY_M, marginTop: "4px" }}>
                          {bucket.detail}
                        </div>
                      ) : null}
                      {bucket.key === "snapshots" ? (
                        <div style={{ color: COLORS.GRAY_M, marginTop: "6px" }}>
                          Delete snapshot folders under{" "}
                          <code>~/.snapshots</code> in the usual way to free
                          this space.{" "}
                          <Button
                            onClick={() => void handleOpenSnapshots()}
                            size="small"
                            style={{ padding: 0, height: "auto" }}
                            type="link"
                          >
                            Open Snapshots
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </>
              )}
              {percent >= 100 && (
                <Alert
                  style={{ margin: "15px 0" }}
                  showIcon
                  message="OVER QUOTA"
                  description="Delete files or increase your quota."
                  type="error"
                />
              )}
              {visible.length > 0 && (
                <>
                  <hr />
                  <div style={{ marginBottom: "10px" }}>
                    <b>Visible storage</b>
                  </div>
                  {visible.some((bucket) => bucket.key === "environment") && (
                    <div style={{ color: COLORS.GRAY_M, marginBottom: "10px" }}>
                      Home excludes writable rootfs overlay data, which is shown
                      separately as Environment.
                    </div>
                  )}
                  {visible.map((bucket) => (
                    <div
                      key={bucket.key}
                      style={{
                        alignItems: "center",
                        display: "flex",
                        gap: "10px",
                        marginBottom: "8px",
                      }}
                    >
                      <div style={{ minWidth: "70px" }}>
                        <Text strong>{relativeLabel(bucket)}</Text>
                      </div>
                      <Progress
                        style={{ flex: 1, marginBottom: 0 }}
                        percent={bucketPercent(
                          bucket.summaryBytes,
                          visibleTotal,
                        )}
                        showInfo={false}
                      />
                      <div style={{ minWidth: "120px", textAlign: "right" }}>
                        {human_readable_size(bucket.summaryBytes)}
                      </div>
                    </div>
                  ))}
                </>
              )}
              {selectedBucket != null && (
                <>
                  <hr />
                  <div style={{ marginBottom: "10px" }}>
                    <Space size={12} wrap>
                      <b>Find space in</b>
                      <Segmented
                        options={visible.map((bucket) => ({
                          label: relativeLabel(bucket),
                          value: bucket.key,
                        }))}
                        onChange={(value) =>
                          setSelectedBucketKey(value as VisibleBucketKey)
                        }
                        value={selectedBucket.key}
                      />
                      {currentFolderPath != null && (
                        <Button
                          onClick={() =>
                            setDrillPathByBucket((prev) => ({
                              ...prev,
                              [selectedBucket.key]: currentFolderPath,
                            }))
                          }
                          size="small"
                        >
                          Current folder
                        </Button>
                      )}
                      {selectedDrillPath !== selectedBucket.path && (
                        <Button
                          onClick={() =>
                            setDrillPathByBucket((prev) => ({
                              ...prev,
                              [selectedBucket.key]: selectedBucket.path,
                            }))
                          }
                          size="small"
                        >
                          {relativeLabel(selectedBucket)} root
                        </Button>
                      )}
                      <Button
                        onClick={() => setDrillCounter((prev) => prev + 1)}
                        size="small"
                      >
                        Refresh
                      </Button>
                    </Space>
                  </div>
                  <div>
                    {selectedDrillPath != null && (
                      <div style={{ marginBottom: "10px" }}>
                        <Breadcrumb
                          items={breadcrumbPaths.map((path) => ({
                            title: (
                              <a
                                onClick={() =>
                                  setDrillPathByBucket((prev) => ({
                                    ...prev,
                                    [selectedBucket.key]: path,
                                  }))
                                }
                              >
                                {labelForSegment(selectedBucket, path)}
                              </a>
                            ),
                          }))}
                        />
                        <div style={{ marginTop: "8px" }}>
                          <Button
                            onClick={() => handleBrowsePath(selectedDrillPath)}
                            size="small"
                          >
                            Browse this folder
                          </Button>
                        </div>
                      </div>
                    )}
                    {drillSummaryAnnotation != null && (
                      <Alert
                        style={{ marginBottom: "12px" }}
                        showIcon
                        type={
                          drillSummaryAnnotation.tone === "warning"
                            ? "warning"
                            : "info"
                        }
                        message={drillSummaryAnnotation.label}
                        description={drillSummaryAnnotation.detail}
                      />
                    )}
                    {renderDrillError(drillError, setDrillError)}
                    {drillLoading && drillUsage == null ? (
                      <div style={{ padding: "18px 0", textAlign: "center" }}>
                        <Spin />
                      </div>
                    ) : drillUsage == null ? null : drillChildren.length ===
                      0 ? (
                      <Text type="secondary">
                        No child entries to show here.
                      </Text>
                    ) : (
                      drillChildren.map(({ path, bytes }) => {
                        const absolutePath = posix.join(
                          selectedDrillPath!,
                          path,
                        );
                        const annotation = getStorageAnnotation(
                          selectedBucket,
                          absolutePath,
                        );
                        return (
                          <div
                            key={`${selectedBucket.key}:${absolutePath}`}
                            style={{
                              borderBottom: `1px solid ${COLORS.GRAY_L}`,
                              display: "flex",
                              gap: "12px",
                              padding: "10px 0",
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  alignItems: "center",
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: "8px",
                                }}
                              >
                                <Button
                                  onClick={() =>
                                    handleDrillEntryClick(absolutePath)
                                  }
                                  style={{ padding: 0 }}
                                  type="link"
                                >
                                  {absolutePath}
                                </Button>
                                {annotation != null && (
                                  <Tag
                                    color={
                                      annotation.tone === "warning"
                                        ? "gold"
                                        : "blue"
                                    }
                                  >
                                    {annotation.label}
                                  </Tag>
                                )}
                              </div>
                              <Progress
                                percent={bucketPercent(
                                  bytes,
                                  Math.max(drillUsage.bytes, 1),
                                )}
                                showInfo={false}
                                style={{
                                  marginBottom: "4px",
                                  maxWidth: "360px",
                                }}
                              />
                              {annotation?.detail && (
                                <div
                                  style={{
                                    color: COLORS.GRAY_M,
                                    fontSize: "12px",
                                    lineHeight: 1.45,
                                  }}
                                >
                                  {annotation.detail}
                                </div>
                              )}
                            </div>
                            <div
                              style={{ minWidth: "110px", textAlign: "right" }}
                            >
                              {human_readable_size(bytes)}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
