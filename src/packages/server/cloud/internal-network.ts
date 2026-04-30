import { gcpInternalHostname } from "@cocalc/cloud";
import type { HostRuntime } from "@cocalc/cloud/types";

export const DEFAULT_GCP_PROJECT_HOST_TUNNEL_PORT = 9002;
export const DEFAULT_GCP_BAY_ROUTER_PORT = 9102;

function trim(value: unknown): string {
  return `${value ?? ""}`.trim();
}

export function isDevGcpReverseTunnelEnabled(value?: unknown): boolean {
  const normalized = trim(
    value ?? process.env.COCALC_DEV_GCP_REVERSE_TUNNEL,
  ).toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no", "off", "disabled"].includes(normalized);
}

export function resolveGcpRuntimeInternalHostname(
  runtime?: HostRuntime | null,
  opts: {
    fallbackProjectId?: string | null;
  } = {},
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
      trim(opts.fallbackProjectId) ||
      undefined,
  });
}

export function resolveGcpManagedHostInternalUrl({
  runtime,
  tunnelEnabled,
  fallbackProjectId,
}: {
  runtime?: HostRuntime | null;
  tunnelEnabled: boolean;
  fallbackProjectId?: string | null;
}): string | undefined {
  const hostname = resolveGcpRuntimeInternalHostname(runtime, {
    fallbackProjectId,
  });
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

function hostnameLabel(value?: string | null): string | undefined {
  const host = trim(value).toLowerCase().replace(/\.$/, "");
  if (!host) return undefined;
  return host.split(".")[0] || undefined;
}

export function shouldUseGcpInternalConatUrl({
  currentAddress,
  bayInternalHostname,
  mode,
}: {
  currentAddress?: string | null;
  bayInternalHostname?: string | null;
  mode?: string | null;
}): boolean {
  const normalizedMode = trim(mode).toLowerCase();
  if (
    ["0", "false", "off", "never", "disable", "disabled"].includes(
      normalizedMode,
    )
  ) {
    return false;
  }
  const internalLabel = hostnameLabel(bayInternalHostname);
  if (!internalLabel) return false;
  if (
    ["1", "true", "on", "always", "force", "enabled"].includes(normalizedMode)
  ) {
    return true;
  }
  const address = trim(currentAddress);
  if (!address) return false;
  try {
    const parsed = new URL(address);
    const currentHost = `${parsed.hostname ?? ""}`.trim().toLowerCase();
    if (!currentHost) return false;
    if (
      currentHost === trim(bayInternalHostname).toLowerCase().replace(/\.$/, "")
    ) {
      return true;
    }
    return hostnameLabel(currentHost) === internalLabel;
  } catch {
    return false;
  }
}
