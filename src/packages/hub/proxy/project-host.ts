import httpProxy from "http-proxy-3";
import getLogger from "../logger";
import { parseReq } from "./parse";
import getPool from "@cocalc/database/pool";
import LRU from "lru-cache";
import { isPublicAppSubdomainRequest } from "./public-app-subdomain";
import { issueProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import { getProjectHostAuthTokenPrivateKey } from "@cocalc/backend/data";

const logger = getLogger("proxy:project-host");
const PUBLIC_APP_HOST_HEADER = "x-cocalc-public-app-host";
const HUB_PUBLIC_AUTH_TOKEN_LEEWAY_MS = 60_000;

type HostRow = {
  host_id?: string;
  internal_url?: string;
  public_url?: string;
  metadata?: any;
};

const cache = new LRU<string, HostRow>({ max: 10000, ttl: 60_000 });
const hostCache = new LRU<string, HostRow>({ max: 10000, ttl: 60_000 });
const publicAuthTokenCache = new LRU<
  string,
  { token: string; expiresAt: number }
>({ max: 10_000, ttl: 10 * 60_000 });

async function getHost(project_id: string): Promise<HostRow | undefined> {
  const cached = cache.get(project_id);
  if (cached) return cached;
  const { rows } = await getPool().query(
    `
      SELECT project_hosts.id           AS host_id,
             project_hosts.internal_url AS internal_url,
             project_hosts.public_url   AS public_url,
             project_hosts.metadata     AS metadata
      FROM projects
      LEFT JOIN project_hosts ON project_hosts.id = projects.host_id
      WHERE projects.project_id=$1
    `,
    [project_id],
  );
  const row = rows[0];
  if (row) {
    cache.set(project_id, row);
  }
  return row;
}

async function getHostById(host_id: string): Promise<HostRow | undefined> {
  const cached = hostCache.get(host_id);
  if (cached) return cached;
  const { rows } = await getPool().query(
    `
      SELECT id           AS host_id,
             internal_url AS internal_url,
             public_url   AS public_url,
             metadata     AS metadata
      FROM project_hosts
      WHERE id=$1 AND deleted IS NULL
    `,
    [host_id],
  );
  const row = rows[0];
  if (row) {
    hostCache.set(host_id, row);
  }
  return row;
}

function getPublicAppHubAuthToken(host_id: string): string {
  const cached = publicAuthTokenCache.get(host_id);
  if (cached && Date.now() < cached.expiresAt - HUB_PUBLIC_AUTH_TOKEN_LEEWAY_MS) {
    return cached.token;
  }
  const issued = issueProjectHostAuthToken({
    host_id,
    actor: "hub",
    hub_id: "hub",
    ttl_seconds: 5 * 60,
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  const value = {
    token: issued.token,
    expiresAt: issued.expires_at,
  };
  publicAuthTokenCache.set(host_id, value);
  return value.token;
}

export async function createProjectHostProxyHandlers() {
  const proxy = httpProxy.createProxyServer({
    xfwd: true,
    ws: true,
    // Required for TLS targets (e.g. host-*.dev.cocalc.ai via Cloudflare):
    // without this, SNI/Host stays on the incoming hub host and upstream TLS
    // can fail with EPROTO handshake alerts.
    changeOrigin: true,
  });

  proxy.on("error", (err, req) => {
    logger.debug("proxy error", { err: `${err}`, url: req?.url });
  });

  function rewriteConatPath(req, host_id: string) {
    const raw = req.url ?? "/";
    const u = new URL(raw, "http://dummy");
    const prefix = `/${host_id}/conat`;
    if (!u.pathname.startsWith(prefix)) {
      return;
    }
    let rest = u.pathname.slice(prefix.length);
    if (!rest) {
      rest = "/";
    } else if (!rest.startsWith("/")) {
      rest = `/${rest}`;
    }
    req.url = `/conat${rest}${u.search}`;
  }

  async function targetForConatHost(host_id: string): Promise<string> {
    const host = await getHostById(host_id);
    if (!host) {
      throw Error(`host ${host_id} not found`);
    }
    const directTunnelPort = host.metadata?.self_host?.http_tunnel_port;
    if (directTunnelPort) {
      return `http://127.0.0.1:${directTunnelPort}`;
    }
    const machine = host.metadata?.machine ?? {};
    const selfHostMode = machine?.metadata?.self_host_mode;
    const effectiveSelfHostMode =
      machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
    const isLocalSelfHost =
      machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
    if (isLocalSelfHost) {
      const tunnelPort = host.metadata?.self_host?.http_tunnel_port;
      if (!tunnelPort) {
        throw new Error(`local tunnel port missing for host ${host_id}`);
      }
      return `http://127.0.0.1:${tunnelPort}`;
    }
    const base = host.internal_url || host.public_url;
    if (!base) {
      throw Error(`no host recorded for host ${host_id}`);
    }
    // Let http-proxy append the incoming path; only provide the base.
    return base.replace(/\/+$/, "");
  }

  async function targetForProject(project_id: string): Promise<string> {
    const host = await getHost(project_id);
    if (!host) {
      throw Error(`project ${project_id} not found`);
    }
    const directTunnelPort = host.metadata?.self_host?.http_tunnel_port;
    if (directTunnelPort) {
      return `http://127.0.0.1:${directTunnelPort}`;
    }
    const machine = host.metadata?.machine ?? {};
    const selfHostMode = machine?.metadata?.self_host_mode;
    const effectiveSelfHostMode =
      machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
    const isLocalSelfHost =
      machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
    if (isLocalSelfHost) {
      const tunnelPort = host.metadata?.self_host?.http_tunnel_port;
      if (!tunnelPort) {
        throw new Error(`local tunnel port missing for project ${project_id}`);
      }
      return `http://127.0.0.1:${tunnelPort}`;
    }
    const base = host.internal_url || host.public_url;
    if (!base) {
      throw Error(`no host recorded for project ${project_id}`);
    }
    // Let http-proxy append the incoming path; only provide the base.
    return base.replace(/\/+$/, "");
  }

  async function targetForConatRoute(routeId: string): Promise<string> {
    try {
      return await targetForConatHost(routeId);
    } catch (err) {
      const message = `${(err as any)?.message ?? err ?? ""}`;
      if (!message.includes("not found")) {
        throw err;
      }
    }
    return await targetForProject(routeId);
  }

  const handleRequest = async (req, res) => {
    try {
      const parsed = parseReq(req.url ?? "/");
      if (parsed.type === "conat") {
        rewriteConatPath(req, parsed.project_id);
      }
      const host =
        parsed.type === "conat"
          ? await getHostById(parsed.project_id).catch(() => undefined)
          : await getHost(parsed.project_id);
      if (isPublicAppSubdomainRequest(req) && req.headers.host) {
        req.headers[PUBLIC_APP_HOST_HEADER] = req.headers.host;
        if (host?.host_id) {
          req.headers.authorization = `Bearer ${getPublicAppHubAuthToken(host.host_id)}`;
        }
      }
      const target =
        parsed.type === "conat"
          ? await targetForConatRoute(parsed.project_id)
          : (host?.internal_url || host?.public_url || (await targetForProject(parsed.project_id))).replace(/\/+$/, "");
      proxy.web(req, res, { target, prependPath: false });
    } catch (err) {
      logger.debug("proxy request error", { err: `${err}`, url: req?.url });
      if (!res.headersSent) {
        res.statusCode = 404;
        res.end("Host not available");
      } else {
        res.end();
      }
    }
  };

  const handleUpgrade = async (req, socket, head) => {
    try {
      const parsed = parseReq(req.url ?? "/");
      if (parsed.type === "conat") {
        rewriteConatPath(req, parsed.project_id);
      }
      const host =
        parsed.type === "conat"
          ? await getHostById(parsed.project_id).catch(() => undefined)
          : await getHost(parsed.project_id);
      if (isPublicAppSubdomainRequest(req) && req.headers.host) {
        req.headers[PUBLIC_APP_HOST_HEADER] = req.headers.host;
        if (host?.host_id) {
          req.headers.authorization = `Bearer ${getPublicAppHubAuthToken(host.host_id)}`;
        }
      }
      const target =
        parsed.type === "conat"
          ? await targetForConatRoute(parsed.project_id)
          : (host?.internal_url || host?.public_url || (await targetForProject(parsed.project_id))).replace(/\/+$/, "");
      proxy.ws(req, socket, head, { target, prependPath: false });
    } catch (err) {
      logger.debug("proxy upgrade error", { err: `${err}`, url: req?.url });
      try {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      } catch {
        // ignore
      }
      socket.destroy();
    }
  };

  return { handleRequest, handleUpgrade };
}
