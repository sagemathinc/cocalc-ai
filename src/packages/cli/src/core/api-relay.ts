import {
  API_RELAY_PATH,
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
  API_RELAY_HUB_HEADER,
  normalizeApiRelayHubUrl,
} from "@cocalc/conat/project-host/api-relay";
import { resolveProjectScopedAuth } from "./auth-cookies";
import { normalizeUrl } from "./utils";

export function apiTransportMode(
  env = process.env,
): "auto" | "direct" | "relay" {
  const mode = env.COCALC_CLI_TRANSPORT ?? "auto";
  if (mode === "auto" || mode === "direct" || mode === "relay") return mode;
  throw Error("CLI transport must be auto, direct, or relay");
}

// Transport policy is not an authorization boundary: host egress controls and
// upstream credentials apply to direct connections too. Never retry an actual
// operation on another transport after an ambiguous response or timeout.
const routeProbes = new Map<
  string,
  { expires: number; result: Promise<boolean> }
>();

export async function selectProjectApiRelayTransport(
  options: Parameters<typeof projectApiRelayTransport>[0] & {
    // Set only after resolving destination-scoped auth, not merely --api.
    credentialSite?: string;
  },
): Promise<ReturnType<typeof projectApiRelayTransport>> {
  const env = options.env ?? process.env;
  const mode = apiTransportMode(env);
  const hub = normalizeApiRelayHubUrl(options.apiBaseUrl);
  const assertDirectScope = () => {
    const scope =
      options.credentialSite ??
      env.COCALC_API_RELAY_HUB_URL ??
      env.COCALC_API_URL;
    if (!scope || normalizeApiRelayHubUrl(scope) !== hub) {
      throw Error(
        "direct transport requires destination-scoped credentials; use a matching profile or disable environment auth defaults with explicit credentials",
      );
    }
  };
  if (mode === "direct") {
    assertDirectScope();
    return;
  }
  const relay = projectApiRelayTransport({ ...options, host: undefined });
  if (!relay) {
    if (mode === "relay") throw Error("project API relay is not configured");
    return;
  }
  const localSite = env.COCALC_API_RELAY_HUB_URL;
  if (
    mode === "relay" ||
    (localSite && normalizeApiRelayHubUrl(localSite) === hub)
  ) {
    return projectApiRelayTransport(options);
  }
  // Unknown endpoints may be other bays in this cluster, so do not infer
  // cluster membership from DNS suffixes. Probe only a read-only HEAD, without
  // upstream cookies/tokens or caller payload, using the existing router API.
  const key = JSON.stringify([relay.address, relay.extraHeaders]);
  let probe = routeProbes.get(key);
  if (!probe || probe.expires <= Date.now()) {
    if (routeProbes.size >= 128) routeProbes.clear();
    probe = {
      expires: Date.now() + 30_000,
      result: (async () => {
        try {
          const response = await fetch(`${relay.address}/api/v2/auth/status`, {
            method: "HEAD",
            headers: relay.extraHeaders,
            redirect: "manual",
            signal: AbortSignal.timeout(3_000),
          });
          await response.body?.cancel();
          // An upstream 404/405 is normal for a HEAD-only reachability probe.
          // Relay denial, overload or unavailability selects direct transport
          // before any authenticated operation is sent.
          return (
            response.status < 500 &&
            ![301, 302, 303, 307, 308, 403, 429].includes(response.status)
          );
        } catch {
          return false;
        }
      })(),
    };
    routeProbes.set(key, probe);
  }
  if (await probe.result) return projectApiRelayTransport(options);
  assertDirectScope();
  return;
}

export function projectApiRelayTransport({
  apiBaseUrl,
  host,
  env = process.env,
}: {
  apiBaseUrl: string;
  host?: { host_id: string; project_id: string };
  env?: NodeJS.ProcessEnv;
}): { address: string; extraHeaders: Record<string, string> } | undefined {
  if (apiTransportMode(env) === "direct" || env.COCALC_API_RELAY !== "1")
    return;
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
  authScope?: { credentialSite?: string },
): Promise<Response> {
  const url = new URL(input);
  const apiOffset = url.pathname.indexOf("/api/v2/");
  if (!hostTarget && apiOffset < 0) return await fetch(input, init);
  const apiBaseUrl =
    hostTarget?.apiBaseUrl ??
    `${url.origin}${url.pathname.slice(0, apiOffset)}`;
  const requestHeaders = new Headers(init?.headers);
  const relay = await selectProjectApiRelayTransport({
    apiBaseUrl,
    // Login challenges without inherited auth can target a new site. Authenticated
    // HTTP callers must carry the scope used when constructing their headers.
    credentialSite:
      authScope?.credentialSite ??
      (!requestHeaders.has("cookie") && !requestHeaders.has("authorization")
        ? apiBaseUrl
        : undefined),
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
