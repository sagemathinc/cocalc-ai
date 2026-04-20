import getLogger from "@cocalc/backend/logger";
import getPool, {
  getPglitePgClient,
  isPgliteEnabled,
} from "@cocalc/database/pool";
import LRU from "lru-cache";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveProjectBayAcrossCluster } from "@cocalc/server/inter-bay/directory";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:conat:route-project");

const CHANNEL = "project_host_update";

export interface ProjectHostRouteTarget {
  address: string;
  host_id: string;
  host_session_id?: string;
}

const projectCache = new LRU<string, ProjectHostRouteTarget>({
  max: 10_000,
  ttl: 5 * 60_000, // 5 minutes
});

const hostCache = new LRU<string, ProjectHostRouteTarget>({
  max: 10_000,
  ttl: 5 * 60_000, // 5 minutes
});

const inflight: Partial<Record<string, Promise<void>>> = {};
const hostInflight: Partial<Record<string, Promise<void>>> = {};
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

function extractHostId(subject: string): string | undefined {
  if (!subject.startsWith("project-host.")) {
    return undefined;
  }
  const host_id = subject.split(".")[1];
  return isValidUUID(host_id) ? host_id : undefined;
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
    projectCache.delete(project_id);
    return;
  }
  projectCache.set(project_id, {
    address,
    host_id,
    host_session_id: route?.host_session_id ?? undefined,
  });
}

function cacheHostTarget(
  host_id: string,
  route?: {
    address?: string | null;
    host_session_id?: string | null;
  },
) {
  const address = route?.address;
  if (!address) {
    hostCache.delete(host_id);
    return;
  }
  hostCache.set(host_id, {
    address,
    host_id,
    host_session_id: route?.host_session_id ?? undefined,
  });
}

function selectHostAddress(row: {
  internal_url?: string | null;
  public_url?: string | null;
  metadata?: any;
}): { address?: string; host_session_id?: string } {
  const directTunnel = onPremTunnelAddress(row?.metadata);
  const host_session_id =
    `${row?.metadata?.host_session_id ?? ""}`.trim() || undefined;
  if (directTunnel) {
    return {
      address: directTunnel,
      host_session_id,
    };
  }
  const machine = row?.metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  if (isLocalSelfHost) {
    return {
      address: onPremTunnelAddress(row?.metadata),
      host_session_id,
    };
  }
  return {
    address: row?.internal_url ?? row?.public_url ?? undefined,
    host_session_id,
  };
}

async function fetchHostTarget(
  host_id: string,
): Promise<ProjectHostRouteTarget | undefined> {
  if (hostInflight[host_id]) {
    await hostInflight[host_id];
    return hostCache.get(host_id);
  }
  hostInflight[host_id] = (async () => {
    try {
      const defaultBayId = getConfiguredBayId();
      const { rows } = await getPool().query<{
        resolved_host_id: string | null;
        host_bay_id: string | null;
        public_url?: string | null;
        internal_url?: string | null;
        metadata?: any;
      }>(
        `
          SELECT
            project_hosts.id AS resolved_host_id,
            COALESCE(project_hosts.bay_id, $2) AS host_bay_id,
            project_hosts.public_url,
            project_hosts.internal_url,
            project_hosts.metadata
          FROM project_hosts
          WHERE project_hosts.id = $1
            AND project_hosts.deleted IS NULL
        `,
        [host_id, defaultBayId],
      );
      const row = rows[0];
      if (!row?.resolved_host_id) {
        hostCache.delete(host_id);
        return;
      }
      if (row.host_bay_id !== defaultBayId) {
        hostCache.delete(host_id);
        log.warn("refusing host route owned by another bay", {
          host_id,
          host_bay_id: row.host_bay_id,
          current_bay_id: defaultBayId,
        });
        return;
      }
      const selected = selectHostAddress(row);
      cacheHostTarget(host_id, {
        address: selected.address,
        host_session_id: selected.host_session_id,
      });
      return;
    } catch (err) {
      log.debug("fetchHostTarget failed", { host_id, err });
    } finally {
      delete hostInflight[host_id];
    }
  })();
  await hostInflight[host_id];
  return hostCache.get(host_id);
}

async function fetchHostAddress(
  project_id: string,
): Promise<ProjectHostRouteTarget | undefined> {
  if (inflight[project_id]) {
    await inflight[project_id];
    return projectCache.get(project_id);
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
          projectCache.delete(project_id);
          return;
        }
        if (row.project_owning_bay_id !== row.host_bay_id) {
          projectCache.delete(project_id);
          log.warn("refusing project route with mismatched bay ownership", {
            project_id,
            host_id: row.host_id,
            project_bay_id: row.project_owning_bay_id,
            host_bay_id: row.host_bay_id,
          });
          return;
        }
        const selected = selectHostAddress(row);
        if (selected.address) {
          cacheHostTarget(row.host_id, {
            address: selected.address,
            host_session_id: selected.host_session_id,
          });
        }
        if (selected.address && onPremTunnelAddress(row?.metadata)) {
          cacheRouteTarget(project_id, {
            address: selected.address,
            host_id: row.host_id,
            host_session_id: selected.host_session_id,
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
          const addr = selected.address;
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
            host_session_id: selected.host_session_id,
          });
          return;
        }
        cacheRouteTarget(project_id, {
          address: selected.address,
          host_id: row.host_id,
          host_session_id: selected.host_session_id,
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
  return projectCache.get(project_id);
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

  const cached = projectCache.get(project_id);
  if (cached) {
    // log.debug("routeProjectSubject: cached", { subject, cached });
    return cached;
  }

  // Fire and forget fill; fall back to default connection until cached.
  void fetchHostAddress(project_id);
  return;
}

export function routeHostSubject(
  subject: string,
):
  | { address?: string; host_id?: string; host_session_id?: string }
  | undefined {
  const host_id = extractHostId(subject);
  if (!host_id) {
    return;
  }
  const cached = hostCache.get(host_id);
  if (cached) {
    return cached;
  }
  void fetchHostTarget(host_id);
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
      projectCache.delete(project_id);
      void fetchHostAddress(project_id);
    }
    if (host_id && isValidUUID(host_id)) {
      hostCache.delete(host_id);
      void fetchHostTarget(host_id);
      for (const [cachedProjectId, target] of projectCache.entries()) {
        if (target.host_id === host_id) {
          projectCache.delete(cachedProjectId);
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
    const cached = projectCache.get(project_id);
    if (cached) return cached;
  }
  return await fetchHostAddress(project_id);
}

export async function materializeRemoteProjectHostTarget({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectHostRouteTarget | undefined> {
  const local = await materializeProjectHostTarget(project_id, { fresh: true });
  if (local) {
    return local;
  }
  const ownership = await resolveProjectBayAcrossCluster(project_id);
  const currentBayId = getConfiguredBayId();
  if (!ownership || ownership.bay_id === currentBayId) {
    return undefined;
  }
  const bridge = getInterBayBridge();
  const reference = await bridge
    .projectReference(ownership.bay_id, { timeout_ms: 15_000 })
    .get({ account_id, project_id });
  const host_id = `${reference?.host_id ?? ""}`.trim();
  if (!host_id) {
    return undefined;
  }
  const connection = await bridge
    .hostConnection(ownership.bay_id, { timeout_ms: 15_000 })
    .get({ account_id, host_id });
  const address = `${connection?.connect_url ?? ""}`.trim();
  if (!address) {
    return undefined;
  }
  cacheHostTarget(host_id, {
    address,
    host_session_id: connection.host_session_id,
  });
  cacheRouteTarget(project_id, {
    address,
    host_id,
    host_session_id: connection.host_session_id,
  });
  return projectCache.get(project_id);
}

export async function materializeHostRouteTarget(
  host_id: string,
  opts?: { fresh?: boolean },
): Promise<ProjectHostRouteTarget | undefined> {
  if (opts?.fresh !== true) {
    const cached = hostCache.get(host_id);
    if (cached) return cached;
  }
  return await fetchHostTarget(host_id);
}

export async function materializeProjectHost(
  project_id: string,
  opts?: { fresh?: boolean },
): Promise<string | undefined> {
  return (await materializeProjectHostTarget(project_id, opts))?.address;
}
