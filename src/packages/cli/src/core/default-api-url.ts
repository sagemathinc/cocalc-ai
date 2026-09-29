import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeUrl } from "./utils";

export type LiteConnectionInfo = {
  url?: string;
  protocol?: string;
  host?: string;
  port?: number;
  agent_token?: string;
  account_id?: string;
};

export function loadLiteConnectionInfo(
  env: NodeJS.ProcessEnv = process.env,
): LiteConnectionInfo | undefined {
  const explicit =
    env.COCALC_LITE_CONNECTION_INFO ?? env.COCALC_WRITE_CONNECTION_INFO;
  const path =
    explicit?.trim() ||
    join(
      env.HOME?.trim() || process.cwd(),
      ".local/share/cocalc-lite/connection-info.json",
    );
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LiteConnectionInfo;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Resolve the configured default independently of any caller's --api override.
export function defaultApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv =
    env.COCALC_API_URL ??
    env.BASE_URL ??
    (env.COCALC_API_RELAY === "1" ? env.COCALC_API_RELAY_HUB_URL : undefined);
  if (fromEnv?.trim()) return normalizeUrl(fromEnv);
  const info = loadLiteConnectionInfo(env);
  if (info?.url?.trim()) return normalizeUrl(info.url);
  return normalizeUrl(`http://127.0.0.1:${env.HUB_PORT ?? env.PORT ?? "9100"}`);
}
