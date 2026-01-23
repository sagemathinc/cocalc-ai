import getLogger from "@cocalc/backend/logger";
import getPool, {
  getPglitePgClient,
  isPgliteEnabled,
} from "@cocalc/database/pool";
import LRU from "lru-cache";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:conat:route-project");

const CHANNEL = "project_host_update";

const cache = new LRU<string, string>({
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

function cacheHost(project_id: string, host?: any) {
  let address: string | undefined;
  if (typeof host === "string") {
    address = host;
  } else if (host && typeof host === "object") {
    address = host.internal_url ?? host.public_url;
  }
  if (!address) {
    cache.delete(project_id);
    return;
  }
  cache.set(project_id, address);
}

async function updateProjectHostSnapshot(
  project_id: string,
  host: {
    public_url?: string | null;
    internal_url?: string | null;
    ssh_server?: string | null;
    local_proxy?: boolean | null;
  },
) {
  const params: Array<string | boolean | null | undefined> = [project_id];
  let expr = "coalesce(host, '{}'::jsonb)";
  let idx = 2;
  const fields: Array<[string, string | null | undefined]> = [
    ["public_url", host.public_url],
    ["internal_url", host.internal_url],
    ["ssh_server", host.ssh_server],
  ];
  const boolFields: Array<[string, boolean | null | undefined]> = [
    ["local_proxy", host.local_proxy],
  ];
  for (const [field, value] of fields) {
    if (value === undefined) continue;
    expr = `jsonb_set(${expr}, '{${field}}', to_jsonb($${idx++}::text), true)`;
    params.push(value);
  }
  for (const [field, value] of boolFields) {
    if (value === undefined) continue;
    expr = `jsonb_set(${expr}, '{${field}}', to_jsonb($${idx++}::boolean), true)`;
    params.push(value);
  }
  if (idx === 2) return;
  await getPool().query(
    `UPDATE projects
     SET host=${expr}
     WHERE project_id=$1`,
    params,
  );
}

async function fetchHostAddress(project_id: string): Promise<string | undefined> {
  if (inflight[project_id]) {
    await inflight[project_id];
    return cache.get(project_id);
  }
  inflight[project_id] = (async () => {
    try {
      const { rows } = await getPool().query<{
        host_id: string | null;
        internal_url?: string | null;
        public_url?: string | null;
      }>(
        `
          SELECT host_id,
                 host->>'internal_url' AS internal_url,
                 host->>'public_url'   AS public_url
          FROM projects
          WHERE project_id=$1
        `,
        [project_id],
      );
      const row = rows[0];
      if (row?.host_id) {
        const { rows: hostRows } = await getPool().query<{
          public_url?: string | null;
          internal_url?: string | null;
          ssh_server?: string | null;
          metadata?: any;
        }>(
          `
            SELECT public_url, internal_url, ssh_server, metadata
            FROM project_hosts
            WHERE id=$1 AND deleted IS NULL
          `,
          [row.host_id],
        );
        const hostRow = hostRows[0];
        const machine = hostRow?.metadata?.machine ?? {};
        const selfHostMode = machine?.metadata?.self_host_mode;
        const effectiveSelfHostMode =
          machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
        const isLocalSelfHost =
          machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
        if (isLocalSelfHost) {
          const addr = onPremTunnelAddress(hostRow?.metadata);
          if (!addr) {
            log.debug("local tunnel port missing for project", {
              project_id,
              host_id: row.host_id,
            });
            return;
          }
          cache.set(project_id, addr);
          await updateProjectHostSnapshot(project_id, {
            public_url: hostRow?.public_url,
            internal_url: hostRow?.internal_url,
            ssh_server: hostRow?.ssh_server,
            local_proxy: true,
          });
          return;
        }
        if (hostRow?.public_url || hostRow?.internal_url) {
          cacheHost(project_id, hostRow);
          await updateProjectHostSnapshot(project_id, {
            public_url: hostRow?.public_url,
            internal_url: hostRow?.internal_url,
            ssh_server: hostRow?.ssh_server,
            local_proxy: false,
          });
        }
        return;
      }
      if (row?.internal_url || row?.public_url) {
        cacheHost(project_id, row);
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
): { address?: string } | undefined {
  const project_id = extractProjectId(subject);
  if (!project_id) {
    // log.debug("routeProjectSubject: not a project subject", subject);
    return;
  }

  const cached = cache.get(project_id);
  if (cached) {
    // log.debug("routeProjectSubject: cached", { subject, cached });
    return { address: cached };
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
    const { project_id } = payload;
    if (!project_id || !isValidUUID(project_id)) return;
    cache.delete(project_id);
    void fetchHostAddress(project_id);
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
  project_id: string;
  host?: any;
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

export async function materializeProjectHost(
  project_id: string,
): Promise<string | undefined> {
  const cached = cache.get(project_id);
  if (cached) return cached;
  return await fetchHostAddress(project_id);
}
