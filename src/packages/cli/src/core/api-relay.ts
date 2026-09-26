import {
  API_RELAY_PATH,
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
  API_RELAY_HUB_HEADER,
  normalizeApiRelayHubUrl,
} from "@cocalc/conat/project-host/api-relay";
import { resolveProjectScopedAuth } from "./auth-cookies";
import { normalizeUrl } from "./utils";

export function projectApiRelayTransport({
  apiBaseUrl,
  host,
  env = process.env,
}: {
  apiBaseUrl: string;
  host?: { host_id: string; project_id: string };
  env?: NodeJS.ProcessEnv;
}): { address: string; extraHeaders: Record<string, string> } | undefined {
  if (env.COCALC_API_RELAY !== "1") return;
  const hub = normalizeApiRelayHubUrl(apiBaseUrl);
  const auth = resolveProjectScopedAuth(env);
  if (!auth || !env.CONAT_SERVER) {
    throw Error(
      "project API relay requires the current project's local connection and secret",
    );
  }
  const root = new URL(env.CONAT_SERVER);
  if (
    !/^https?:$/.test(root.protocol) ||
    root.username ||
    root.password ||
    root.search ||
    root.hash
  ) {
    throw Error("invalid project API relay address");
  }
  const route = host
    ? `host/${encodeURIComponent(host.host_id)}/${encodeURIComponent(host.project_id)}`
    : "hub";
  return {
    address: `${normalizeUrl(root.toString())}${API_RELAY_PATH}/${route}`,
    extraHeaders: {
      [API_RELAY_PROJECT_HEADER]: auth.project_id,
      [API_RELAY_SECRET_HEADER]: auth.project_secret,
      ...(!host ? { [API_RELAY_HUB_HEADER]: hub } : {}),
    },
  };
}

// Keep the canonical URL for profiles, cookies and approval links. Only the
// transport address changes; the project secret admits the relay connection,
// not the upstream API request.
export async function fetchWithProjectApiRelay(
  input: string | URL,
  init?: RequestInit,
  hostTarget?: { apiBaseUrl: string; host_id: string; project_id: string },
): Promise<Response> {
  const url = new URL(input);
  if (process.env.COCALC_API_RELAY !== "1") return await fetch(input, init);
  const apiOffset = url.pathname.indexOf("/api/v2/");
  if (!hostTarget && apiOffset < 0) return await fetch(input, init);
  const relay = projectApiRelayTransport({
    apiBaseUrl:
      hostTarget?.apiBaseUrl ??
      `${url.origin}${url.pathname.slice(0, apiOffset)}`,
    host: hostTarget,
  });
  if (!relay) return await fetch(input, init);
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(relay.extraHeaders))
    headers.set(name, value);
  const response = await fetch(
    `${relay.address}${hostTarget ? url.pathname : url.pathname.slice(apiOffset)}${url.search}`,
    { ...init, headers, redirect: "manual" },
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw Error("project API relay refused an HTTP redirect");
  }
  return response;
}
