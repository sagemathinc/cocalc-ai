import { React } from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import type { ParallelOpsWorkerStatus } from "@cocalc/conat/hub/api/system";

type ParallelOpsLimitScopeType = "global" | "provider" | "project_host";

type HubSystemApi = {
  getParallelOpsStatus: () => Promise<ParallelOpsWorkerStatus[]>;
  setParallelOpsLimit: (opts: {
    worker_kind: string;
    scope_type?: ParallelOpsLimitScopeType;
    scope_id?: string;
    limit_value: number;
    note?: string;
  }) => Promise<unknown>;
  clearParallelOpsLimit: (opts: {
    worker_kind: string;
    scope_type?: ParallelOpsLimitScopeType;
    scope_id?: string;
  }) => Promise<unknown>;
};

function scopeKey(
  worker_kind: string,
  scope_type: ParallelOpsLimitScopeType,
  scope_id?: string,
) {
  return `${worker_kind}:${scope_type}:${scope_id ?? ""}`;
}

export function useParallelOps(
  hub: { system: HubSystemApi },
  opts: { enabled: boolean; pollMs?: number },
) {
  const { enabled, pollMs = 15000 } = opts;
  const [status, setStatus] = React.useState<ParallelOpsWorkerStatus[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [savingKey, setSavingKey] = React.useState<string>();

  const refresh = React.useCallback(async () => {
    if (!enabled) {
      setStatus([]);
      setError(undefined);
      return;
    }
    setLoading(true);
    try {
      const next = await hub.system.getParallelOpsStatus();
      setStatus(next ?? []);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    } finally {
      setLoading(false);
    }
  }, [enabled, hub]);

  React.useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  React.useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      refresh().catch(() => {});
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  const setLimit = React.useCallback(
    async (opts: {
      worker_kind: string;
      scope_type?: ParallelOpsLimitScopeType;
      scope_id?: string;
      limit_value: number;
    }) => {
      const key = scopeKey(
        opts.worker_kind,
        opts.scope_type ?? "global",
        opts.scope_id,
      );
      setSavingKey(key);
      try {
        await hub.system.setParallelOpsLimit(opts);
        await refresh();
      } catch (err) {
        alert_message({
          type: "error",
          message:
            err instanceof Error ? err.message : `Unable to set limit: ${err}`,
        });
      } finally {
        setSavingKey(undefined);
      }
    },
    [hub, refresh],
  );

  const clearLimit = React.useCallback(
    async (opts: {
      worker_kind: string;
      scope_type?: ParallelOpsLimitScopeType;
      scope_id?: string;
    }) => {
      const key = scopeKey(
        opts.worker_kind,
        opts.scope_type ?? "global",
        opts.scope_id,
      );
      setSavingKey(key);
      try {
        await hub.system.clearParallelOpsLimit(opts);
        await refresh();
      } catch (err) {
        alert_message({
          type: "error",
          message:
            err instanceof Error
              ? err.message
              : `Unable to clear limit: ${err}`,
        });
      } finally {
        setSavingKey(undefined);
      }
    },
    [hub, refresh],
  );

  return {
    status,
    loading,
    error,
    savingKey,
    refresh,
    setLimit,
    clearLimit,
  };
}
