import basePath from "@cocalc/backend/base-path";
import getLogger from "@cocalc/backend/logger";
import siteURL from "@cocalc/database/settings/site-url";

const logger = getLogger("launchpad:bootstrap-url");

type BootstrapBase = {
  baseUrl: string;
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

export async function resolveLaunchpadBootstrapUrl(opts?: {
  fallbackHost?: string | null;
  fallbackProtocol?: string | null;
}): Promise<BootstrapBase> {
  const site = await siteURL();
  if (site) {
    return { baseUrl: site };
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
  logger.info("launchpad bootstrap url resolved", {
    host,
    port,
    protocol,
    local: true,
    has_cert: false,
  });
  return { baseUrl: base };
}
