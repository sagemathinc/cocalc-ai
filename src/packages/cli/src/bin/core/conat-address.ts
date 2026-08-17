import { normalizeUrl } from "../../core/utils";

function isLoopbackHostName(hostname: string): boolean {
  const host = `${hostname ?? ""}`.trim().toLowerCase();
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function isLoopbackApiBaseUrl(apiBaseUrl: string): boolean {
  try {
    return isLoopbackHostName(new URL(apiBaseUrl).hostname);
  } catch {
    return false;
  }
}

export function resolveConatAddress({
  apiBaseUrl,
  conatServer,
  devEnvMode,
  preferApiTransport = false,
  preferHubForAgentMode = false,
}: {
  apiBaseUrl: string;
  conatServer?: string;
  devEnvMode?: string;
  preferApiTransport?: boolean;
  preferHubForAgentMode?: boolean;
}): string {
  const requestedApi = normalizeUrl(apiBaseUrl);
  const fromEnv = `${conatServer ?? ""}`.trim();
  if (!fromEnv) {
    return requestedApi;
  }
  if (preferApiTransport || preferHubForAgentMode) {
    return requestedApi;
  }

  const normalized = normalizeUrl(fromEnv);
  if (isLoopbackApiBaseUrl(normalized) && !isLoopbackApiBaseUrl(requestedApi)) {
    return requestedApi;
  }
  if (
    devEnvMode === "hub" &&
    isLoopbackApiBaseUrl(requestedApi) &&
    normalized !== requestedApi
  ) {
    return requestedApi;
  }
  return normalized;
}
