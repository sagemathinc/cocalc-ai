import { PROJECT_HOST_API_KEY_HTTP_HEADER } from "@cocalc/conat/auth/project-host-http";
import { getProjectHostAccessWithApiKey } from "./api-key-hub";

interface TargetOptions {
  apiBaseUrl: string;
  apiKey: string;
  project_id: string;
  port: number;
  hostIdentifier?: string;
}

async function resolveTarget(options: TargetOptions) {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw Error("port must be an integer between 1 and 65535");
  }
  if (options.hostIdentifier)
    throw Error("scoped proxy access does not allow a host override");
  const access = await getProjectHostAccessWithApiKey({
    apiBaseUrl: options.apiBaseUrl,
    apiKey: options.apiKey,
    project_id: options.project_id,
    http_proxy_port: options.port,
  });
  const base = new URL(
    access.connect_url || (access.local_proxy ? options.apiBaseUrl : ""),
  );
  if (base.protocol === "wss:") base.protocol = "https:";
  if (base.protocol === "ws:") base.protocol = "http:";
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password
  ) {
    throw Error("invalid scoped proxy host URL");
  }
  const url = new URL(
    `/${options.project_id}/proxy/${options.port}/`,
    base,
  ).toString();
  return {
    access,
    details: {
      project_id: options.project_id,
      host_id: access.host_id,
      local_proxy: access.local_proxy,
      url,
    },
  };
}

export async function resolveScopedProxyUrl(options: TargetOptions) {
  return (await resolveTarget(options)).details;
}

export async function requestScopedProjectProxy(
  options: TargetOptions & {
    path?: string;
    timeoutMs: number;
    expect?: "ok" | "denied" | "any";
  },
) {
  const { access, details } = await resolveTarget(options);
  const url = new URL((options.path ?? "/").replace(/^\/+/, ""), details.url);
  const root = new URL(details.url);
  if (
    url.origin !== root.origin ||
    !url.pathname.startsWith(root.pathname) ||
    url.username ||
    url.password
  ) {
    throw Error("proxy path must remain within the selected project and port");
  }
  const response = await fetch(url, {
    headers: { [PROJECT_HOST_API_KEY_HTTP_HEADER]: access.token },
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  let body = "";
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    try {
      while (body.length < 1024) {
        const { value, done } = await reader.read();
        if (done) {
          body += decoder.decode();
          break;
        }
        body += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
  }
  if (
    options.expect === "ok" &&
    (response.status < 200 || response.status >= 400)
  ) {
    throw Error(`expected success response, got status ${response.status}`);
  }
  if (options.expect === "denied" && response.status < 300) {
    throw Error(
      `expected denied (non-2xx) response, got status ${response.status}`,
    );
  }
  return {
    ...details,
    url: url.toString(),
    status: response.status,
    body_preview: body.slice(0, 1024),
  };
}
