import getStorageOverview, {
  getCachedStorageOverview,
  key,
} from "./storage-overview";
import { useAsyncEffect } from "@cocalc/frontend/app-framework";
import { useRef, useState } from "react";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import type {
  ProjectStorageBreakdown,
  ProjectStorageLiveSummary,
  ProjectStorageQuotaSummary,
  ProjectStorageRetainedSummary,
  ProjectStorageVisibleSummary,
} from "@cocalc/conat/project/storage-info";

export type DiskUsageTree = ProjectStorageBreakdown;

export type StorageQuotaSummary = ProjectStorageQuotaSummary;

export type StorageVisibleSummary = ProjectStorageVisibleSummary;

export type StorageLiveSummary = ProjectStorageLiveSummary;

export type StorageRetainedSummary = ProjectStorageRetainedSummary;

export default function useDiskUsage({ project_id }: { project_id: string }) {
  const [counter, setCounter] = useState<number>(0);
  const lastCounterRef = useRef<number>(0);
  const homePath = getProjectHomeDirectory(project_id);
  const cachedOverview = getCachedStorageOverview({
    project_id,
    home: homePath,
  });
  const [visible, setVisible] = useState<StorageVisibleSummary[]>(
    () => cachedOverview?.visible ?? [],
  );
  const [live, setLive] = useState<StorageLiveSummary | null>(
    () => cachedOverview?.live ?? null,
  );
  const [retained, setRetained] = useState<StorageRetainedSummary | null>(
    () => cachedOverview?.retained ?? null,
  );
  const [error, setError] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [quotas, setQuotas] = useState<StorageQuotaSummary[]>(
    () => cachedOverview?.quotas ?? [],
  );
  const requestKey = key({ project_id, home: homePath });
  const currentRef = useRef<any>(requestKey);
  currentRef.current = requestKey;

  useAsyncEffect(async () => {
    const activeRequestKey = requestKey;
    try {
      if (activeRequestKey === currentRef.current) {
        setError(null);
        setVisible(cachedOverview?.visible ?? []);
        setLive(cachedOverview?.live ?? null);
        setRetained(cachedOverview?.retained ?? null);
        setQuotas(cachedOverview?.quotas ?? []);
        setLoading(true);
      }
      const cache = counter == lastCounterRef.current;
      const overview = await getStorageOverview({
        project_id,
        home: homePath,
        cache,
      });
      if (activeRequestKey !== currentRef.current) {
        return;
      }
      setVisible(overview.visible);
      setLive(overview.live);
      setRetained(overview.retained);
      setQuotas(overview.quotas);
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
  }, [project_id, homePath, requestKey, counter, cachedOverview]);

  return {
    quotas,
    visible,
    live,
    retained,
    loading,
    error,
    setError,
    refresh: () => {
      setCounter((prev) => prev + 1);
    },
  };
}
