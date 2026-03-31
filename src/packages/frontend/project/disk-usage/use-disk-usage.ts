import dust, { key } from "./dust";
import getQuota from "./quota";
import { useAsyncEffect } from "@cocalc/frontend/app-framework";
import { useRef, useState } from "react";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";

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
  key: "home" | "scratch";
  label: string;
  path: string;
  usage: DiskUsageTree;
};

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
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [quotas, setQuotas] = useState<StorageQuotaSummary[]>([]);
  const homePath = getProjectHomeDirectory(project_id);
  const currentRef = useRef<any>(
    `${project_id}-${homePath}-0::${project_id}-0-/scratch`,
  );
  currentRef.current = `${key({ project_id, path: homePath })}::${key({ project_id, path: "/scratch" })}`;

  useAsyncEffect(async () => {
    try {
      setError(null);
      setLoading(true);
      const cache = counter == lastCounterRef.current;
      const [homeUsage, scratchUsage, nextQuota] = await Promise.all([
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
        getQuota({
          project_id,
          cache,
        }),
      ]);
      if (
        `${key({ project_id, path: homePath })}::${key({ project_id, path: "/scratch" })}` !==
        currentRef.current
      ) {
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
      setVisible(nextVisible);
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
  }, [project_id, homePath, counter]);

  return {
    quotas,
    visible,
    loading,
    error,
    setError,
    refresh: () => {
      setCounter((prev) => prev + 1);
    },
  };
}
