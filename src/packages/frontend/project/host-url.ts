import { redux } from "@cocalc/frontend/app-framework";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { getHostInfo } from "@cocalc/frontend/projects/host-info";

export function getProjectHostBase(project_id: string): string {
  const project_map = redux.getStore("projects")?.get("project_map");
  const host_id = project_map?.getIn([project_id, "host_id"]) as
    | string
    | undefined;
  if (!host_id) return "";
  const info = getHostInfo(host_id);
  if (!info) {
    redux.getActions("projects")?.ensure_host_info(host_id);
    return "";
  }
  if (info.get("ready") === false) return "";
  if (info.get("local_proxy") && typeof window !== "undefined") {
    const basePath = appBasePath && appBasePath !== "/" ? appBasePath : "";
    return `${window.location.origin}${basePath}/${project_id}`;
  }
  return info.get("connect_url") || "";
}

export function withProjectHostBase(
  project_id: string,
  url?: string,
): string | undefined {
  if (!url) return url;
  if (/^https?:\/\//.test(url)) return url;
  const base = getProjectHostBase(project_id);
  if (!base) return url;
  const baseTrimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const path = url.startsWith("/") ? url : `/${url}`;
  return `${baseTrimmed}${path}`;
}
