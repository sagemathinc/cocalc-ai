import { useEffect } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import type { Map as ImmutableMap } from "immutable";

export function getHostInfo(
  host_id?: string,
): ImmutableMap<string, any> | undefined {
  if (!host_id) return;
  return redux.getStore("projects")?.get("host_info")?.get(host_id);
}

export function useHostInfo(
  host_id?: string,
): ImmutableMap<string, any> | undefined {
  const hostInfo = useTypedRedux("projects", "host_info")?.get(host_id ?? "");
  useEffect(() => {
    if (!host_id) return;
    redux.getActions("projects")?.ensure_host_info(host_id);
  }, [host_id]);
  return hostInfo;
}

export function getHostName(host_id?: string): string | undefined {
  const info = getHostInfo(host_id);
  const name = info?.get?.("name");
  return typeof name === "string" ? name : undefined;
}
