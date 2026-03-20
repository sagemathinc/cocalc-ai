import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { URL } from "node:url";

import {
  connect as connectConat,
  type Client as ConatClient,
} from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import { isValidUUID } from "@cocalc/util/misc";
import { normalizeUrl } from "../core/utils";

type LiteConnectionInfo = {
  url?: string;
  protocol?: string;
  host?: string;
  port?: number;
  agent_token?: string;
};

export type CurrentProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export interface OpenCurrentProjectConnectionOptions {
  apiBaseUrl?: string;
  bearer?: string;
  projectId?: string;
  timeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export function defaultApiBaseUrl(): string {
  const fromEnv = process.env.COCALC_API_URL ?? process.env.BASE_URL;
  if (fromEnv?.trim()) {
    return normalizeUrl(fromEnv);
  }
  const raw = `http://127.0.0.1:${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`;
  return normalizeUrl(raw);
}

function isLoopbackHostName(hostname: string): boolean {
  const host = `${hostname ?? ""}`.trim().toLowerCase();
  if (!host) return false;
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function liteConnectionInfoPath(): string {
  const explicit =
    process.env.COCALC_LITE_CONNECTION_INFO ??
    process.env.COCALC_WRITE_CONNECTION_INFO;
  if (explicit?.trim()) return explicit.trim();
  return resolvePath(
    process.env.HOME?.trim() || process.cwd(),
    ".local/share/cocalc-lite/connection-info.json",
  );
}

function loadLiteConnectionInfo(): LiteConnectionInfo | undefined {
  try {
    const path = liteConnectionInfoPath();
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as LiteConnectionInfo;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function matchesLiteConnection(
  apiBaseUrl: string,
  info: LiteConnectionInfo,
): boolean {
  if (typeof info.url === "string" && info.url.trim()) {
    try {
      return normalizeUrl(info.url) === apiBaseUrl;
    } catch {
      // ignore malformed url
    }
  }
  try {
    const base = new URL(apiBaseUrl);
    const hostOk =
      typeof info.host === "string" &&
      info.host.trim().toLowerCase() === base.hostname.toLowerCase();
    const protocolOk =
      typeof info.protocol === "string"
        ? info.protocol.trim().toLowerCase().replace(/:$/, "") ===
          base.protocol.replace(/:$/, "").toLowerCase()
        : true;
    const port = Number(info.port ?? NaN);
    const basePort = Number(
      base.port || (base.protocol === "https:" ? 443 : 80),
    );
    const portOk = Number.isFinite(port) ? port === basePort : true;
    return hostOk && protocolOk && portOk;
  } catch {
    return false;
  }
}

function resolveCurrentProjectBearer(
  apiBaseUrl: string,
  explicit?: string,
): string {
  let bearer =
    `${explicit ?? process.env.COCALC_BEARER_TOKEN ?? process.env.COCALC_AGENT_TOKEN ?? ""}`.trim();
  if (bearer) return bearer;

  let hostname = "";
  try {
    hostname = new URL(apiBaseUrl).hostname;
  } catch {
    hostname = "";
  }
  if (isLoopbackHostName(hostname)) {
    const info = loadLiteConnectionInfo();
    if (info?.agent_token?.trim() && matchesLiteConnection(apiBaseUrl, info)) {
      bearer = info.agent_token.trim();
    }
  }
  return bearer;
}

async function openCurrentProjectConatClient({
  apiBaseUrl,
  bearer,
  timeoutMs,
  projectId,
}: {
  apiBaseUrl: string;
  bearer: string;
  timeoutMs: number;
  projectId: string;
}): Promise<ConatClient> {
  const client = connectConat({
    address: apiBaseUrl,
    noCache: true,
    reconnection: false,
    auth: async (cb) =>
      cb({
        bearer,
        project_id: projectId,
      }),
  });
  client.inboxPrefixHook = (info) => {
    const user = info?.user as
      | {
          account_id?: string;
          project_id?: string;
          hub_id?: string;
          host_id?: string;
        }
      | undefined;
    if (!user) return undefined;
    return inboxPrefix({
      account_id: user.account_id,
      project_id: user.project_id,
      hub_id: user.hub_id,
      host_id: user.host_id,
    });
  };
  try {
    await client.waitUntilSignedIn({ timeout: timeoutMs });
    return client;
  } catch (error) {
    try {
      client.close();
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
}

export async function openCurrentProjectConnection(
  options: OpenCurrentProjectConnectionOptions = {},
): Promise<{
  apiBaseUrl: string;
  bearer: string;
  projectId: string;
  client: ConatClient;
  project: CurrentProjectIdentity;
}> {
  const apiBaseUrl = options.apiBaseUrl
    ? normalizeUrl(options.apiBaseUrl)
    : defaultApiBaseUrl();
  const bearer = resolveCurrentProjectBearer(apiBaseUrl, options.bearer);
  if (!bearer) {
    throw new Error(
      "requires a bearer token; set COCALC_BEARER_TOKEN or pass options.bearer",
    );
  }
  const projectId =
    `${options.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
  if (!isValidUUID(projectId)) {
    throw new Error(
      "requires the current project id; set COCALC_PROJECT_ID or pass options.projectId",
    );
  }
  const client = await openCurrentProjectConatClient({
    apiBaseUrl,
    bearer,
    timeoutMs: options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    projectId,
  });
  return {
    apiBaseUrl,
    bearer,
    projectId,
    client,
    project: {
      project_id: projectId,
      title: projectId,
      host_id: null,
    },
  };
}
