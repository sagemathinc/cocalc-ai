import httpProxy from "http-proxy-3";
import getLogger from "../logger";
import { parseReq } from "./parse";
import getPool from "@cocalc/database/pool";
import LRU from "lru-cache";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";
import { issueProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import { getProjectHostAuthTokenPrivateKey } from "@cocalc/backend/data";
import { isValidUUID } from "@cocalc/util/misc";
import {
  projectHostAgentFor,
  safeProjectHostUrl,
  safeTunnelPort,
} from "@cocalc/backend/project-host-target";

const logger = getLogger("proxy:project-host");
const PROJECT_HOST_PROXY_ACCOUNT_ID_KEY = Symbol.for(
  "@cocalc/hub/proxy/project-host-account-id",
);

export type HostRow = {
  host_id?: string;
  internal_url?: string;
  public_url?: string;
  metadata?: any;
};

export function setProjectHostProxyAccountId(
  req: Record<string | symbol, any>,
  account_id: string | undefined,
): void {
  if (isValidUUID(account_id)) {
    req[PROJECT_HOST_PROXY_ACCOUNT_ID_KEY] = account_id;
  } else {
    delete req[PROJECT_HOST_PROXY_ACCOUNT_ID_KEY];
  }
}

function getProjectHostProxyAccountId(
  req: Record<string | symbol, any>,
): string | undefined {
  const value = `${req?.[PROJECT_HOST_PROXY_ACCOUNT_ID_KEY] ?? ""}`.trim();
  return isValidUUID(value) ? value : undefined;
}

const cache = new LRU<string, HostRow>({ max: 10000, ttl: 60_000 });
const hostCache = new LRU<string, HostRow>({ max: 10000, ttl: 60_000 });

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

function isLocalProxyHost(host: HostRow | undefined): boolean {
  const metadata = host?.metadata ?? {};
  const machine = metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  return (
    (machine?.cloud === "self-host" && effectiveSelfHostMode === "local") ||
    metadata?.local === true ||
    metadata?.provider === "star" ||
    metadata?.cloud_provider === "star"
  );
}

export async function getProjectHostRedirectUrl({
  project_id,
  path,
  account_id,
}: {
  project_id: string;
  path: string;
  account_id: string;
}): Promise<string | undefined> {
  const host = await getHost(project_id);
  const host_id = `${host?.host_id ?? ""}`.trim();
  const base = `${host?.public_url ?? ""}`.trim();
  if (!host_id || !base || !account_id || isLocalProxyHost(host)) {
    return;
  }
  // Never send a browser, with a token, to a refused address; fall back to
  // the proxy instead.
  if (safeProjectHostUrl(base) == null) {
    return;
  }
  const issued = issueProjectHostAuthToken({
    host_id,
    actor: "account",
    account_id,
    ttl_seconds: 5 * 60,
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const target = new URL(`${normalizedBase}${normalizedPath}`);
  target.searchParams.set(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM, issued.token);
  return target.toString();
}

// Where the proxy sends a request for a host row, and whether loopback may be
// connected to. Every value that picks it may have come from a host report, so
// each is checked and the request FAILS CLOSED (an error, no value logged)
// instead of going somewhere unexpected: a tunnel port must be an integer port,
// and a stored host URL must not name a loopback, link-local or metadata
// address. Only the bay's own tunnel and a local-proxy host's internal_url may
// be on this machine; even they never reach link-local or metadata addresses.
// The connection itself goes through projectHostAgentFor, which checks the
// resolved address as well (see @cocalc/backend/project-host-target).
export interface ProxyTarget {
  target: string;
  allowLoopback: boolean;
}

export function proxyTargetForHost(host: HostRow, what: string): ProxyTarget {
  const rawTunnelPort = host.metadata?.self_host?.http_tunnel_port;
  if (rawTunnelPort) {
    const port = safeTunnelPort(rawTunnelPort);
    if (port == null) {
      throw new Error(`invalid tunnel port for ${what}`);
    }
    return { target: `http://127.0.0.1:${port}`, allowLoopback: true };
  }
  if (isLocalProxyHost(host)) {
    if (!host.internal_url) {
      throw new Error(`local tunnel port missing for ${what}`);
    }
    if (
      safeProjectHostUrl(host.internal_url, { allowLoopback: true }) == null
    ) {
      throw new Error(`host url for ${what} is not an allowed target`);
    }
    return {
      target: host.internal_url.replace(/\/+$/, ""),
      allowLoopback: true,
    };
  }
  const base = host.internal_url || host.public_url;
  if (!base) {
    throw Error(`no host recorded for ${what}`);
  }
  if (safeProjectHostUrl(base) == null) {
    throw new Error(`host url for ${what} is not an allowed target`);
  }
  // Let http-proxy append the incoming path; only provide the base.
  return { target: base.replace(/\/+$/, ""), allowLoopback: false };
}

function proxyOptions({ target, allowLoopback }: ProxyTarget) {
  return {
    target,
    prependPath: false,
    agent: projectHostAgentFor(target, { allowLoopback }),
  };
}

// An upstream connection that fails, including one the agent refused, ends
// the client's request (502) or closes its upgrading socket, instead of
// leaving it open.
export function endProxyError(err, req, res?) {
  logger.debug("proxy error", { err: `${err}`, url: req?.url });
  if (res == null) return;
  if (typeof res.writeHead === "function") {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Host not available");
    } else {
      res.end();
    }
  } else if (typeof res.destroy === "function") {
    res.destroy();
  }
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

  proxy.on("error", endProxyError);

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

  function rewriteProjectHostSessionPath(req, routeId: string) {
    const raw = req.url ?? "/";
    const u = new URL(raw, "http://dummy");
    const prefix = `/${routeId}`;
    if (!u.pathname.startsWith(prefix)) {
      return;
    }
    let rest = u.pathname.slice(prefix.length);
    if (!rest) {
      rest = "/";
    } else if (!rest.startsWith("/")) {
      rest = `/${rest}`;
    }
    req.url = `${rest}${u.search}`;
  }

  async function targetForConatHost(host_id: string): Promise<ProxyTarget> {
    const host = await getHostById(host_id);
    if (!host) {
      throw Error(`host ${host_id} not found`);
    }
    return proxyTargetForHost(host, `host ${host_id}`);
  }

  async function targetForProject(project_id: string): Promise<ProxyTarget> {
    const host = await getHost(project_id);
    if (!host) {
      throw Error(`project ${project_id} not found`);
    }
    return proxyTargetForHost(host, `project ${project_id}`);
  }

  function setProjectHostAuthorizationHeader({
    req,
    host_id,
  }: {
    req: Record<string, any>;
    host_id?: string;
  }): void {
    if (!isValidUUID(host_id)) {
      return;
    }
    const cleanHostId = host_id as string;
    const account_id = getProjectHostProxyAccountId(req);
    if (!account_id) {
      return;
    }
    const issued = issueProjectHostAuthToken({
      host_id: cleanHostId,
      actor: "account",
      account_id,
      ttl_seconds: 5 * 60,
      private_key: getProjectHostAuthTokenPrivateKey(),
    });
    req.headers.authorization = `Bearer ${issued.token}`;
  }

  async function targetForConatRoute(routeId: string): Promise<ProxyTarget> {
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

  async function getHostForParsedRoute(
    parsed: ReturnType<typeof parseReq>,
  ): Promise<HostRow | undefined> {
    if (parsed.type !== "conat" && parsed.type !== "project-host-session") {
      return await getHost(parsed.project_id);
    }
    return (
      (await getHostById(parsed.project_id).catch(() => undefined)) ??
      (await getHost(parsed.project_id))
    );
  }

  // Every proxied request and upgrade gets its target here, so each one goes
  // through proxyTargetForHost.
  async function selectTarget(
    parsed: ReturnType<typeof parseReq>,
    host: HostRow | undefined,
  ): Promise<ProxyTarget> {
    if (parsed.type === "conat" || parsed.type === "project-host-session") {
      return await targetForConatRoute(parsed.project_id);
    }
    if (host) {
      return proxyTargetForHost(host, `project ${parsed.project_id}`);
    }
    return await targetForProject(parsed.project_id);
  }

  const handleRequest = async (req, res) => {
    try {
      const parsed = parseReq(req.url ?? "/");
      if (parsed.type === "conat") {
        rewriteConatPath(req, parsed.project_id);
      } else if (parsed.type === "project-host-session") {
        rewriteProjectHostSessionPath(req, parsed.project_id);
      }
      const host = await getHostForParsedRoute(parsed);
      setProjectHostAuthorizationHeader({ req, host_id: host?.host_id });
      const target = await selectTarget(parsed, host);
      proxy.web(req, res, proxyOptions(target));
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
      } else if (parsed.type === "project-host-session") {
        rewriteProjectHostSessionPath(req, parsed.project_id);
      }
      const host = await getHostForParsedRoute(parsed);
      setProjectHostAuthorizationHeader({ req, host_id: host?.host_id });
      const target = await selectTarget(parsed, host);
      // A client gone during the lookups must not open an upstream that
      // nothing will close (proxy.ws only cleans up on a later close).
      if (socket.destroyed) return;
      proxy.ws(req, socket, head, proxyOptions(target));
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
