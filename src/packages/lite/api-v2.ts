const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

export function isApiV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (`${env.COCALC_PRODUCT ?? ""}`.trim().toLowerCase() === "plus") {
    return false;
  }
  const configured = `${env.COCALC_LITE_API_V2 ?? ""}`.trim().toLowerCase();
  if (TRUE.has(configured)) return true;
  if (FALSE.has(configured)) return false;
  return `${env.COCALC_LAUNCHPAD_API_V2_ROUTES ?? ""}`.trim() === "1";
}

const HTTP_API = "@cocalc/http-api";
const importHttpApi = () => import("@cocalc/http-api");

/** True only if @cocalc/http-api itself can't be found, not a dependency of it. */
export function isMissingHttpApi(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }
  const firstLine = `${(err as { message?: unknown }).message ?? ""}`.split(
    "\n",
  )[0];
  return (
    firstLine.startsWith(`Cannot find module '${HTTP_API}'`) ||
    firstLine.startsWith(`Cannot find package '${HTTP_API}'`)
  );
}

/**
 * @cocalc/http-api, or undefined if this build doesn't include it (CoCalc Plus
 * bundles leave it out: plus/sea/build-bundle.sh).  Any other failure to load
 * it is thrown.
 */
export async function loadHttpApi(
  load: typeof importHttpApi = importHttpApi,
): Promise<Awaited<ReturnType<typeof importHttpApi>> | undefined> {
  try {
    return await load();
  } catch (err) {
    if (isMissingHttpApi(err)) return undefined;
    throw err;
  }
}
