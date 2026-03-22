import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type { HostRootfsImage } from "@cocalc/conat/hub/api/hosts";

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

  const refresh = useCallback(async () => {
    if (!enabled || !hostId) {
      setEntries([]);
      setError(undefined);
      return;
    }
    const token = ++refreshTokenRef.current;
    setRefreshing(true);
    setError(undefined);
    try {
      const rows = await hub.hosts.listHostRootfsImages({ id: hostId });
      if (refreshTokenRef.current !== token) return;
      setEntries(rows ?? []);
    } catch (err) {
      if (refreshTokenRef.current !== token) return;
      setEntries([]);
      setError(getErrorMessage(err));
    } finally {
      if (refreshTokenRef.current === token) {
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
      setActionKey(`pull:${trimmed}`);
      setError(undefined);
      try {
        await hub.hosts.pullHostRootfsImage({ id: hostId, image: trimmed });
        await refresh();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setActionKey(undefined);
      }
    },
    [hostId, hub, refresh],
  );

  const remove = useCallback(
    async (image: string) => {
      if (!hostId) return;
      const trimmed = image.trim();
      if (!trimmed) return;
      setActionKey(`delete:${trimmed}`);
      setError(undefined);
      try {
        await hub.hosts.deleteHostRootfsImage({ id: hostId, image: trimmed });
        await refresh();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setActionKey(undefined);
      }
    },
    [hostId, hub, refresh],
  );

  useEffect(() => {
    if (!enabled || !hostId) {
      setEntries([]);
      setLoading(false);
      setRefreshing(false);
      setError(undefined);
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
  };
}
