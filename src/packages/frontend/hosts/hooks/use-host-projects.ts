import { React } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  HostBackupStatus,
  HostProjectStateFilter,
  HostProjectRow,
} from "@cocalc/conat/hub/api/hosts";

type Options = {
  hostId?: string;
  riskOnly?: boolean;
  stateFilter?: HostProjectStateFilter;
  projectState?: string;
  limit?: number;
  enabled?: boolean;
};

type HostProjectsState = {
  rows: HostProjectRow[];
  summary?: HostBackupStatus;
  nextCursor?: string;
  hostLastSeen?: string;
};

const EMPTY_STATE: HostProjectsState = {
  rows: [],
};

export function useHostProjects({
  hostId,
  riskOnly = false,
  stateFilter = "running",
  projectState,
  limit = 200,
  enabled = true,
}: Options) {
  const [state, setState] = React.useState<HostProjectsState>(EMPTY_STATE);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestSeqRef = React.useRef(0);
  const scopeKey = [
    hostId ?? "",
    enabled ? "1" : "0",
    riskOnly ? "1" : "0",
    stateFilter,
    projectState ?? "",
    `${limit}`,
  ].join("\0");

  const fetchPage = React.useCallback(
    async ({
      cursor,
      append,
      requestSeq,
    }: {
      cursor?: string;
      append?: boolean;
      requestSeq: number;
    }) => {
      if (!hostId || !enabled) return;
      const client = webapp_client.conat_client?.hub?.hosts;
      if (!client?.listHostProjects) return;
      try {
        const response = await client.listHostProjects({
          id: hostId,
          limit,
          cursor,
          risk_only: riskOnly,
          state_filter: stateFilter,
          ...(projectState ? { project_state: projectState } : {}),
        });
        if (requestSeq !== requestSeqRef.current) {
          return;
        }
        setState((prev) => ({
          rows: append
            ? prev.rows.concat(response.rows ?? [])
            : (response.rows ?? []),
          summary: response.summary,
          nextCursor: response.next_cursor,
          hostLastSeen: response.host_last_seen,
        }));
        setError(null);
      } catch (err) {
        if (requestSeq !== requestSeqRef.current) {
          return;
        }
        console.error("failed to load host projects", err);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [enabled, hostId, limit, projectState, riskOnly, stateFilter],
  );

  React.useEffect(() => {
    requestSeqRef.current += 1;
    setState(EMPTY_STATE);
    setLoading(false);
    setLoadingMore(false);
    setError(null);
  }, [scopeKey]);

  const refresh = React.useCallback(async () => {
    if (!hostId || !enabled) return;
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setLoadingMore(false);
    await fetchPage({ cursor: undefined, append: false, requestSeq });
    if (requestSeq === requestSeqRef.current) {
      setLoading(false);
    }
  }, [enabled, fetchPage, hostId]);

  const loadMore = React.useCallback(async () => {
    if (!hostId || !enabled) return;
    if (!state.nextCursor || loadingMore) return;
    const requestSeq = ++requestSeqRef.current;
    setLoadingMore(true);
    await fetchPage({
      cursor: state.nextCursor,
      append: true,
      requestSeq,
    });
    if (requestSeq === requestSeqRef.current) {
      setLoadingMore(false);
    }
  }, [enabled, fetchPage, hostId, loadingMore, state.nextCursor]);

  React.useEffect(() => {
    if (!hostId || !enabled) return;
    refresh().catch((err) => {
      console.error("failed to refresh host projects", err);
    });
  }, [enabled, hostId, limit, projectState, refresh, riskOnly, stateFilter]);
  return {
    ...state,
    loading,
    loadingMore,
    error,
    refresh,
    loadMore,
  };
}
