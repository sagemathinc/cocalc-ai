import { useEffect, useState } from "@cocalc/frontend/app-framework";
import type {
  HostAvailabilityEvent,
  HostAvailabilityReport,
} from "@cocalc/conat/hub/api/hosts";

type HubClient = {
  hosts: {
    getHostAvailability: (opts: {
      id: string;
      days?: number;
    }) => Promise<HostAvailabilityReport>;
    annotateHostAvailabilityEvent?: (opts: {
      id: string;
      event_id: string;
      admin_note?: string | null;
      admin_note_visibility?: "private" | "public";
      category?: HostAvailabilityEvent["category"];
      planned?: boolean;
      summary?: string | null;
    }) => Promise<HostAvailabilityEvent>;
  };
};

type UseHostAvailabilityOptions = {
  days?: number;
  enabled?: boolean;
};

const cache = new Map<string, HostAvailabilityReport>();
const inflight = new Map<string, Promise<HostAvailabilityReport>>();

export const useHostAvailability = (
  hub: HubClient,
  hostId?: string,
  options: UseHostAvailabilityOptions = {},
) => {
  const { days = 30, enabled = true } = options;
  const [availability, setAvailability] = useState<HostAvailabilityReport>();
  const [loadingAvailability, setLoadingAvailability] = useState(false);
  const loadAvailability = async (force = false) => {
    if (!hostId || !enabled) {
      setAvailability(undefined);
      return;
    }
    const key = `${hostId}:${days}`;
    const cached = cache.get(key);
    if (cached && !force) {
      setAvailability(cached);
    }
    setLoadingAvailability(true);
    try {
      if (force) {
        cache.delete(key);
        inflight.delete(key);
      }
      const report =
        inflight.get(key) ??
        hub.hosts.getHostAvailability({ id: hostId, days }).finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, report);
      const resolved = await report;
      cache.set(key, resolved);
      setAvailability(resolved);
    } catch (err) {
      setAvailability(undefined);
      console.warn("getHostAvailability failed", err);
    } finally {
      setLoadingAvailability(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    if (!hostId || !enabled) {
      setAvailability(undefined);
      return () => {
        mounted = false;
      };
    }
    const key = `${hostId}:${days}`;
    const cached = cache.get(key);
    if (cached) {
      setAvailability(cached);
    }
    setLoadingAvailability(true);
    (async () => {
      try {
        const report =
          inflight.get(key) ??
          hub.hosts.getHostAvailability({ id: hostId, days }).finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, report);
        const resolved = await report;
        cache.set(key, resolved);
        if (mounted) setAvailability(resolved);
      } catch (err) {
        if (mounted) setAvailability(undefined);
        console.warn("getHostAvailability failed", err);
      } finally {
        if (mounted) setLoadingAvailability(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [hostId, enabled, days, hub.hosts]);

  return {
    availability,
    loadingAvailability,
    refreshAvailability: () => loadAvailability(true),
  };
};
