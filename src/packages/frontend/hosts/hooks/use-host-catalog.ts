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

const CATALOG_REFRESH_LONG_POLL_DELAYS_MS = [
  1000, 2000, 3000, 5000, 8000, 13000, 21000, 30000, 30000, 30000, 30000, 30000,
];
const CATALOG_REFRESH_FAST_FAIL_MS = 10_000;

function hasCatalogEntries(catalog: HostCatalog | undefined): boolean {
  return (catalog?.entries?.length ?? 0) > 0;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyTimeout(err: unknown): boolean {
  const message = err instanceof Error ? err.message : `${err}`;
  return /timeout|timed out/i.test(message);
}

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
  const [catalogRefreshMessage, setCatalogRefreshMessage] = useState<
    string | undefined
  >(undefined);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const fetchCatalog = useCallback(
    async ({ background = false } = {}) => {
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
    },
    [provider, hub],
  );

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
    setCatalogRefreshMessage("Requesting provider catalog refresh...");
    let success = true;
    let updateError: unknown;
    const startedAt = Date.now();
    try {
      const updatePromise = hub.hosts
        .updateCloudCatalog({ provider: providerOverride })
        .catch((err) => {
          updateError = err;
        });
      if (providerOverride === provider) {
        let data: HostCatalog | undefined;
        for (const waitMs of CATALOG_REFRESH_LONG_POLL_DELAYS_MS) {
          data = await hub.hosts.getCatalog({ provider: providerOverride });
          if (hasCatalogEntries(data)) break;
          if (
            updateError != null &&
            (Date.now() - startedAt < CATALOG_REFRESH_FAST_FAIL_MS ||
              !isLikelyTimeout(updateError))
          ) {
            throw updateError;
          }
          setCatalogRefreshMessage(
            "Refreshing provider catalog. This can take a few minutes the first time...",
          );
          await delay(waitMs);
        }
        data =
          data ?? (await hub.hosts.getCatalog({ provider: providerOverride }));
        setCatalog(data);
        setCatalogError(undefined);
        if (!hasCatalogEntries(data)) {
          if (updateError != null) throw updateError;
          throw new Error("provider catalog is still empty after refresh");
        }
      } else {
        await updatePromise;
        if (updateError != null) throw updateError;
      }
    } catch (err) {
      console.error(err);
      setCatalogError(
        "Provider catalog refresh is still running or failed. Wait a minute, then try again.",
      );
      onErrorRef.current?.(
        "Provider catalog refresh is still running or failed",
      );
      success = false;
    } finally {
      setCatalogRefreshing(false);
      setCatalogRefreshMessage(undefined);
    }
    return success;
  };

  return {
    catalog,
    catalogError,
    catalogLoading,
    catalogRefreshing,
    catalogRefreshMessage,
    refreshCatalog: refreshCatalogForProvider,
  };
};
