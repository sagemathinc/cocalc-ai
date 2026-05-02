import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type { HostRuntimeLog } from "@cocalc/conat/hub/api/hosts";
import type { HostRuntimeLogSource } from "@cocalc/conat/project-host/api";

type HubClient = {
  hosts: {
    getHostRuntimeLog: (opts: {
      id: string;
      lines?: number;
      source?: HostRuntimeLogSource;
    }) => Promise<HostRuntimeLog>;
  };
};

type UseHostRuntimeLogOptions = {
  hostId?: string;
  enabled?: boolean;
};

type UseHostRuntimeLogResult = {
  log?: HostRuntimeLog;
  loading: boolean;
  error?: string;
  load: (opts?: {
    source?: HostRuntimeLogSource;
    lines?: number;
  }) => Promise<void>;
  clear: () => void;
};

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Unable to load host runtime log.";
}

export function useHostRuntimeLog(
  hub: HubClient,
  { hostId, enabled = true }: UseHostRuntimeLogOptions = {},
): UseHostRuntimeLogResult {
  const [log, setLog] = useState<HostRuntimeLog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const tokenRef = useRef(0);

  const clear = useCallback(() => {
    tokenRef.current += 1;
    setLoading(false);
    setError(undefined);
    setLog(undefined);
  }, []);

  useEffect(() => {
    clear();
  }, [clear, hostId]);

  const load = useCallback(
    async (opts?: { source?: HostRuntimeLogSource; lines?: number }) => {
      if (!enabled || !hostId || !hub.hosts.getHostRuntimeLog) {
        return;
      }
      const token = ++tokenRef.current;
      setLoading(true);
      setError(undefined);
      try {
        const next = await hub.hosts.getHostRuntimeLog({
          id: hostId,
          source: opts?.source,
          lines: opts?.lines,
        });
        if (tokenRef.current !== token) return;
        setLog(next);
      } catch (err) {
        if (tokenRef.current !== token) return;
        setLog(undefined);
        setError(errorMessage(err));
      } finally {
        if (tokenRef.current === token) {
          setLoading(false);
        }
      }
    },
    [enabled, hostId, hub],
  );

  return {
    log,
    loading,
    error,
    load,
    clear,
  };
}
