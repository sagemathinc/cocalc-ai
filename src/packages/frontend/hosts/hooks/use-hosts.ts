import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";

type HubClient = {
  hosts: {
    listHosts: (opts: Record<string, unknown>) => Promise<Host[]>;
  };
  purchases: {
    getMembership: (
      opts: Record<string, unknown>,
    ) => Promise<MembershipResolution>;
  };
};

type UseHostsOptions = {
  onError?: (err: unknown) => void;
  pollMs?: number;
  adminView?: boolean;
  includeDeleted?: boolean;
  showAll?: boolean;
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
    showAll = false,
  } = options;
  const [hosts, setHosts] = useState<Host[]>([]);
  const [membership, setMembership] = useState<MembershipResolution | null>(
    null,
  );
  const [canCreateHosts, setCanCreateHosts] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  const hostsRef = useRef<Host[]>([]);
  const lastMembershipRef = useRef(0);
  const membershipInflightRef = useRef<Promise<void> | undefined>(undefined);
  const hostsInflightRef = useRef<
    { key: string; promise: Promise<Host[]> } | undefined
  >(undefined);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    hostsRef.current = hosts;
  }, [hosts]);

  const refreshMembership = useCallback(async () => {
    if (membershipInflightRef.current != null) {
      return await membershipInflightRef.current;
    }
    const now = Date.now();
    if (now - lastMembershipRef.current < MEMBERSHIP_REFRESH_MS) {
      return;
    }
    lastMembershipRef.current = now;
    const request = (async () => {
      try {
        const membership = await hub.purchases.getMembership({});
        setMembership(membership ?? null);
        setCanCreateHosts(
          membership?.entitlements?.features?.create_hosts === true,
        );
      } catch (err) {
        console.error("failed to load membership", err);
        onErrorRef.current?.(err);
      }
    })();
    membershipInflightRef.current = request;
    try {
      await request;
    } finally {
      if (membershipInflightRef.current === request) {
        membershipInflightRef.current = undefined;
      }
    }
  }, [hub]);

  const refresh = useCallback(async () => {
    const requestKey = JSON.stringify({ adminView, includeDeleted, showAll });
    if (hostsInflightRef.current?.key === requestKey) {
      return await hostsInflightRef.current.promise;
    }
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    const request = (async () => {
      try {
        const list = await hub.hosts.listHosts({
          admin_view: adminView ? true : undefined,
          include_deleted: includeDeleted ? true : undefined,
          show_all: showAll ? true : undefined,
        });
        if (requestSeq !== requestSeqRef.current) {
          return hostsRef.current;
        }
        setHosts(list);
        setLoaded(true);
        void refreshMembership();
        return list;
      } catch (err) {
        if (requestSeq !== requestSeqRef.current) {
          return hostsRef.current;
        }
        setError(getErrorMessage(err));
        setLoaded(true);
        throw err;
      } finally {
        if (requestSeq === requestSeqRef.current) {
          setLoading(false);
        }
      }
    })();
    hostsInflightRef.current = { key: requestKey, promise: request };
    try {
      return await request;
    } finally {
      if (hostsInflightRef.current?.promise === request) {
        hostsInflightRef.current = undefined;
      }
    }
  }, [hub, adminView, includeDeleted, showAll, refreshMembership]);

  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    refresh().catch((err) => {
      console.error("failed to load hosts", err);
      onErrorRef.current?.(err);
    });
  }, [refresh]);

  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    refreshMembership().catch((err) => {
      console.error("failed to load membership", err);
      onErrorRef.current?.(err);
    });
  }, [refreshMembership]);

  useEffect(() => {
    const poll = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh().catch((err) => {
        console.error("host refresh failed", err);
        onErrorRef.current?.(err);
      });
    };
    const onVisibilityChange = () => {
      if (!document.hidden) poll();
    };
    const timer = setInterval(poll, pollMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh, pollMs]);

  return {
    hosts,
    setHosts,
    refresh,
    membership,
    canCreateHosts,
    loading,
    loaded,
    error,
  };
};
