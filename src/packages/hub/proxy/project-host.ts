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

async function getHost(project_id: string): Promise<HostRow> {
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
  const row = rows[0] ?? {};
  cache.set(project_id, row);
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

  function rewriteConatPath(req, project_id: string) {
    const raw = req.url ?? "/";
    const u = new URL(raw, "http://dummy");
    const prefix = `/${project_id}/conat`;
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

  async function targetForProject(project_id: string): Promise<string> {
    const host = await getHost(project_id);
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

  const handleRequest = async (req, res) => {
    const parsed = parseReq(req.url ?? "/");
    if (parsed.type === "conat") {
      rewriteConatPath(req, parsed.project_id);
    }
    const target = await targetForProject(parsed.project_id);
    proxy.web(req, res, { target, prependPath: false });
  };

  const handleUpgrade = async (req, socket, head) => {
    const parsed = parseReq(req.url ?? "/");
    if (parsed.type === "conat") {
      rewriteConatPath(req, parsed.project_id);
    }
    const target = await targetForProject(parsed.project_id);
    proxy.ws(req, socket, head, { target, prependPath: false });
  };

  return { handleRequest, handleUpgrade };
}
