import { gcpInternalHostname } from "@cocalc/cloud";
import type { HostRuntime } from "@cocalc/cloud/types";

export const DEFAULT_GCP_PROJECT_HOST_TUNNEL_PORT = 9002;
export const DEFAULT_GCP_BAY_ROUTER_PORT = 9102;

function trim(value: unknown): string {
  return `${value ?? ""}`.trim();
}

export function resolveGcpRuntimeInternalHostname(
  runtime?: HostRuntime | null,
): string | undefined {
  return gcpInternalHostname({
    configuredHostname:
      trim(runtime?.internal_hostname) ||
      trim(runtime?.metadata?.internal_hostname) ||
      undefined,
    instanceName: trim(runtime?.instance_id) || undefined,
    projectId:
      trim(runtime?.metadata?.gcp_project_id) ||
      trim(runtime?.metadata?.project_id) ||
      undefined,
  });
}

export function resolveGcpManagedHostInternalUrl({
  runtime,
  tunnelEnabled,
}: {
  runtime?: HostRuntime | null;
  tunnelEnabled: boolean;
}): string | undefined {
  const hostname = resolveGcpRuntimeInternalHostname(runtime);
  if (!hostname) return;
  if (tunnelEnabled) {
    return `http://${hostname}:${DEFAULT_GCP_PROJECT_HOST_TUNNEL_PORT}`;
  }
  return `https://${hostname}`;
}

export function resolveGcpInternalConatUrl({
  currentAddress,
  bayInternalHostname,
  routerPort = DEFAULT_GCP_BAY_ROUTER_PORT,
}: {
  currentAddress?: string | null;
  bayInternalHostname?: string | null;
  routerPort?: number;
}): string | undefined {
  const host = trim(bayInternalHostname).toLowerCase();
  if (!host) return;
  let pathname = "";
  let search = "";
  try {
    const parsed = new URL(trim(currentAddress));
    pathname = parsed.pathname === "/" ? "" : parsed.pathname;
    search = parsed.search;
  } catch {
    // fall back to a plain origin
  }
  return `http://${host}:${routerPort}${pathname}${search}`;
}
