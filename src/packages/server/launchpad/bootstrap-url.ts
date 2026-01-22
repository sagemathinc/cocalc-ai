import { readFileSync } from "node:fs";
import basePath from "@cocalc/backend/base-path";
import getLogger from "@cocalc/backend/logger";
import { getLaunchpadMode } from "./mode";
import siteURL from "@cocalc/database/settings/site-url";

const logger = getLogger("launchpad:bootstrap-url");

type BootstrapBase = {
  baseUrl: string;
  caCert?: string;
};

function normalizeHost(raw?: string | null): string {
  const value = String(raw ?? "").trim();
  if (!value) return "localhost";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      return new URL(value).hostname || "localhost";
    } catch {
      return "localhost";
    }
  }
  return value;
}

function resolveLaunchpadHost(fallbackHost?: string | null): string {
  const raw =
    process.env.COCALC_LAUNCHPAD_HOST ??
    process.env.HOST ??
    process.env.COCALC_HUB_HOSTNAME ??
    fallbackHost ??
    "localhost";
  const normalized = normalizeHost(raw);
  if (normalized === "0.0.0.0" || normalized === "::") {
    logger.warn("launchpad host is a bind address; use a reachable hostname", {
      host: normalized,
    });
  }
  return normalized;
}

function isLocalHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return (
    value === "localhost" ||
    value === "127.0.0.1" ||
    value === "::1" ||
  );
}

function resolveLaunchpadPort(): number {
  const raw =
    process.env.PORT ??
    process.env.COCALC_HTTPS_PORT ??
    process.env.COCALC_BASE_PORT ??
    "8443";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 8443;
}

function resolveLaunchpadCert(): string | undefined {
  const certPath = process.env.COCALC_LAUNCHPAD_HTTPS_CERT;
  if (!certPath) return undefined;
  try {
    return readFileSync(certPath, "utf8");
  } catch (err) {
    logger.warn("launchpad: unable to read TLS cert", { certPath, err });
    return undefined;
  }
}

export async function resolveLaunchpadBootstrapUrl(opts?: {
  fallbackHost?: string | null;
  fallbackProtocol?: string | null;
}): Promise<BootstrapBase> {
  const mode = await getLaunchpadMode();
  if (process.env.COCALC_MODE !== "launchpad" || mode !== "onprem") {
    return { baseUrl: await siteURL() };
  }
  const host = resolveLaunchpadHost(opts?.fallbackHost);
  const port = resolveLaunchpadPort();
  const local = isLocalHost(host);
  const caCert = resolveLaunchpadCert();
  let protocol = "http";
  if (local) {
    protocol = caCert ? "https" : "http";
  } else {
    protocol = caCert ? "https" : "http";
    if (!caCert) {
      logger.warn("launchpad onprem bootstrap using http (no TLS cert found)", {
        host,
        port,
      });
    }
  }
  if (opts?.fallbackProtocol && !caCert) {
    protocol = opts.fallbackProtocol;
  }
  let path = basePath ?? "";
  if (path === "/") {
    path = "";
  }
  while (path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  const base = `${protocol}://${host}:${port}${path}`;
  return { baseUrl: base, caCert: protocol === "https" ? caCert : undefined };
}
