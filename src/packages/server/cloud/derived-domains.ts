/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

function clean(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = `${value}`.trim();
  return trimmed || undefined;
}

export function normalizeCloudflareHostname(
  value: unknown,
): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  let host = raw;
  if (host.startsWith("http://") || host.startsWith("https://")) {
    try {
      host = new URL(host).host;
    } catch {
      host = host.replace(/^https?:\/\//, "");
    }
  }
  host = host.split("/")[0];
  if (host.includes(":")) {
    host = host.split(":")[0];
  }
  return host.toLowerCase().replace(/\.+$/, "") || undefined;
}

export function normalizeProjectHostSuffix(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const trimmed = raw.toLowerCase();
  const lead = trimmed[0];
  const hasExplicitSeparator = lead === "." || lead === "-";
  const separator = hasExplicitSeparator ? lead : "-";
  const rest = hasExplicitSeparator ? trimmed.slice(1) : trimmed;
  const host = normalizeCloudflareHostname(rest) ?? clean(rest);
  if (!host) return undefined;
  return `${separator}${host}`;
}

function explicitProjectHostSuffix(
  value: unknown,
  siteHostname?: string,
): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const trimmed = raw.toLowerCase();
  const lead = trimmed[0];
  const hasExplicitSeparator = lead === "." || lead === "-";
  const separator = hasExplicitSeparator ? lead : "-";
  const rest = hasExplicitSeparator ? trimmed.slice(1) : trimmed;
  const host = normalizeCloudflareHostname(rest) ?? clean(rest);
  if (!host) return undefined;
  if (host.includes(".") || !siteHostname) {
    return `${separator}${host}`;
  }
  if (siteHostname === host || siteHostname.startsWith(`${host}.`)) {
    return `${separator}${siteHostname}`;
  }
  return `${separator}${host}.${siteHostname}`;
}

export function deriveProjectHostSuffix(settings: {
  dns?: unknown;
  project_hosts_cloudflare_tunnel_host_suffix?: unknown;
}): string | undefined {
  const siteHostname = normalizeCloudflareHostname(settings.dns);
  return (
    explicitProjectHostSuffix(
      settings.project_hosts_cloudflare_tunnel_host_suffix,
      siteHostname,
    ) ??
    normalizeProjectHostSuffix(siteHostname ? `-${siteHostname}` : undefined)
  );
}

export function deriveProjectHostHostname(
  host_id: string,
  settings: {
    dns?: unknown;
    project_hosts_cloudflare_tunnel_host_suffix?: unknown;
  },
): string | undefined {
  const suffix = deriveProjectHostSuffix(settings);
  if (!host_id || !suffix) return undefined;
  return `host-${host_id}${suffix}`;
}

export function deriveProjectHostSshHostname(
  host_id: string,
  settings: {
    dns?: unknown;
    project_hosts_cloudflare_tunnel_host_suffix?: unknown;
  },
): string | undefined {
  const suffix = deriveProjectHostSuffix(settings);
  if (!host_id || !suffix) return undefined;
  return `ssh-host-${host_id}${suffix}`;
}
