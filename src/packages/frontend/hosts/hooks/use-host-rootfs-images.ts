import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type {
  HostRootfsGcResult,
  HostRootfsImage,
} from "@cocalc/conat/hub/api/hosts";

type HubClient = {
  hosts: {
    listHostRootfsImages: (opts: { id: string }) => Promise<HostRootfsImage[]>;
    pullHostRootfsImage: (opts: {
      id: string;
      image: string;
    }) => Promise<HostRootfsImage>;
    deleteHostRootfsImage: (opts: {
      id: string;
      image: string;
    }) => Promise<{ removed: boolean }>;
    gcDeletedHostRootfsImages: (opts: {
      id: string;
    }) => Promise<HostRootfsGcResult>;
  };
};

type UseHostRootfsImagesOptions = {
  hostId?: string;
  enabled?: boolean;
};

type UseHostRootfsImagesResult = {
  entries: HostRootfsImage[];
  loading: boolean;
  error?: string;
  refreshing: boolean;
  actionKey?: string;
  refresh: () => Promise<void>;
  pull: (image: string) => Promise<void>;
  remove: (image: string) => Promise<void>;
  gcDeleted: () => Promise<HostRootfsGcResult | undefined>;
};

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Unable to load RootFS cache.";
}

export function useHostRootfsImages(
  hub: HubClient,
  options: UseHostRootfsImagesOptions = {},
): UseHostRootfsImagesResult {
  const { hostId, enabled = true } = options;
  const [entries, setEntries] = useState<HostRootfsImage[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string>();
  const [actionKey, setActionKey] = useState<string>();
  const refreshTokenRef = useRef(0);
  const scopeTokenRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !hostId) {
      setEntries([]);
      setError(undefined);
      return;
    }
    const token = ++refreshTokenRef.current;
    const scopeToken = scopeTokenRef.current;
    setRefreshing(true);
    setError(undefined);
    try {
      const rows = await hub.hosts.listHostRootfsImages({ id: hostId });
      if (
        refreshTokenRef.current !== token ||
        scopeTokenRef.current !== scopeToken
      ) {
        return;
      }
      setEntries(rows ?? []);
    } catch (err) {
      if (
        refreshTokenRef.current !== token ||
        scopeTokenRef.current !== scopeToken
      ) {
        return;
      }
      setEntries([]);
      setError(getErrorMessage(err));
    } finally {
      if (
        refreshTokenRef.current === token &&
        scopeTokenRef.current === scopeToken
      ) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [enabled, hostId, hub]);

  const pull = useCallback(
    async (image: string) => {
      if (!hostId) return;
      const trimmed = image.trim();
      if (!trimmed) return;
      const scopeToken = scopeTokenRef.current;
      setActionKey(`pull:${trimmed}`);
      setError(undefined);
      try {
        await hub.hosts.pullHostRootfsImage({ id: hostId, image: trimmed });
        if (scopeTokenRef.current !== scopeToken) return;
        await refresh();
      } catch (err) {
        if (scopeTokenRef.current !== scopeToken) return;
        setError(getErrorMessage(err));
      } finally {
        if (scopeTokenRef.current === scopeToken) {
          setActionKey(undefined);
        }
      }
    },
    [hostId, hub, refresh],
  );

  const remove = useCallback(
    async (image: string) => {
      if (!hostId) return;
      const trimmed = image.trim();
      if (!trimmed) return;
      const scopeToken = scopeTokenRef.current;
      setActionKey(`delete:${trimmed}`);
      setError(undefined);
      try {
        await hub.hosts.deleteHostRootfsImage({ id: hostId, image: trimmed });
        if (scopeTokenRef.current !== scopeToken) return;
        await refresh();
      } catch (err) {
        if (scopeTokenRef.current !== scopeToken) return;
        setError(getErrorMessage(err));
      } finally {
        if (scopeTokenRef.current === scopeToken) {
          setActionKey(undefined);
        }
      }
    },
    [hostId, hub, refresh],
  );

  const gcDeleted = useCallback(async () => {
    if (!hostId) return;
    const scopeToken = scopeTokenRef.current;
    setActionKey("gc:deleted");
    setError(undefined);
    try {
      const result = await hub.hosts.gcDeletedHostRootfsImages({ id: hostId });
      if (scopeTokenRef.current !== scopeToken) return;
      await refresh();
      return result;
    } catch (err) {
      if (scopeTokenRef.current !== scopeToken) return;
      setError(getErrorMessage(err));
    } finally {
      if (scopeTokenRef.current === scopeToken) {
        setActionKey(undefined);
      }
    }
  }, [hostId, hub, refresh]);

  useEffect(() => {
    scopeTokenRef.current += 1;
    refreshTokenRef.current += 1;
    setEntries([]);
    setLoading(false);
    setRefreshing(false);
    setError(undefined);
    setActionKey(undefined);
    if (!enabled || !hostId) {
      return;
    }
    setLoading(true);
    refresh().catch((err) => {
      console.error("failed to load host rootfs images", err);
      setLoading(false);
      setRefreshing(false);
      setError(getErrorMessage(err));
    });
  }, [enabled, hostId, refresh]);

  return {
    entries,
    loading,
    error,
    refreshing,
    actionKey,
    refresh,
    pull,
    remove,
    gcDeleted,
  };
}
