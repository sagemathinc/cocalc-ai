import dust, { key } from "./dust";
import getQuota from "./quota";
import getSnapshotUsage, { key as snapshotUsageKey } from "./snapshot-usage";
import { redux, useAsyncEffect } from "@cocalc/frontend/app-framework";
import { useRef, useState } from "react";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { PROJECT_IMAGE_PATH } from "@cocalc/util/db-schema/defaults";
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
  path: string;
  usage: DiskUsageTree;
};

export type StorageCountedSummary = {
  key: "snapshots";
  label: string;
  bytes: number;
  detail?: string;
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
    try {
      setError(null);
      setLoading(true);
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
      if (requestKey !== currentRef.current) {
        return;
      }
      const nextVisible: StorageVisibleSummary[] = [
        {
          key: "home",
          label: homePath,
          path: homePath,
          usage: homeUsage,
        },
      ];
      if (scratchUsage != null) {
        nextVisible.push({
          key: "scratch",
          label: "/scratch",
          path: "/scratch",
          usage: scratchUsage,
        });
      }
      if (environmentUsage != null) {
        nextVisible.push({
          key: "environment",
          label: "Environment changes",
          path: environmentPath,
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
        nextCounted.push({
          key: "snapshots",
          label: "Snapshots",
          bytes: snapshotExclusiveBytes,
          detail:
            snapshotCount === 1
              ? "Deleting the current snapshot would free about this much counted storage."
              : `Deleting old snapshots could free about this much counted storage across ${snapshotCount} snapshots.`,
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
      setError(err);
    } finally {
      setLoading(false);
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
