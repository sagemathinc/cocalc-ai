import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import {
  createHostStatusService,
  type HostProjectMaintenanceSchedule,
} from "@cocalc/conat/project-host/api";
import getPool from "@cocalc/database/pool";
import { getLaunchpadLocalConfig } from "@cocalc/server/launchpad/mode";
import { resolveOnPremHost } from "@cocalc/server/onprem";
import {
  maybeStartLaunchpadOnPremServices,
  getLaunchpadRestPort,
  registerSelfHostTunnelKey,
} from "@cocalc/server/launchpad/onprem-sshd";
import { listAccountRevocationsSince } from "@cocalc/server/accounts/revocation";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import {
  classifyHostProvisionedInventory,
  shouldDeleteHostProjectUpdate,
} from "./host-project-ownership";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";

const logger = getLogger("server:conat:host-status");

export async function listHostProjectMaintenanceSchedules({
  host_id,
  active_days,
}: {
  host_id: string;
  active_days?: number;
}): Promise<HostProjectMaintenanceSchedule[]> {
  if (!host_id) {
    throw Error("host_id is required");
  }
  const { rows: hostRows } = await getPool().query<{ id: string }>(
    `SELECT id FROM project_hosts WHERE id=$1 AND deleted IS NULL LIMIT 1`,
    [host_id],
  );
  if (!hostRows.length) {
    throw Error("host not found");
  }

  const normalizedActiveDays = Math.max(
    0,
    Math.floor(Number(active_days ?? 0) || 0),
  );
  const params: any[] = [host_id];
  let activeWhere = "";
  if (normalizedActiveDays > 0) {
    params.push(normalizedActiveDays);
    activeWhere = ` AND last_edited >= NOW() - ($2::int * INTERVAL '1 day')`;
  }
  const { rows } = await getPool().query<{
    project_id: string;
    last_edited: Date | string | null;
    snapshots: HostProjectMaintenanceSchedule["snapshots"];
    backups: HostProjectMaintenanceSchedule["backups"];
  }>(
    `SELECT project_id, last_edited, snapshots, backups
     FROM projects
     WHERE host_id=$1
       AND provisioned IS TRUE
       AND deleted IS NOT TRUE${activeWhere}
     ORDER BY last_edited DESC NULLS LAST, project_id ASC`,
    params,
  );
  return rows.map((row) => ({
    project_id: row.project_id,
    last_edited:
      row.last_edited == null
        ? null
        : row.last_edited instanceof Date
          ? row.last_edited.toISOString()
          : `${row.last_edited}`,
    snapshots: row.snapshots ?? null,
    backups: row.backups ?? null,
  }));
}

export async function initHostStatusService() {
  logger.info("starting host status service");
  return await createHostStatusService({
    client: await conat(),
    impl: {
      async registerOnPremTunnel({ host_id, public_key }) {
        if (!host_id || !public_key) {
          throw Error("host_id and public_key are required");
        }
        await maybeStartLaunchpadOnPremServices();
        const config = getLaunchpadLocalConfig("local");
        if (!config.sshd_port) {
          throw Error("local network sshd is not configured");
        }
        const { rows } = await getPool().query<{ id: string; metadata: any }>(
          `SELECT id, metadata
           FROM project_hosts
           WHERE id=$1 AND deleted IS NULL`,
          [host_id],
        );
        if (!rows.length) {
          throw Error("host not found");
        }
        const machine = rows[0]?.metadata?.machine ?? {};
        const selfHostMode = machine?.metadata?.self_host_mode;
        const sshTarget = String(
          machine?.metadata?.self_host_ssh_target ?? "",
        ).trim();
        const { rows: connectorRows } = await getPool().query<{
          connector_id: string;
        }>(
          `SELECT connector_id
           FROM self_host_connectors
           WHERE host_id=$1 AND revoked IS NOT TRUE
           LIMIT 1`,
          [host_id],
        );
        const hasConnector = connectorRows.length > 0;
        const isSelfHost =
          machine?.cloud === "self-host" ||
          selfHostMode === "local" ||
          selfHostMode === "cloudflare" ||
          hasConnector;
        const effectiveSelfHostMode =
          machine?.cloud === "self-host" && !selfHostMode
            ? "local"
            : (selfHostMode ?? (hasConnector ? "local" : undefined));
        if (!isSelfHost) {
          logger.warn(
            "local tunnel registration rejected (host not self-hosted)",
            {
              host_id,
              machine_cloud: machine?.cloud,
              self_host_mode: selfHostMode,
              has_connector: hasConnector,
            },
          );
          throw Error("host is not self-hosted");
        }
        if (effectiveSelfHostMode !== "local") {
          throw Error("self-host mode is not local");
        }
        const info = await registerSelfHostTunnelKey({
          host_id,
          public_key,
        });
        const reversePort =
          sshTarget &&
          Number(rows[0]?.metadata?.self_host?.ssh_reverse_port ?? 0);
        const sshdHost =
          process.env.COCALC_SSHD_HOST ??
          process.env.COCALC_LAUNCHPAD_SSHD_HOST ??
          resolveOnPremHost();
        const resolvedSshdHost = reversePort ? "localhost" : sshdHost;
        const resolvedSshdPort = reversePort || config.sshd_port;
        const restPort = getLaunchpadRestPort() ?? config.rest_port;
        if (!restPort) {
          throw Error("rest-server is not running");
        }
        logger.info("local tunnel registered", {
          host_id,
          sshd_host: resolvedSshdHost,
          sshd_port: resolvedSshdPort,
          http_tunnel_port: info.http_tunnel_port,
          ssh_tunnel_port: info.ssh_tunnel_port,
          rest_port: restPort,
        });
        return {
          sshd_host: resolvedSshdHost,
          sshd_port: resolvedSshdPort,
          ssh_user: config.ssh_user ?? "user",
          http_tunnel_port: info.http_tunnel_port,
          ssh_tunnel_port: info.ssh_tunnel_port,
          rest_port: restPort,
        };
      },
      async reportProjectState({ project_id, state, host_id }) {
        if (!project_id || !state) {
          throw Error("project_id and state are required");
        }
        const pool = getPool();
        // If the reporting host does not own this project, ignore the update
        // and tell the host to clean up its local copy. This prevents stale
        // hosts from flipping placement.
        if (host_id) {
          if (
            await shouldDeleteHostProjectUpdate({
              host_id,
              project_id,
            })
          ) {
            logger.debug("ignoring state from non-owner host", {
              project_id,
              host_id,
            });
            return { action: "delete" as const };
          }
        }
        const stateObj =
          typeof state === "string"
            ? { state, time: new Date().toISOString() }
            : state;
        // NOTE: Do not mutate host/placement here; host assignment is explicit
        // via move/start flows. Updating host_id/host from heartbeat reports
        // can cause split-brain if multiple hosts still have a local row.
        const client = await pool.connect();
        let changed = false;
        try {
          await client.query("BEGIN");
          const result = await client.query(
            `UPDATE projects
                SET state=$2::jsonb
              WHERE project_id=$1
                AND state IS DISTINCT FROM $2::jsonb`,
            [project_id, stateObj],
          );
          if ((result.rowCount ?? 0) > 0) {
            changed = true;
            await appendProjectOutboxEventForProject({
              db: client,
              event_type: "project.state_changed",
              project_id,
              default_bay_id: getConfiguredBayId(),
            });
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        if (changed) {
          await publishProjectAccountFeedEventsBestEffort({
            project_id,
            default_bay_id: getConfiguredBayId(),
          });
        }
      },
      async reportProjectProvisioned({
        project_id,
        provisioned,
        host_id,
        checked_at,
      }) {
        if (!project_id || typeof provisioned !== "boolean") {
          throw Error("project_id and provisioned are required");
        }
        const pool = getPool();
        if (host_id) {
          if (
            await shouldDeleteHostProjectUpdate({
              host_id,
              project_id,
            })
          ) {
            logger.debug("ignoring provisioned from non-owner host", {
              project_id,
              host_id,
            });
            return { action: "delete" as const };
          }
        }
        const checkedAt = checked_at ? new Date(checked_at) : new Date();
        await pool.query(
          "UPDATE projects SET provisioned=$2, provisioned_checked_at=$3 WHERE project_id=$1",
          [project_id, provisioned, checkedAt],
        );
      },
      async reportHostProvisionedInventory({
        host_id,
        project_ids,
        checked_at,
      }) {
        if (!host_id || !Array.isArray(project_ids)) {
          throw Error("host_id and project_ids are required");
        }
        const pool = getPool();
        const checkedAt = checked_at ? new Date(checked_at) : new Date();
        const seen = new Set<string>();
        const normalizedProjectIds: string[] = [];
        for (const project_id of project_ids) {
          const value = `${project_id ?? ""}`.trim();
          if (!value || seen.has(value)) continue;
          seen.add(value);
          normalizedProjectIds.push(value);
        }
        const { accepted_project_ids, delete_project_ids } =
          await classifyHostProvisionedInventory({
            host_id,
            project_ids: normalizedProjectIds,
          });
        await pool.query(
          `
            UPDATE projects
            SET provisioned = (projects.project_id::text = ANY($2::text[])),
                provisioned_checked_at = $3
            FROM project_hosts
            WHERE projects.host_id = $1
              AND projects.deleted IS NOT TRUE
              AND project_hosts.id = projects.host_id
              AND project_hosts.deleted IS NULL
              AND COALESCE(projects.owning_bay_id, $4) = COALESCE(project_hosts.bay_id, $4)
          `,
          [host_id, accepted_project_ids, checkedAt, getConfiguredBayId()],
        );
        return { delete_project_ids };
      },
      async syncAccountRevocations({
        host_id,
        cursor_updated_ms,
        cursor_account_id,
        limit,
      }) {
        if (!host_id) {
          throw Error("host_id is required");
        }
        const hostRows = (
          await getPool().query<{ id: string }>(
            `SELECT id FROM project_hosts WHERE id=$1 AND deleted IS NULL LIMIT 1`,
            [host_id],
          )
        ).rows;
        if (!hostRows.length) {
          throw Error("host not found");
        }
        const rows = await listAccountRevocationsSince({
          cursor_updated_ms,
          cursor_account_id,
          limit,
        });
        const last = rows[rows.length - 1];
        return {
          rows,
          next_cursor_updated_ms: last?.updated_ms,
          next_cursor_account_id: last?.account_id,
        };
      },
      async listProjectMaintenanceSchedules({ host_id, active_days }) {
        return await listHostProjectMaintenanceSchedules({
          host_id,
          active_days,
        });
      },
    },
  });
}
