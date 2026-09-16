import { useEffect, useRef, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { Map as ImmutableMap } from "immutable";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export type ProjectHostConnectionState = {
  connected: boolean;
  observed: boolean;
  unavailableSince?: string;
};

export function unavailableSinceForHostStatusTransition({
  previousStatus,
  status,
  unavailableSince,
  now = new Date().toISOString(),
}: {
  previousStatus?: string;
  status?: string;
  unavailableSince?: string;
  now?: string;
}): string | undefined {
  const starting = status === "starting" || status === "restarting";
  const wasStarting =
    previousStatus === "starting" || previousStatus === "restarting";
  const enteringStartup = starting && !wasStarting;
  return enteringStartup ? now : unavailableSince;
}

export function isPublicDirectoryShareHost(
  host_id?: string,
  projectMap: ImmutableMap<string, any> | undefined = redux
    .getStore("projects")
    ?.get("project_map"),
): boolean {
  if (!host_id) return false;
  const hostInfo = redux.getStore("projects")?.get("host_info")?.get(host_id);
  if (
    hostInfo?.get("public_directory_share_connection") === true ||
    hostInfo?.get("temporary_public_share_viewer_grant") === true
  ) {
    return true;
  }
  if (projectMap == null) return false;
  return projectMap.some?.(
    (project) =>
      project?.get?.("host_id") === host_id &&
      project?.get?.("public_directory_share_projection") === true,
  );
}

export function getHostInfo(
  host_id?: string,
): ImmutableMap<string, any> | undefined {
  if (!host_id) return;
  return redux.getStore("projects")?.get("host_info")?.get(host_id);
}

export function useHostInfo(
  host_id?: string,
  opts?: { enabled?: boolean },
): ImmutableMap<string, any> | undefined {
  const hostInfo = useTypedRedux("projects", "host_info")?.get(host_id ?? "");
  const projectMap = useTypedRedux("projects", "project_map");
  const publicDirectoryShareHost = isPublicDirectoryShareHost(
    host_id,
    projectMap,
  );
  const enabled = opts?.enabled !== false;
  useEffect(() => {
    if (!enabled || !host_id || publicDirectoryShareHost) return;
    redux.getActions("projects")?.ensure_host_info(host_id);
  }, [enabled, host_id, publicDirectoryShareHost]);
  return hostInfo;
}

export function useProjectHostConnectionState(
  host_id?: string,
  hostStatus?: string,
): ProjectHostConnectionState {
  const client = webapp_client.conat_client;
  const [state, setState] = useState<ProjectHostConnectionState>(() => {
    const connected = !!client?.isProjectHostConnected?.(host_id);
    return { connected, observed: connected };
  });
  const previousHostStatus = useRef<{
    hostId?: string;
    status?: string;
  }>({});
  useEffect(() => {
    const initiallyConnected = !!client?.isProjectHostConnected?.(host_id);
    setState({ connected: initiallyConnected, observed: initiallyConnected });
    const connected = (changedHostId?: string) => {
      if (changedHostId != null && changedHostId !== host_id) return;
      setState({ connected: true, observed: true });
    };
    const disconnected = (changedHostId?: string) => {
      if (changedHostId != null && changedHostId !== host_id) return;
      setState((previous) => ({
        connected: false,
        observed: true,
        unavailableSince: previous.unavailableSince ?? new Date().toISOString(),
      }));
    };
    if (initiallyConnected) {
      connected();
    }
    client?.on?.("project-host-connected", connected);
    client?.on?.("project-host-disconnected", disconnected);
    return () => {
      client?.removeListener?.("project-host-connected", connected);
      client?.removeListener?.("project-host-disconnected", disconnected);
    };
  }, [client, host_id]);
  useEffect(() => {
    const previousStatus =
      previousHostStatus.current.hostId === host_id
        ? previousHostStatus.current.status
        : undefined;
    previousHostStatus.current = { hostId: host_id, status: hostStatus };
    setState((previous) => {
      const unavailableSince = unavailableSinceForHostStatusTransition({
        previousStatus,
        status: hostStatus,
        unavailableSince: previous.unavailableSince,
      });
      return unavailableSince === previous.unavailableSince
        ? previous
        : { ...previous, unavailableSince };
    });
  }, [host_id, hostStatus]);
  return state;
}

export function useProjectHostConnected(host_id?: string): boolean {
  return useProjectHostConnectionState(host_id).connected;
}

export function getHostName(host_id?: string): string | undefined {
  const info = getHostInfo(host_id);
  const name = info?.get?.("name");
  return typeof name === "string" ? name : undefined;
}
