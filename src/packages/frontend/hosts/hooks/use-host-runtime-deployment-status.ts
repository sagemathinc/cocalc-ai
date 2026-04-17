import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type { HostRuntimeDeploymentStatus } from "@cocalc/conat/hub/api/hosts";

type HubClient = {
  hosts: {
    getHostRuntimeDeploymentStatus: (opts: {
      id: string;
    }) => Promise<HostRuntimeDeploymentStatus>;
  };
};

type UseHostRuntimeDeploymentStatusOptions = {
  hostId?: string;
  enabled?: boolean;
  pollMs?: number;
};

type UseHostRuntimeDeploymentStatusResult = {
  status?: HostRuntimeDeploymentStatus;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  refresh: () => Promise<void>;
};

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Unable to load runtime deployment status.";
}

export function useHostRuntimeDeploymentStatus(
  hub: HubClient,
  {
    hostId,
    enabled = true,
    pollMs = 15000,
  }: UseHostRuntimeDeploymentStatusOptions = {},
): UseHostRuntimeDeploymentStatusResult {
  const [status, setStatus] = useState<HostRuntimeDeploymentStatus>();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const tokenRef = useRef(0);
  const statusRef = useRef<HostRuntimeDeploymentStatus | undefined>(undefined);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const refresh = useCallback(async () => {
    if (!enabled || !hostId || !hub.hosts.getHostRuntimeDeploymentStatus) {
      return;
    }
    const token = ++tokenRef.current;
    const initial = !statusRef.current;
    if (initial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    try {
      const next = await hub.hosts.getHostRuntimeDeploymentStatus({
        id: hostId,
      });
      if (tokenRef.current !== token) return;
      setStatus(next);
      setError(undefined);
    } catch (err) {
      if (tokenRef.current !== token) return;
      setError(errorMessage(err));
    } finally {
      if (tokenRef.current === token) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled, hostId, hub]);

  useEffect(() => {
    if (!enabled || !hostId) {
      setStatus(undefined);
      setLoading(false);
      setRefreshing(false);
      setError(undefined);
      return;
    }
    refresh().catch((err) => {
      console.error("failed to load host runtime deployment status", err);
      setLoading(false);
      setRefreshing(false);
    });
  }, [enabled, hostId, refresh]);

  useEffect(() => {
    if (!enabled || !hostId || pollMs <= 0) return;
    const timer = setInterval(() => {
      refresh().catch((err) => {
        console.error("failed to refresh host runtime deployment status", err);
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, hostId, pollMs, refresh]);

  return {
    status,
    loading,
    refreshing,
    error,
    refresh,
  };
}
