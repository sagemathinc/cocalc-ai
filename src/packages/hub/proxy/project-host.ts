import httpProxy from "http-proxy-3";
import getLogger from "../logger";
import { parseReq } from "./parse";
import getPool from "@cocalc/database/pool";
import LRU from "lru-cache";

const logger = getLogger("proxy:project-host");

type HostRow = {
  internal_url?: string;
  public_url?: string;
  metadata?: any;
};

const cache = new LRU<string, HostRow>({ max: 10000, ttl: 60_000 });
const hostCache = new LRU<string, HostRow>({ max: 10000, ttl: 60_000 });

async function getHost(project_id: string): Promise<HostRow | undefined> {
  const cached = cache.get(project_id);
  if (cached) return cached;
  const { rows } = await getPool().query(
    `
      SELECT project_hosts.internal_url AS internal_url,
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
      SELECT internal_url AS internal_url,
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

export async function createProjectHostProxyHandlers() {
  const proxy = httpProxy.createProxyServer({
    xfwd: true,
    ws: true,
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
      const target =
        parsed.type === "conat"
          ? await targetForConatRoute(parsed.project_id)
          : await targetForProject(parsed.project_id);
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
      const target =
        parsed.type === "conat"
          ? await targetForConatRoute(parsed.project_id)
          : await targetForProject(parsed.project_id);
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
