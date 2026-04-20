import getStorageOverview, {
  getCachedStorageOverview,
  key,
} from "./storage-overview";
import { useAsyncEffect } from "@cocalc/frontend/app-framework";
import { useRef, useState } from "react";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import type {
  ProjectStorageBreakdown,
  ProjectStorageCountedSummary,
  ProjectStorageQuotaSummary,
  ProjectStorageVisibleSummary,
} from "@cocalc/conat/project/storage-info";

export type DiskUsageTree = ProjectStorageBreakdown;

export type StorageQuotaSummary = ProjectStorageQuotaSummary;

export type StorageVisibleSummary = ProjectStorageVisibleSummary;

export type StorageCountedSummary = ProjectStorageCountedSummary;

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
  const [counted, setCounted] = useState<StorageCountedSummary[]>(
    () => cachedOverview?.counted ?? [],
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
        setCounted(cachedOverview?.counted ?? []);
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
      setCounted(overview.counted);
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
    counted,
    loading,
    error,
    setError,
    refresh: () => {
      setCounter((prev) => prev + 1);
    },
  };
}
