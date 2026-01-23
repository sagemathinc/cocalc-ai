import basePath from "@cocalc/backend/base-path";
import getLogger from "@cocalc/backend/logger";
import { getLaunchpadMode } from "./mode";
import siteURL from "@cocalc/database/settings/site-url";

const logger = getLogger("launchpad:bootstrap-url");

type BootstrapBase = {
  baseUrl: string;
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

export async function resolveLaunchpadBootstrapUrl(opts?: {
  fallbackHost?: string | null;
  fallbackProtocol?: string | null;
}): Promise<BootstrapBase> {
  void opts;
  const mode = await getLaunchpadMode();
  const localMode = mode === "local";
  if (!localMode) {
    return { baseUrl: await siteURL() };
  }
  const port = resolveLaunchpadPort();
  const host = "localhost";
  const protocol = "http";
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
    local: true,
    has_cert: false,
  });
  return { baseUrl: base };
}
