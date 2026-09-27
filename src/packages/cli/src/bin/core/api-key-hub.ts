import type { ApiProjectSummaryPage } from "@cocalc/conat/hub/api/projects";
import type { Client } from "@cocalc/conat/core/client";

export function reconnectApiKeyProjectHostAfterLease(
  client: Client,
  invalidateToken: () => void,
): void {
  const disconnected = (reason: string) => {
    if (reason !== "io server disconnect" || client.state === "closed") return;
    // Socket.IO does not reconnect a server-disconnected namespace. A new
    // handshake must obtain current authority, never reuse the expired lease.
    invalidateToken();
    client.conn.connect();
  };
  client.conn.on("disconnect", disconnected);
  client.once("closed", () => client.conn.off("disconnect", disconnected));
}

export async function callHubWithApiKey<T>({
  apiBaseUrl,
  apiKey,
  name,
  args,
  timeoutMs = 10_000,
}: {
  apiBaseUrl: string;
  apiKey: string;
  name: string;
  args: unknown[];
  timeoutMs?: number;
}): Promise<T> {
  const response = await fetch(new URL("/api/conat/hub", apiBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw Error(`API request failed (${response.status})`);
  const value = await response.json();
  if (value?.error) throw Error(`${value.error}`);
  return value as T;
}

export async function listProjectsWithApiKey({
  apiBaseUrl,
  apiKey,
  project_id,
  limit,
  offset,
  search,
}: {
  apiBaseUrl: string;
  apiKey: string;
  project_id?: string;
  limit: number;
  offset: number;
  search?: string;
}): Promise<ApiProjectSummaryPage> {
  const value = await callHubWithApiKey<ApiProjectSummaryPage>({
    apiBaseUrl,
    apiKey,
    name: "projects.listProjectSummaries",
    args: [{ project_id, limit, offset, search }],
  });
  if (!Array.isArray(value?.projects)) {
    throw Error("invalid project list response");
  }
  return value as ApiProjectSummaryPage;
}

export interface ApiKeyProjectHostAccess {
  project_id: string;
  title: string;
  host_id: string;
  connect_url: string | null;
  local_proxy: boolean;
  token: string;
  expires_at: number;
}

export async function getProjectHostAccessWithApiKey({
  apiBaseUrl,
  apiKey,
  project_id,
  http_proxy_port,
}: {
  apiBaseUrl: string;
  apiKey: string;
  project_id: string;
  http_proxy_port?: number;
}): Promise<ApiKeyProjectHostAccess> {
  const response = await fetch(
    new URL("/api/conat/project-host-api-key", apiBaseUrl),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project_id, http_proxy_port }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw Error(`project-host access HTTP request failed (${response.status})`);
  }
  const value = await response.json();
  if (value?.error) throw Error(`${value.error}`);
  if (
    value?.project_id !== project_id ||
    typeof value?.host_id !== "string" ||
    typeof value?.token !== "string" ||
    !Number.isFinite(value?.expires_at)
  ) {
    throw Error("invalid project-host access response");
  }
  return value as ApiKeyProjectHostAccess;
}
