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

export const useHostAvailability = (
  hub: HubClient,
  hostId?: string,
  options: UseHostAvailabilityOptions = {},
) => {
  const { days = 90, enabled = true } = options;
  const [availability, setAvailability] = useState<HostAvailabilityReport>();
  const [loadingAvailability, setLoadingAvailability] = useState(false);

  useEffect(() => {
    let mounted = true;
    if (!hostId || !enabled) {
      setAvailability(undefined);
      return () => {
        mounted = false;
      };
    }
    setLoadingAvailability(true);
    (async () => {
      try {
        const report = await hub.hosts.getHostAvailability({
          id: hostId,
          days,
        });
        if (mounted) setAvailability(report);
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

  return { availability, loadingAvailability };
};
