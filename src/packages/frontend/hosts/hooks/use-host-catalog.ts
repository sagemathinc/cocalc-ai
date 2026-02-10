import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type { HostCatalog } from "@cocalc/conat/hub/api/hosts";
import type { HostProvider } from "../types";

type HubClient = {
  hosts: {
    getCatalog: (opts: { provider: HostProvider }) => Promise<HostCatalog>;
    updateCloudCatalog: (opts: { provider: HostProvider }) => Promise<void>;
  };
};

type UseHostCatalogOptions = {
  provider?: HostProvider;
  onError?: (message: string) => void;
  pollMs?: number;
};

export const useHostCatalog = (
  hub: HubClient,
  { provider, onError, pollMs }: UseHostCatalogOptions,
) => {
  const [catalog, setCatalog] = useState<HostCatalog | undefined>(undefined);
  const [catalogError, setCatalogError] = useState<string | undefined>(
    undefined,
  );
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const fetchCatalog = useCallback(async ({ background = false } = {}) => {
    if (!provider) {
      setCatalog(undefined);
      setCatalogError(undefined);
      setCatalogLoading(false);
      return;
    }
    if (!background) {
      setCatalogLoading(true);
    }
    try {
      const data = await hub.hosts.getCatalog({ provider });
      setCatalog(data);
      setCatalogError(undefined);
    } catch (err: any) {
      console.error("failed to load cloud catalog", err);
      const message =
        err?.message ?? "Unable to load cloud catalog (regions/zones).";
      setCatalog(undefined);
      setCatalogError(message);
      onErrorRef.current?.(message);
    } finally {
      if (!background) {
        setCatalogLoading(false);
      }
    }
  }, [provider, hub]);

  useEffect(() => {
    (async () => {
      await fetchCatalog({ background: false });
    })();
    return () => undefined;
  }, [fetchCatalog]);

  useEffect(() => {
    if (!pollMs || !provider) return;
    const timer = setInterval(() => {
      fetchCatalog({ background: true }).catch(() => undefined);
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs, provider, fetchCatalog]);

  const refreshCatalogForProvider = async (
    providerOverride?: HostProvider,
  ): Promise<boolean> => {
    if (!providerOverride || providerOverride === "none" || catalogRefreshing) {
      return false;
    }
    setCatalogRefreshing(true);
    let success = true;
    try {
      await hub.hosts.updateCloudCatalog({ provider: providerOverride });
      if (providerOverride === provider) {
        const data = await hub.hosts.getCatalog({ provider: providerOverride });
        setCatalog(data);
        setCatalogError(undefined);
      }
    } catch (err) {
      console.error(err);
      onErrorRef.current?.("Failed to update cloud catalog");
      success = false;
    } finally {
      setCatalogRefreshing(false);
    }
    return success;
  };

  return {
    catalog,
    catalogError,
    catalogLoading,
    catalogRefreshing,
    refreshCatalog: refreshCatalogForProvider,
  };
};
