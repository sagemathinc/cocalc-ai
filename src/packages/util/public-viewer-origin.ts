/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function splitOriginish(value: string): {
  protocol?: string;
  hostname: string;
  port?: string;
} | null {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    return {
      protocol: /^https?:\/\//i.test(raw) ? parsed.protocol : undefined,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
    };
  } catch {
    return null;
  }
}

function buildOriginish({
  protocol,
  hostname,
  port,
}: {
  protocol?: string;
  hostname: string;
  port?: string;
}): string {
  const host = port ? `${hostname}:${port}` : hostname;
  if (protocol) {
    return trimTrailingSlash(`${protocol}//${host}`);
  }
  return host;
}

export function derivePublicViewerHostname(
  hostname: string,
): string | undefined {
  const clean = `${hostname ?? ""}`.trim().toLowerCase();
  if (!clean) return;
  const labels = clean.split(".");
  if (labels.some((label) => label === "")) return;
  const first = labels[0];
  if (first === "raw" || first.endsWith("-raw")) {
    return clean;
  }
  if (labels.length <= 2) {
    return `raw.${clean}`;
  }
  return [`${first}-raw`, ...labels.slice(1)].join(".");
}

export function derivePublicViewerDns(dns: string): string | undefined {
  const parsed = splitOriginish(dns);
  if (!parsed) return;
  const hostname = derivePublicViewerHostname(parsed.hostname);
  if (!hostname) return;
  return buildOriginish({ ...parsed, hostname });
}

export function resolvePublicViewerDns(opts: {
  publicViewerDns?: string;
  dns?: string;
}): string | undefined {
  const explicit = `${opts.publicViewerDns ?? ""}`.trim();
  if (explicit) {
    const parsed = splitOriginish(explicit);
    if (!parsed) return;
    return buildOriginish(parsed);
  }
  return derivePublicViewerDns(`${opts.dns ?? ""}`);
}

export function normalizeOriginUrl(value: string): string | undefined {
  const parsed = splitOriginish(value);
  if (!parsed) return;
  const protocol = parsed.protocol ?? "https:";
  return trimTrailingSlash(
    `${protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
  );
}

export function allowedPublicViewerSourceBaseHosts(
  viewerHostname: string,
): string[] {
  const clean = `${viewerHostname ?? ""}`.trim().toLowerCase();
  if (!clean) return [];
  const labels = clean.split(".");
  if (labels.some((label) => label === "")) return [];
  const out = new Set<string>([clean]);
  const first = labels[0];
  if (first === "raw" && labels.length > 1) {
    out.add(labels.slice(1).join("."));
  } else if (first.endsWith("-raw") && first.length > 4) {
    out.add([first.slice(0, -4), ...labels.slice(1)].join("."));
  }
  return [...out];
}

export function isAllowedPublicViewerSourceHost(opts: {
  sourceHostname: string;
  viewerHostname: string;
}): boolean {
  const source = `${opts.sourceHostname ?? ""}`.trim().toLowerCase();
  if (!source) return false;
  return allowedPublicViewerSourceBaseHosts(opts.viewerHostname).some(
    (baseHost) =>
      source === baseHost ||
      source.endsWith(`.${baseHost}`) ||
      source.endsWith(`-${baseHost}`),
  );
}
