import dust from "./dust";
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
  Typography,
} from "antd";
import ShowError from "@cocalc/frontend/components/error";
import { human_readable_size } from "@cocalc/util/misc";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { redux, useAsyncEffect } from "@cocalc/frontend/app-framework";
import { dirname, posix } from "path";
import { COLORS } from "@cocalc/util/theme";

const { Text } = Typography;
type VisibleBucketKey = StorageVisibleSummary["key"];
type DrillSelection = { bucketKey: VisibleBucketKey; path: string };
type StorageAnnotation = {
  label: string;
  detail: string;
  tone?: "warning" | "info";
};

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
          onOk={() => setExpand(false)}
          onCancel={() => setExpand(false)}
          open
          width={700}
        >
          <ShowError error={error} setError={setError} />
          <h5 style={{ marginTop: 0 }}>
            <Icon name="disk-round" /> Project storage overview
            <Button
              onClick={() => refresh()}
              style={{ float: "right", marginRight: "30px" }}
            >
              Reload
            </Button>
          </h5>
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
                <b>{quota.label}:</b> {human_readable_size(quota.used)} out of{" "}
                {human_readable_size(quota.size)}
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
                  Counted quota usage may differ from visible file sizes because
                  compression, deduplication, snapshots, and storage accounting
                  do not have the same semantics as browsing `/root` or
                  `/scratch`.
                </div>
                {visible.some((bucket) => bucket.key === "environment") && (
                  <div style={{ color: COLORS.GRAY_M, marginTop: "8px" }}>
                    This project uses a root filesystem image. Environment
                    changes measure writable overlay modifications stored under{" "}
                    <code>
                      {
                        visible.find((bucket) => bucket.key === "environment")
                          ?.path
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
                    percent={bucketPercent(bucket.summaryBytes, visibleTotal)}
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
                <ShowError error={drillError} setError={setDrillError} />
                {drillLoading && drillUsage == null ? (
                  <div style={{ padding: "18px 0", textAlign: "center" }}>
                    <Spin />
                  </div>
                ) : drillUsage == null ? null : drillChildren.length === 0 ? (
                  <Text type="secondary">No child entries to show here.</Text>
                ) : (
                  drillChildren.map(({ path, bytes }) => {
                    const absolutePath = posix.join(selectedDrillPath!, path);
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
                            style={{ marginBottom: "4px", maxWidth: "360px" }}
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
                        <div style={{ minWidth: "110px", textAlign: "right" }}>
                          {human_readable_size(bytes)}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
