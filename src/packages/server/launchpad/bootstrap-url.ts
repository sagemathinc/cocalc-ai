import { readFileSync } from "node:fs";
import basePath from "@cocalc/backend/base-path";
import getLogger from "@cocalc/backend/logger";
import { resolveOnPremHost, isLocalHost } from "@cocalc/server/onprem";
import { getLaunchpadMode } from "./mode";
import siteURL from "@cocalc/database/settings/site-url";

const logger = getLogger("launchpad:bootstrap-url");

type BootstrapBase = {
  baseUrl: string;
  caCert?: string;
};

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
  const localMode = mode === "local";
  if (!localMode) {
    return { baseUrl: await siteURL() };
  }
  const host = resolveOnPremHost(opts?.fallbackHost);
  const port = resolveLaunchpadPort();
  const local = isLocalHost(host);
  const caCert = resolveLaunchpadCert();
  let protocol = "http";
  if (local) {
    protocol = caCert ? "https" : "http";
  } else {
    protocol = caCert ? "https" : "http";
    if (!caCert) {
      logger.warn("launchpad local bootstrap using http (no TLS cert found)", {
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
  logger.info("launchpad bootstrap url resolved", {
    mode,
    host,
    port,
    protocol,
    local,
    has_cert: Boolean(caCert),
  });
  return { baseUrl: base, caCert: protocol === "https" ? caCert : undefined };
}
