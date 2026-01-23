import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";

const logger = getLogger("server:launchpad:mode");

export type CocalcProduct = "plus" | "launchpad" | "rocket";
export type LaunchpadMode = "unset" | "local" | "cloud";

const VALID_PRODUCTS: CocalcProduct[] = ["plus", "launchpad", "rocket"];
const VALID_MODES: LaunchpadMode[] = ["unset", "local", "cloud"];

function normalizeProduct(value?: string | null): CocalcProduct | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  const product = raw.toLowerCase();
  if ((VALID_PRODUCTS as string[]).includes(product)) {
    return product as CocalcProduct;
  }
  throw new Error(`Invalid COCALC_PRODUCT '${raw}'`);
}

let cachedProduct: CocalcProduct | undefined;
let warnedProduct = false;
let warnedLegacyMode = false;

export function getCocalcProduct(): CocalcProduct {
  if (cachedProduct) return cachedProduct;
  const envProduct = normalizeProduct(process.env.COCALC_PRODUCT);
  if (envProduct) {
    cachedProduct = envProduct;
    return envProduct;
  }
  if (process.env.COCALC_MODE && !warnedLegacyMode) {
    warnedLegacyMode = true;
    logger.warn("COCALC_MODE is deprecated and ignored; use COCALC_PRODUCT", {
      mode: process.env.COCALC_MODE,
    });
  }
  if (!warnedProduct) {
    warnedProduct = true;
    logger.warn("COCALC_PRODUCT not set; defaulting to plus");
  }
  cachedProduct = "plus";
  return cachedProduct;
}

export function isLaunchpadProduct(): boolean {
  return getCocalcProduct() === "launchpad";
}

export function isRocketProduct(): boolean {
  return getCocalcProduct() === "rocket";
}

function normalizeMode(value?: string | null): LaunchpadMode {
  const mode = (value ?? "").trim().toLowerCase();
  if ((VALID_MODES as string[]).includes(mode)) {
    return mode as LaunchpadMode;
  }
  return "unset";
}

let warnedLegacyDeployment = false;

export async function getLaunchpadMode(): Promise<LaunchpadMode> {
  const envMode = process.env.COCALC_DEPLOYMENT_MODE;
  if (envMode) {
    return normalizeMode(envMode);
  }
  const legacyEnv = process.env.COCALC_LAUNCHPAD_MODE;
  if (legacyEnv) {
    if (!warnedLegacyDeployment) {
      warnedLegacyDeployment = true;
      logger.warn("COCALC_LAUNCHPAD_MODE is deprecated; use COCALC_DEPLOYMENT_MODE", {
        mode: legacyEnv,
      });
    }
    return normalizeMode(legacyEnv);
  }
  const settings = await getServerSettings();
  return normalizeMode(settings.launchpad_mode);
}

export async function requireLaunchpadModeSelected(): Promise<LaunchpadMode> {
  if (!isLaunchpadProduct() && !isRocketProduct()) {
    return "cloud";
  }
  const mode = await getLaunchpadMode();
  if (mode === "unset") {
    throw new Error(
      "Launchpad mode not selected. Set Admin Settings → Launchpad Mode or COCALC_DEPLOYMENT_MODE.",
    );
  }
  return mode;
}

export type LaunchpadLocalConfig = {
  mode: LaunchpadMode;
  http_port?: number;
  https_port?: number;
  sshd_port?: number;
  ssh_user?: string;
  sftp_root?: string;
};

export function getLaunchpadLocalConfig(
  modeOverride?: LaunchpadMode,
): LaunchpadLocalConfig {
  const mode = modeOverride ?? normalizeMode(process.env.COCALC_DEPLOYMENT_MODE);
  const basePortRaw =
    process.env.COCALC_BASE_PORT ??
    process.env.COCALC_HTTPS_PORT ??
    process.env.PORT ??
    "";
  const basePortParsed = Number.parseInt(basePortRaw, 10);
  const basePort = Number.isFinite(basePortParsed) ? basePortParsed : 8443;
  const httpsPortRaw = process.env.COCALC_HTTPS_PORT ?? process.env.PORT ?? "";
  const httpsPortParsed = Number.parseInt(httpsPortRaw, 10);
  const httpsPort = Number.isFinite(httpsPortParsed)
    ? httpsPortParsed
    : basePort;
  const httpPortRaw = process.env.COCALC_HTTP_PORT ?? "";
  const httpPortParsed = Number.parseInt(httpPortRaw, 10);
  const httpPort = Number.isFinite(httpPortParsed)
    ? httpPortParsed
    : mode === "local"
      ? basePort
      : Math.max(basePort - 1, 1);
  const sshdPortRaw = process.env.COCALC_SSHD_PORT ?? "";
  const sshdPortParsed = Number.parseInt(sshdPortRaw, 10);
  const sshdPort = Number.isFinite(sshdPortParsed)
    ? sshdPortParsed
    : basePort + 1;
  const dataDir = process.env.COCALC_DATA_DIR ?? process.env.DATA;
  const sftpRoot =
    process.env.COCALC_SFTP_ROOT ??
    (dataDir ? `${dataDir}/backup-repo` : undefined);
  const sshUser =
    process.env.COCALC_SSHD_USER ??
    process.env.USER ??
    process.env.LOGNAME ??
    undefined;

  return {
    mode,
    http_port: Number.isFinite(httpPort) ? httpPort : undefined,
    https_port: Number.isFinite(httpsPort) ? httpsPort : undefined,
    sshd_port: Number.isFinite(sshdPort) ? sshdPort : undefined,
    ssh_user: sshUser,
    sftp_root: sftpRoot,
  };
}
