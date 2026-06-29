import { useEffect } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { Map as ImmutableMap } from "immutable";

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

export function getHostName(host_id?: string): string | undefined {
  const info = getHostInfo(host_id);
  const name = info?.get?.("name");
  return typeof name === "string" ? name : undefined;
}
