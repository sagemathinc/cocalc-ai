import getLogger from "@cocalc/backend/logger";
import getPool, {
  getPglitePgClient,
  isPgliteEnabled,
} from "@cocalc/database/pool";
import LRU from "lru-cache";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:conat:route-project");

const CHANNEL = "project_host_update";

export interface ProjectHostRouteTarget {
  address: string;
  host_id: string;
  host_session_id?: string;
}

const cache = new LRU<string, ProjectHostRouteTarget>({
  max: 10_000,
  ttl: 5 * 60_000, // 5 minutes
});

const inflight: Partial<Record<string, Promise<void>>> = {};
let listenerStarted: boolean = false;
function onPremTunnelAddress(metadata: any): string | undefined {
  const port = metadata?.self_host?.http_tunnel_port;
  if (!port) return undefined;
  return `http://127.0.0.1:${port}`;
}

function extractProjectId(subject: string): string | undefined {
  // there's a similar function in the frontend in src/packages/frontend/conat/client.ts
  // but it only handles routes the frontend should know about.
  if (subject.startsWith("project.")) {
    const project_id = subject.split(".")[1];
    if (isValidUUID(project_id)) return project_id;
    return undefined;
  }
  if (subject.startsWith("file-server.")) {
    const project_id = subject.split(".")[1];
    if (isValidUUID(project_id)) return project_id;
    return undefined;
  }
  const v = subject.split(".");
  if (v[1]?.startsWith("project-")) {
    const project_id = v[1].slice("project-".length);
    if (isValidUUID(project_id)) return project_id;
  }
  return undefined;
}

function cacheRouteTarget(
  project_id: string,
  route?: {
    address?: string | null;
    host_id?: string | null;
    host_session_id?: string | null;
  },
) {
  const address = route?.address;
  const host_id = route?.host_id;
  if (!address || !host_id) {
    cache.delete(project_id);
    return;
  }
  cache.set(project_id, {
    address,
    host_id,
    host_session_id: route?.host_session_id ?? undefined,
  });
}

async function fetchHostAddress(
  project_id: string,
): Promise<ProjectHostRouteTarget | undefined> {
  if (inflight[project_id]) {
    await inflight[project_id];
    return cache.get(project_id);
  }
  inflight[project_id] = (async () => {
    try {
      const defaultBayId = getConfiguredBayId();
      const { rows } = await getPool().query<{
        host_id: string | null;
        resolved_host_id: string | null;
        project_owning_bay_id: string | null;
        host_bay_id: string | null;
        public_url?: string | null;
        internal_url?: string | null;
        metadata?: any;
      }>(
        `
          SELECT
            projects.host_id,
            project_hosts.id AS resolved_host_id,
            COALESCE(projects.owning_bay_id, $2) AS project_owning_bay_id,
            COALESCE(project_hosts.bay_id, $2) AS host_bay_id,
            project_hosts.public_url,
            project_hosts.internal_url,
            project_hosts.metadata
          FROM projects
          LEFT JOIN project_hosts
            ON project_hosts.id = projects.host_id
           AND project_hosts.deleted IS NULL
          WHERE project_id=$1
        `,
        [project_id, defaultBayId],
      );
      const row = rows[0];
      if (row?.host_id) {
        if (!row.resolved_host_id) {
          cache.delete(project_id);
          return;
        }
        if (row.project_owning_bay_id !== row.host_bay_id) {
          cache.delete(project_id);
          log.warn("refusing project route with mismatched bay ownership", {
            project_id,
            host_id: row.host_id,
            project_bay_id: row.project_owning_bay_id,
            host_bay_id: row.host_bay_id,
          });
          return;
        }
        const directTunnel = onPremTunnelAddress(row?.metadata);
        const host_session_id =
          `${row?.metadata?.host_session_id ?? ""}`.trim() || undefined;
        if (directTunnel) {
          cacheRouteTarget(project_id, {
            address: directTunnel,
            host_id: row.host_id,
            host_session_id,
          });
          return;
        }
        const machine = row?.metadata?.machine ?? {};
        const selfHostMode = machine?.metadata?.self_host_mode;
        const effectiveSelfHostMode =
          machine?.cloud === "self-host" && !selfHostMode
            ? "local"
            : selfHostMode;
        const isLocalSelfHost =
          machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
        if (isLocalSelfHost) {
          const addr = onPremTunnelAddress(row?.metadata);
          if (!addr) {
            log.debug("local tunnel port missing for project", {
              project_id,
              host_id: row.host_id,
            });
            return;
          }
          cacheRouteTarget(project_id, {
            address: addr,
            host_id: row.host_id,
            host_session_id,
          });
          return;
        }
        cacheRouteTarget(project_id, {
          address: row?.internal_url ?? row?.public_url,
          host_id: row.host_id,
          host_session_id,
        });
        return;
      }
    } catch (err) {
      log.debug("fetchHostAddress failed", { project_id, err });
    } finally {
      delete inflight[project_id];
    }
  })();
  await inflight[project_id];
  return cache.get(project_id);
}

export function routeProjectSubject(
  subject: string,
):
  | { address?: string; host_id?: string; host_session_id?: string }
  | undefined {
  const project_id = extractProjectId(subject);
  if (!project_id) {
    // log.debug("routeProjectSubject: not a project subject", subject);
    return;
  }

  const cached = cache.get(project_id);
  if (cached) {
    // log.debug("routeProjectSubject: cached", { subject, cached });
    return cached;
  }

  // Fire and forget fill; fall back to default connection until cached.
  void fetchHostAddress(project_id);
  return;
}

async function handleNotification(msg: {
  channel: string;
  payload?: string | null;
}) {
  if (msg.channel !== CHANNEL || !msg.payload) return;
  try {
    const payload = JSON.parse(msg.payload);
    const project_id = `${payload?.project_id ?? ""}`.trim();
    const host_id = `${payload?.host_id ?? ""}`.trim();
    if (project_id && isValidUUID(project_id)) {
      cache.delete(project_id);
      void fetchHostAddress(project_id);
    }
    if (host_id && isValidUUID(host_id)) {
      for (const [cachedProjectId, target] of cache.entries()) {
        if (target.host_id === host_id) {
          cache.delete(cachedProjectId);
        }
      }
    }
  } catch (err) {
    log.debug("handleNotification parse failed", { err, payload: msg.payload });
  }
}

export async function listenForUpdates() {
  if (listenerStarted) return;
  listenerStarted = true;
  const pool = getPool();

  async function connect() {
    let client: any | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      client?.removeAllListeners?.();
      // release is safe to call once; ignore errors if connection is already gone
      try {
        client?.release();
      } catch (err) {
        log.debug("project_host_update listener release failed", err);
      }
    };
    try {
      if (isPgliteEnabled()) {
        client = getPglitePgClient();
      } else {
        client = await pool.connect();
      }
      client.on("notification", (msg) => {
        void handleNotification(msg as any);
      });
      client.on("error", (err) => {
        log.warn("project_host_update listener error", err);
        cleanup();
        setTimeout(connect, 1000).unref?.();
      });
      client.on("end", () => {
        cleanup();
        setTimeout(connect, 1000).unref?.();
      });
      await client.query(`LISTEN ${CHANNEL}`);
      log.debug("listening for project host updates");
    } catch (err) {
      cleanup();
      log.warn("failed to start project_host_update listener", err);
      setTimeout(connect, 1000).unref?.();
    }
  }

  void connect();
}

export async function notifyProjectHostUpdate(opts: {
  project_id?: string;
  host_id?: string;
}) {
  try {
    // Parameterized NOTIFY is awkward; use pg_notify to avoid string interpolation.
    await getPool().query(`SELECT pg_notify($1, $2)`, [
      CHANNEL,
      JSON.stringify(opts),
    ]);
  } catch (err) {
    log.debug("notifyProjectHostUpdate failed", { opts, err });
  }
}

export async function materializeProjectHostTarget(
  project_id: string,
  opts?: { fresh?: boolean },
): Promise<ProjectHostRouteTarget | undefined> {
  if (opts?.fresh !== true) {
    const cached = cache.get(project_id);
    if (cached) return cached;
  }
  return await fetchHostAddress(project_id);
}

export async function materializeProjectHost(
  project_id: string,
  opts?: { fresh?: boolean },
): Promise<string | undefined> {
  return (await materializeProjectHostTarget(project_id, opts))?.address;
}
