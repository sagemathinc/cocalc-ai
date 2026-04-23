import basePath from "@cocalc/backend/base-path";
import getLogger from "@cocalc/backend/logger";
import siteURL from "@cocalc/database/settings/site-url";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOrigin } from "@cocalc/server/bay-public-origin";

const logger = getLogger("launchpad:bootstrap-url");

type BootstrapBase = {
  baseUrl: string;
  isPublic: boolean;
  source: "bay-public-origin" | "site-url" | "local-fallback";
};

function resolveLaunchpadPort(): number {
  const raw =
    process.env.COCALC_HTTP_PORT ??
    process.env.COCALC_BASE_PORT ??
    process.env.PORT ??
    "9001";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 9001;
}

function normalizeUrlHostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host.includes(":")) {
    return false;
  }
  return (
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  );
}

export function isPublicLaunchpadBootstrapOrigin(origin: string): boolean {
  const hostname = normalizeUrlHostname(origin);
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return false;
  }
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return false;
  }
  return true;
}

function assertPublicBootstrapBase(result: BootstrapBase): BootstrapBase {
  if (!result.isPublic) {
    throw new Error(
      `no public launchpad bootstrap URL configured; ${result.source} resolved ${result.baseUrl}`,
    );
  }
  return result;
}

export async function resolveLaunchpadBootstrapUrl(opts?: {
  fallbackHost?: string | null;
  fallbackProtocol?: string | null;
  preferCurrentBay?: boolean;
  requirePublic?: boolean;
}): Promise<BootstrapBase> {
  if (opts?.preferCurrentBay) {
    const bayOrigin = await getBayPublicOrigin(getConfiguredBayId());
    if (bayOrigin) {
      const result: BootstrapBase = {
        baseUrl: bayOrigin,
        isPublic: isPublicLaunchpadBootstrapOrigin(bayOrigin),
        source: "bay-public-origin",
      };
      return opts?.requirePublic ? assertPublicBootstrapBase(result) : result;
    }
  }
  const site = await siteURL();
  if (site) {
    const result: BootstrapBase = {
      baseUrl: site,
      isPublic: isPublicLaunchpadBootstrapOrigin(site),
      source: "site-url",
    };
    return opts?.requirePublic ? assertPublicBootstrapBase(result) : result;
  }
  const port = resolveLaunchpadPort();
  const host = opts?.fallbackHost ?? "localhost";
  const protocol = opts?.fallbackProtocol ?? "http";
  let path = basePath ?? "";
  if (path === "/") {
    path = "";
  }
  while (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  const base = `${protocol}://${host}:${port}${path}`;
  const result: BootstrapBase = {
    baseUrl: base,
    isPublic: isPublicLaunchpadBootstrapOrigin(base),
    source: "local-fallback",
  };
  logger.info("launchpad bootstrap url resolved", {
    host,
    port,
    protocol,
    local: true,
    has_cert: false,
  });
  return opts?.requirePublic ? assertPublicBootstrapBase(result) : result;
}
