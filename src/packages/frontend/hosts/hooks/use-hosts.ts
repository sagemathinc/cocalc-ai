import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type { Host } from "@cocalc/conat/hub/api/hosts";

type HubClient = {
  hosts: {
    listHosts: (opts: Record<string, unknown>) => Promise<Host[]>;
  };
  purchases: {
    getMembership: (opts: Record<string, unknown>) => Promise<any>;
  };
};

type UseHostsOptions = {
  onError?: (err: unknown) => void;
  pollMs?: number;
  adminView?: boolean;
  includeDeleted?: boolean;
};

const MEMBERSHIP_REFRESH_MS = 5 * 60_000;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Unable to load hosts.";
}

export const useHosts = (hub: HubClient, options: UseHostsOptions = {}) => {
  const {
    onError,
    pollMs = 15_000,
    adminView = false,
    includeDeleted = false,
  } = options;
  const [hosts, setHosts] = useState<Host[]>([]);
  const [canCreateHosts, setCanCreateHosts] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  const lastMembershipRef = useRef(0);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const refreshMembership = useCallback(async () => {
    const now = Date.now();
    if (now - lastMembershipRef.current < MEMBERSHIP_REFRESH_MS) {
      return;
    }
    lastMembershipRef.current = now;
    try {
      const membership = await hub.purchases.getMembership({});
      setCanCreateHosts(
        membership?.entitlements?.features?.create_hosts === true,
      );
    } catch (err) {
      console.error("failed to load membership", err);
      onErrorRef.current?.(err);
    }
  }, [hub]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await hub.hosts.listHosts({
        admin_view: adminView ? true : undefined,
        include_deleted: includeDeleted ? true : undefined,
      });
      setHosts(list);
      setLoaded(true);
      void refreshMembership();
      return list;
    } catch (err) {
      setError(getErrorMessage(err));
      setLoaded(true);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [hub, adminView, includeDeleted, refreshMembership]);

  useEffect(() => {
    refresh().catch((err) => {
      console.error("failed to load hosts", err);
      onErrorRef.current?.(err);
    });
  }, [refresh]);

  useEffect(() => {
    refreshMembership().catch((err) => {
      console.error("failed to load membership", err);
      onErrorRef.current?.(err);
    });
  }, [refreshMembership]);

  useEffect(() => {
    const timer = setInterval(() => {
      refresh().catch((err) => {
        console.error("host refresh failed", err);
        onErrorRef.current?.(err);
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { hosts, setHosts, refresh, canCreateHosts, loading, loaded, error };
};
