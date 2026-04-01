import dust, { key } from "./dust";
import getQuota from "./quota";
import getSnapshotUsage, { key as snapshotUsageKey } from "./snapshot-usage";
import { redux, useAsyncEffect } from "@cocalc/frontend/app-framework";
import { useRef, useState } from "react";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { PROJECT_IMAGE_PATH } from "@cocalc/util/db-schema/defaults";
import { human_readable_size } from "@cocalc/util/misc";
import { posix } from "path";

export type DiskUsageTree = {
  bytes: number;
  children: { bytes: number; path: string }[];
};

export type StorageQuotaSummary = {
  key: "project";
  label: string;
  used: number;
  size: number;
};

export type StorageVisibleSummary = {
  key: "home" | "scratch" | "environment";
  label: string;
  summaryLabel: string;
  path: string;
  summaryBytes: number;
  usage: DiskUsageTree;
};

export type StorageCountedSummary = {
  key: "snapshots";
  label: string;
  bytes: number;
  detail?: string;
  compactLabel?: string;
};

const MIN_COUNTED_BUCKET_BYTES = 1 << 20;

function isOptionalScratchError(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    text.includes("scratch is not mounted") ||
    text.includes("no such file") ||
    text.includes("not found")
  );
}

export default function useDiskUsage({ project_id }: { project_id: string }) {
  const [counter, setCounter] = useState<number>(0);
  const lastCounterRef = useRef<number>(0);
  const [visible, setVisible] = useState<StorageVisibleSummary[]>([]);
  const [counted, setCounted] = useState<StorageCountedSummary[]>([]);
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [quotas, setQuotas] = useState<StorageQuotaSummary[]>([]);
  const homePath = getProjectHomeDirectory(project_id);
  const projectMap = redux.getStore("projects")?.get?.("project_map");
  const rootfsImage =
    `${projectMap?.getIn?.([project_id, "rootfs_image"]) ?? ""}`.trim() || "";
  const environmentPath = posix.join(homePath, PROJECT_IMAGE_PATH);
  const requestKey = [
    key({ project_id, path: homePath }),
    key({ project_id, path: "/scratch" }),
    rootfsImage ? key({ project_id, path: environmentPath }) : "",
    snapshotUsageKey({ project_id }),
  ]
    .filter(Boolean)
    .join("::");
  const currentRef = useRef<any>(requestKey);
  currentRef.current = requestKey;

  useAsyncEffect(async () => {
    const activeRequestKey = requestKey;
    try {
      if (activeRequestKey === currentRef.current) {
        setError(null);
        setLoading(true);
      }
      const cache = counter == lastCounterRef.current;
      const [
        homeUsage,
        scratchUsage,
        environmentUsage,
        snapshotUsage,
        nextQuota,
      ] = await Promise.all([
        dust({
          project_id,
          path: homePath,
          cache,
        }),
        dust({
          project_id,
          path: "/scratch",
          cache,
        }).catch((err) => {
          if (isOptionalScratchError(err)) {
            return null;
          }
          throw err;
        }),
        rootfsImage
          ? dust({
              project_id,
              path: environmentPath,
              cache,
            }).catch((err) => {
              if (isOptionalScratchError(err)) {
                return null;
              }
              throw err;
            })
          : Promise.resolve(null),
        getSnapshotUsage({
          project_id,
          cache,
        }),
        getQuota({
          project_id,
          cache,
        }),
      ]);
      if (activeRequestKey !== currentRef.current) {
        return;
      }
      const nextVisible: StorageVisibleSummary[] = [
        {
          key: "home",
          label: homePath,
          summaryLabel: "Home",
          path: homePath,
          summaryBytes: Math.max(
            0,
            homeUsage.bytes - Math.max(0, environmentUsage?.bytes ?? 0),
          ),
          usage: homeUsage,
        },
      ];
      if (scratchUsage != null) {
        nextVisible.push({
          key: "scratch",
          label: "/scratch",
          summaryLabel: "Scratch",
          path: "/scratch",
          summaryBytes: scratchUsage.bytes,
          usage: scratchUsage,
        });
      }
      if (environmentUsage != null) {
        nextVisible.push({
          key: "environment",
          label: "Environment changes",
          summaryLabel: "Environment",
          path: environmentPath,
          summaryBytes: environmentUsage.bytes,
          usage: environmentUsage,
        });
      }
      const snapshotExclusiveBytes = snapshotUsage.reduce(
        (sum, snapshot) => sum + Math.max(0, snapshot.exclusive ?? 0),
        0,
      );
      const nextCounted: StorageCountedSummary[] = [];
      if (snapshotExclusiveBytes >= MIN_COUNTED_BUCKET_BYTES) {
        const snapshotCount = snapshotUsage.length;
        const largestExclusiveBytes = snapshotUsage.reduce(
          (max, snapshot) =>
            Math.max(max, Math.max(0, snapshot.exclusive ?? 0)),
          0,
        );
        nextCounted.push({
          key: "snapshots",
          label: "Snapshots",
          bytes: snapshotExclusiveBytes,
          compactLabel: "Snapshots",
          detail:
            snapshotCount <= 1
              ? "This snapshot currently holds counted storage that would be freed if it is deleted."
              : `Across ${snapshotCount} snapshots, this is storage referenced only by snapshots. The largest single snapshot currently has about ${human_readable_size(largestExclusiveBytes)} of exclusive data, and exact savings from deleting one snapshot depend on overlap.`,
        });
      }
      setVisible(nextVisible);
      setCounted(nextCounted);
      setQuotas([
        {
          key: "project",
          label: "Project quota",
          used: nextQuota.used,
          size: nextQuota.size,
        },
      ]);
    } catch (err) {
      if (activeRequestKey === currentRef.current) {
        setError(err);
      }
    } finally {
      if (activeRequestKey === currentRef.current) {
        setLoading(false);
      }
    }
    lastCounterRef.current = counter;
  }, [project_id, homePath, rootfsImage, environmentPath, requestKey, counter]);

  return {
    quotas,
    visible,
    counted,
    loading,
    error,
    setError,
    refresh: () => {
      setCounter((prev) => prev + 1);
    },
  };
}
