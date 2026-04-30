/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const DEFAULT_ONPREM_MASTER_CONAT_TUNNEL_LOCAL_PORT = 9346;

function trim(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function parseEnabled(value: unknown): boolean {
  const lowered = trim(value).toLowerCase();
  if (!lowered) return false;
  return !["0", "false", "no", "off", "disabled"].includes(lowered);
}

function parsePortFromUrl(value: string): number | undefined {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function parsePort(value: unknown): number | undefined {
  const parsed = Number.parseInt(trim(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function isProjectHostDevGcpReverseTunnelEnabled(): boolean {
  return parseEnabled(process.env.COCALC_DEV_GCP_REVERSE_TUNNEL);
}

export function resolveProjectHostBootstrapMasterConatServer():
  | string
  | undefined {
  return (
    trim(process.env.COCALC_BOOTSTRAP_MASTER_CONAT_SERVER) ||
    trim(process.env.MASTER_CONAT_SERVER) ||
    trim(process.env.COCALC_MASTER_CONAT_SERVER) ||
    undefined
  );
}

export function resolveProjectHostTunneledMasterConatLocalPort():
  | number
  | undefined {
  const explicitUrl = trim(process.env.COCALC_TUNNELED_MASTER_CONAT_SERVER);
  if (explicitUrl) {
    return parsePortFromUrl(explicitUrl);
  }
  const explicitPort = parsePort(
    process.env.COCALC_ONPREM_MASTER_CONAT_TUNNEL_LOCAL_PORT,
  );
  if (explicitPort) return explicitPort;
  if (!isProjectHostDevGcpReverseTunnelEnabled()) return undefined;
  return DEFAULT_ONPREM_MASTER_CONAT_TUNNEL_LOCAL_PORT;
}

export function resolveProjectHostTunneledMasterConatServer():
  | string
  | undefined {
  const explicit = trim(process.env.COCALC_TUNNELED_MASTER_CONAT_SERVER);
  if (explicit) return explicit;
  const port = resolveProjectHostTunneledMasterConatLocalPort();
  if (!port) return undefined;
  return `http://127.0.0.1:${port}`;
}

export function resolveProjectHostPreferredMasterConatServer():
  | string
  | undefined {
  return (
    resolveProjectHostTunneledMasterConatServer() ??
    resolveProjectHostBootstrapMasterConatServer()
  );
}
