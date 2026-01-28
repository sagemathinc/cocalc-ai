import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import { createHostStatusService } from "@cocalc/conat/project-host/api";
import getPool from "@cocalc/database/pool";
import { getLaunchpadLocalConfig } from "@cocalc/server/launchpad/mode";
import { resolveOnPremHost } from "@cocalc/server/onprem";
import { mkdir } from "node:fs/promises";
import {
  maybeStartLaunchpadOnPremServices,
  registerSelfHostSftpKey,
  registerSelfHostTunnelKey,
} from "@cocalc/server/launchpad/onprem-sshd";

const logger = getLogger("server:conat:host-status");

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
            : selfHostMode ?? (hasConnector ? "local" : undefined);
        if (!isSelfHost) {
          logger.warn("local tunnel registration rejected (host not self-hosted)", {
            host_id,
            machine_cloud: machine?.cloud,
            self_host_mode: selfHostMode,
            has_connector: hasConnector,
          });
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
          sshTarget && Number(rows[0]?.metadata?.self_host?.ssh_reverse_port ?? 0);
        const sshdHost =
          process.env.COCALC_SSHD_HOST ??
          process.env.COCALC_LAUNCHPAD_SSHD_HOST ??
          resolveOnPremHost();
        const resolvedSshdHost = reversePort ? "localhost" : sshdHost;
        const resolvedSshdPort = reversePort || config.sshd_port;
        logger.info("local tunnel registered", {
          host_id,
          sshd_host: resolvedSshdHost,
          sshd_port: resolvedSshdPort,
          http_tunnel_port: info.http_tunnel_port,
          ssh_tunnel_port: info.ssh_tunnel_port,
        });
        return {
          sshd_host: resolvedSshdHost,
          sshd_port: resolvedSshdPort,
          ssh_user: config.ssh_user ?? "user",
          http_tunnel_port: info.http_tunnel_port,
          ssh_tunnel_port: info.ssh_tunnel_port,
        };
      },
      async registerOnPremSftpKey({ host_id, public_key }) {
        if (!host_id || !public_key) {
          throw Error("host_id and public_key are required");
        }
        await maybeStartLaunchpadOnPremServices();
        const config = getLaunchpadLocalConfig("local");
        if (!config.sshd_port) {
          throw Error("local network sshd is not configured");
        }
        if (!config.sftp_root) {
          throw Error("local network sftp root is not configured");
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
            : selfHostMode ?? (hasConnector ? "local" : undefined);
        if (!isSelfHost) {
          logger.warn("local sftp registration rejected (host not self-hosted)", {
            host_id,
            machine_cloud: machine?.cloud,
            self_host_mode: selfHostMode,
            has_connector: hasConnector,
          });
          throw Error("host is not self-hosted");
        }
        if (effectiveSelfHostMode !== "local") {
          throw Error("self-host mode is not local");
        }
        await mkdir(config.sftp_root, { recursive: true });
        await registerSelfHostSftpKey({
          host_id,
          public_key,
        });
        const reversePort =
          sshTarget && Number(rows[0]?.metadata?.self_host?.ssh_reverse_port ?? 0);
        const sshdHost =
          process.env.COCALC_SSHD_HOST ??
          process.env.COCALC_LAUNCHPAD_SSHD_HOST ??
          resolveOnPremHost();
        const resolvedSshdHost = reversePort ? "localhost" : sshdHost;
        const resolvedSshdPort = reversePort || config.sshd_port;
        logger.info("local sftp key registered", {
          host_id,
          sshd_host: resolvedSshdHost,
          sshd_port: resolvedSshdPort,
          sftp_root: config.sftp_root,
        });
        return {
          sshd_host: resolvedSshdHost,
          sshd_port: resolvedSshdPort,
          ssh_user: config.ssh_user ?? "user",
          sftp_root: config.sftp_root,
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
          const { rows } = await pool.query<{
            host_id: string | null;
          }>("SELECT host_id FROM projects WHERE project_id=$1", [project_id]);
          const currentHost = rows[0]?.host_id ?? null;
          if (currentHost && currentHost !== host_id) {
            logger.debug("ignoring state from non-owner host", {
              project_id,
              currentHost,
              host_id,
            });
            return { action: "delete" as const };
          }
        }
        const stateObj =
          typeof state === "string" ? { state, time: new Date().toISOString() } : state;
        // NOTE: Do not mutate host/placement here; host assignment is explicit
        // via move/start flows. Updating host_id/host from heartbeat reports
        // can cause split-brain if multiple hosts still have a local row.
        await pool.query("UPDATE projects SET state=$2::jsonb WHERE project_id=$1", [
          project_id,
          stateObj,
        ]);
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
          const { rows } = await pool.query<{
            host_id: string | null;
          }>("SELECT host_id FROM projects WHERE project_id=$1", [project_id]);
          const currentHost = rows[0]?.host_id ?? null;
          if (currentHost && currentHost !== host_id) {
            logger.debug("ignoring provisioned from non-owner host", {
              project_id,
              currentHost,
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
      async reportHostProvisionedInventory({ host_id, project_ids, checked_at }) {
        if (!host_id || !Array.isArray(project_ids)) {
          throw Error("host_id and project_ids are required");
        }
        const pool = getPool();
        const checkedAt = checked_at ? new Date(checked_at) : new Date();
        const { rows } = await pool.query<{ project_id: string }>(
          `
            SELECT project_id
            FROM projects
            WHERE project_id = ANY($1)
              AND host_id IS DISTINCT FROM $2
          `,
          [project_ids, host_id],
        );
        const delete_project_ids = rows.map((row) => row.project_id);
        await pool.query(
          `
            UPDATE projects
            SET provisioned = (project_id = ANY($2)),
                provisioned_checked_at = $3
            WHERE host_id = $1 AND deleted IS NOT TRUE
          `,
          [host_id, project_ids, checkedAt],
        );
        return { delete_project_ids };
      },
    },
  });
}
