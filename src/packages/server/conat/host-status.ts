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
import { isDevGcpReverseTunnelEnabled } from "@cocalc/server/cloud/internal-network";
import { listAccountRevocationsSince } from "@cocalc/server/accounts/revocation";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import {
  DEFAULT_MAX_BACKUPS_PER_PROJECT,
  DEFAULT_MAX_SNAPSHOTS_PER_PROJECT,
} from "@cocalc/server/membership/project-limits";
import { getEffectiveMembershipUsageLimits } from "@cocalc/server/membership/effective-limits";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import {
  storageFundingAccountId,
  storageServiceClassFromMembership,
} from "@cocalc/server/membership/storage-service-class";
import {
  classifyHostProvisionedInventory,
  shouldDeleteHostProjectUpdate,
} from "./host-project-ownership";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import {
  ensureProjectMaintenanceStatusTable,
  recordProjectMaintenanceStatus,
  snapshotScheduleRevision,
} from "@cocalc/server/projects/maintenance-status";

const logger = getLogger("server:conat:host-status");

export async function listHostProjectMaintenanceSchedules({
  host_id,
  limit,
  cursor_project_id,
  project_ids,
}: {
  host_id: string;
  active_days?: number;
  limit?: number;
  cursor_project_id?: string;
  project_ids?: string[];
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
  await ensureProjectMaintenanceStatusTable();

  // Walk a stable project-id cursor. An activity cutoff or debt-ordered LIMIT
  // can hide projects behind the first page forever.
  const params: any[] = [host_id, cursor_project_id ?? null];
  const normalizedLimit = Math.max(
    1,
    Math.min(500, Math.floor(Number(limit ?? 100) || 100)),
  );
  params.push(normalizedLimit);
  const limitParam = `$${params.length}`;
  if (project_ids && project_ids.length > 100) {
    throw Error("too many maintenance project ids");
  }
  let projectFilter = "";
  if (project_ids) {
    params.push(project_ids);
    projectFilter = `AND project_id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await getPool().query<{
    project_id: string;
    last_edited: Date | string | null;
    last_changed: Date | string | null;
    last_backup: Date | string | null;
    last_snapshot: Date | string | null;
    last_snapshot_observed_at: Date | string | null;
    snapshot_reconciled_change_at: Date | string | null;
    snapshot_reconciled_schedule_revision: string | null;
    last_backup_observed_at: Date | string | null;
    snapshot_retry_at: Date | string | null;
    backup_retry_at: Date | string | null;
    snapshot_failures: number | null;
    backup_failures: number | null;
    backup_due_since: Date | string | null;
    snapshots: HostProjectMaintenanceSchedule["snapshots"];
    backups: HostProjectMaintenanceSchedule["backups"];
    owner_account_id: string | null;
    usage_account_id: string | null;
    users: Record<string, { group?: string }> | null;
  }>(
    `SELECT
       project_id,
       last_edited,
       (to_jsonb(projects)->>'last_changed')::TIMESTAMP AS last_changed,
       last_backup,
       (SELECT latest_snapshot_at FROM project_maintenance_status
         WHERE project_id=projects.project_id AND kind='snapshot'
           AND host_id=projects.host_id) AS last_snapshot,
       (SELECT observed_at FROM project_maintenance_status
         WHERE project_id=projects.project_id AND kind='snapshot'
           AND host_id=projects.host_id) AS last_snapshot_observed_at,
       (SELECT reconciled_change_at FROM project_maintenance_status
         WHERE project_id=projects.project_id AND kind='snapshot'
           AND host_id=projects.host_id) AS snapshot_reconciled_change_at,
       (SELECT reconciled_schedule_revision FROM project_maintenance_status
         WHERE project_id=projects.project_id AND kind='snapshot'
           AND host_id=projects.host_id) AS snapshot_reconciled_schedule_revision,
       (SELECT observed_at FROM project_maintenance_status
         WHERE project_id=projects.project_id AND kind='backup'
           AND host_id=projects.host_id) AS last_backup_observed_at,
       (SELECT retry_at FROM project_maintenance_status
         WHERE project_id=projects.project_id AND kind='snapshot'
           AND host_id=projects.host_id) AS snapshot_retry_at,
       (SELECT retry_at FROM project_maintenance_status
         WHERE project_id=projects.project_id AND kind='backup'
           AND host_id=projects.host_id) AS backup_retry_at,
       (SELECT consecutive_failures FROM project_maintenance_status
         WHERE project_id=projects.project_id AND kind='snapshot'
           AND host_id=projects.host_id) AS snapshot_failures,
       (SELECT consecutive_failures FROM project_maintenance_status
         WHERE project_id=projects.project_id AND kind='backup'
           AND host_id=projects.host_id) AS backup_failures,
       CASE
         WHEN COALESCE(backups->>'disabled', 'false') <> 'true'
           AND (
             last_backup IS NULL
             OR COALESCE((to_jsonb(projects)->>'last_changed')::TIMESTAMP, last_edited) > last_backup
           )
         THEN COALESCE(
           (to_jsonb(projects)->>'last_changed')::TIMESTAMP,
           last_edited,
           created
         )
         ELSE NULL
       END AS backup_due_since,
       snapshots,
       backups,
       usage_account_id::text AS usage_account_id,
       users,
       (
         SELECT account_id_text::text
         FROM jsonb_each(COALESCE(users, '{}'::jsonb)) AS u(account_id_text, user_data)
         WHERE COALESCE(u.user_data ->> 'group', '') = 'owner'
         LIMIT 1
       ) AS owner_account_id
     FROM projects
     WHERE host_id=$1
       AND provisioned IS TRUE
       AND deleted IS NOT TRUE
       AND ($2::uuid IS NULL OR project_id > $2::uuid)
       ${projectFilter}
     ORDER BY project_id ASC
     LIMIT ${limitParam}`,
    params,
  );
  const limitsByOwner = new Map<
    string,
    {
      max_snapshots_per_project: number;
      max_backups_per_project: number;
    }
  >();
  const accountIds = Array.from(
    new Set(
      rows
        .flatMap((row) => {
          const ownerId = `${row.owner_account_id ?? ""}`.trim();
          return [ownerId, storageFundingAccountId(row)];
        })
        .filter((account_id): account_id is string => Boolean(account_id)),
    ),
  );
  const serviceByAccount = new Map<
    string,
    { service_class: "paying" | "free"; priority: number }
  >();
  for (let offset = 0; offset < accountIds.length; offset += 16) {
    await Promise.all(
      accountIds.slice(offset, offset + 16).map(async (account_id) => {
        const resolution = await resolveMembershipForAccount(account_id);
        const limits = getEffectiveMembershipUsageLimits(resolution);
        limitsByOwner.set(account_id, {
          max_snapshots_per_project:
            limits.max_snapshots_per_project ??
            DEFAULT_MAX_SNAPSHOTS_PER_PROJECT,
          max_backups_per_project:
            limits.max_backups_per_project ?? DEFAULT_MAX_BACKUPS_PER_PROJECT,
        });
        serviceByAccount.set(account_id, {
          service_class: storageServiceClassFromMembership(resolution),
          priority: limits.shared_compute_priority ?? 0,
        });
      }),
    );
  }
  return rows.map((row) => {
    const storage_account_id = storageFundingAccountId(row);
    // Existing snapshot and backup entitlements belong to the project owner.
    // Funding priority may follow a different usage account; changing limits
    // here would silently alter the product's storage entitlement policy.
    const ownerId = `${row.owner_account_id ?? ""}`.trim();
    const limits = ownerId ? limitsByOwner.get(ownerId) : undefined;
    const service = storage_account_id
      ? serviceByAccount.get(storage_account_id)
      : undefined;
    const schedule: HostProjectMaintenanceSchedule = {
      project_id: row.project_id,
      storage_account_id: storage_account_id || null,
      storage_service_class: service?.service_class ?? "free",
      storage_priority: service?.priority ?? 0,
      last_edited:
        row.last_edited == null
          ? null
          : row.last_edited instanceof Date
            ? row.last_edited.toISOString()
            : `${row.last_edited}`,
      snapshots: row.snapshots ?? null,
      snapshot_schedule_revision: snapshotScheduleRevision(row.snapshots),
      backups: row.backups ?? null,
      max_snapshots_per_project:
        limits?.max_snapshots_per_project ?? DEFAULT_MAX_SNAPSHOTS_PER_PROJECT,
      max_backups_per_project:
        limits?.max_backups_per_project ?? DEFAULT_MAX_BACKUPS_PER_PROJECT,
    };
    if (row.last_changed != null) {
      schedule.last_changed =
        row.last_changed instanceof Date
          ? row.last_changed.toISOString()
          : `${row.last_changed}`;
    }
    schedule.last_backup =
      row.last_backup == null
        ? null
        : row.last_backup instanceof Date
          ? row.last_backup.toISOString()
          : `${row.last_backup}`;
    schedule.last_snapshot =
      row.last_snapshot == null
        ? null
        : row.last_snapshot instanceof Date
          ? row.last_snapshot.toISOString()
          : `${row.last_snapshot}`;
    schedule.last_snapshot_observed_at =
      row.last_snapshot_observed_at == null
        ? null
        : row.last_snapshot_observed_at instanceof Date
          ? row.last_snapshot_observed_at.toISOString()
          : `${row.last_snapshot_observed_at}`;
    schedule.snapshot_reconciled_change_at =
      row.snapshot_reconciled_change_at == null
        ? null
        : row.snapshot_reconciled_change_at instanceof Date
          ? row.snapshot_reconciled_change_at.toISOString()
          : `${row.snapshot_reconciled_change_at}`;
    schedule.snapshot_reconciled_schedule_revision =
      row.snapshot_reconciled_schedule_revision ?? null;
    schedule.last_backup_observed_at =
      row.last_backup_observed_at == null
        ? null
        : row.last_backup_observed_at instanceof Date
          ? row.last_backup_observed_at.toISOString()
          : `${row.last_backup_observed_at}`;
    schedule.snapshot_retry_at =
      row.snapshot_retry_at == null
        ? null
        : row.snapshot_retry_at instanceof Date
          ? row.snapshot_retry_at.toISOString()
          : `${row.snapshot_retry_at}`;
    schedule.backup_retry_at =
      row.backup_retry_at == null
        ? null
        : row.backup_retry_at instanceof Date
          ? row.backup_retry_at.toISOString()
          : `${row.backup_retry_at}`;
    schedule.snapshot_failures = row.snapshot_failures ?? 0;
    schedule.backup_failures = row.backup_failures ?? 0;
    schedule.backup_due_since =
      row.backup_due_since == null
        ? null
        : row.backup_due_since instanceof Date
          ? row.backup_due_since.toISOString()
          : `${row.backup_due_since}`;
    return schedule;
  });
}

export async function confirmHostProjectMaintenanceAssignment({
  host_id,
  project_id,
  kind,
  schedule_revision,
  observed_change_at,
}: {
  host_id: string;
  project_id: string;
  kind: "snapshot" | "backup";
  schedule_revision: string;
  observed_change_at: string | null;
}): Promise<{
  valid: boolean;
  reason?:
    | "assignment_changed"
    | "schedule_changed"
    | "change_generation_changed";
}> {
  const { rows } = await getPool().query<{
    snapshots: HostProjectMaintenanceSchedule["snapshots"];
    backups: HostProjectMaintenanceSchedule["backups"];
    observed_change_at: Date | string | null;
  }>(
    `SELECT snapshots, backups,
            COALESCE((to_jsonb(projects)->>'last_changed')::TIMESTAMP,
                     last_edited) AS observed_change_at
       FROM projects
      WHERE project_id=$1 AND host_id=$2
        AND provisioned IS TRUE AND deleted IS NOT TRUE
      LIMIT 1`,
    [project_id, host_id],
  );
  const row = rows[0];
  if (!row) return { valid: false, reason: "assignment_changed" };
  if (
    snapshotScheduleRevision(
      kind === "snapshot" ? row.snapshots : row.backups,
    ) !== schedule_revision
  ) {
    return { valid: false, reason: "schedule_changed" };
  }
  const currentChange =
    row.observed_change_at == null
      ? null
      : new Date(row.observed_change_at).toISOString();
  if (currentChange !== observed_change_at) {
    return { valid: false, reason: "change_generation_changed" };
  }
  return { valid: true };
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
        const allowDevGcpTunnel = isDevGcpReverseTunnelEnabled();
        const isDevGcpHost = allowDevGcpTunnel && machine?.cloud === "gcp";
        const isSelfHost =
          machine?.cloud === "self-host" ||
          selfHostMode === "local" ||
          selfHostMode === "cloudflare" ||
          hasConnector;
        const effectiveSelfHostMode =
          machine?.cloud === "self-host" && !selfHostMode
            ? "local"
            : (selfHostMode ?? (hasConnector ? "local" : undefined));
        if (!isSelfHost && !isDevGcpHost) {
          logger.warn(
            "local tunnel registration rejected (host not tunnel-eligible)",
            {
              host_id,
              machine_cloud: machine?.cloud,
              self_host_mode: selfHostMode,
              has_connector: hasConnector,
              dev_gcp_tunnel_enabled: allowDevGcpTunnel,
            },
          );
          throw Error("host is not tunnel-eligible");
        }
        if (!isDevGcpHost && effectiveSelfHostMode !== "local") {
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
          conat_router_port: info.conat_router_port,
        });
        return {
          sshd_host: resolvedSshdHost,
          sshd_port: resolvedSshdPort,
          ssh_user: config.ssh_user ?? "user",
          http_tunnel_port: info.http_tunnel_port,
          ssh_tunnel_port: info.ssh_tunnel_port,
          rest_port: restPort,
          conat_router_port: info.conat_router_port,
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
        const stateTime = (() => {
          const value = typeof state === "string" ? undefined : state.time;
          if (value == null) return new Date().toISOString();
          const time = new Date(value);
          return Number.isFinite(time.getTime())
            ? time.toISOString()
            : new Date().toISOString();
        })();
        const stateObj = {
          ...(typeof state === "string" ? { state } : state),
          time: stateTime,
        };
        // NOTE: Do not mutate host/placement here; host assignment is explicit
        // via move/start flows. Updating host_id/host from heartbeat reports
        // can cause split-brain if multiple hosts still have a local row.
        const client = await pool.connect();
        let changed = false;
        try {
          await client.query("BEGIN");
          const result = await client.query(
            `UPDATE projects
                SET state=$2::jsonb || jsonb_strip_nulls(jsonb_build_object(
                  'runtime_generation',
                  CASE
                    WHEN state->>'runtime_generation' ~ '^[0-9]+$'
                      THEN (state->>'runtime_generation')::bigint
                    ELSE NULL
                  END,
                  'started_at', state->>'started_at'
                ))
              WHERE project_id=$1
                AND (
                  state->>'time' IS NULL
                  OR state->>'time' <= $3::text
                )
                AND state IS DISTINCT FROM (
                  $2::jsonb || jsonb_strip_nulls(jsonb_build_object(
                    'runtime_generation',
                    CASE
                      WHEN state->>'runtime_generation' ~ '^[0-9]+$'
                        THEN (state->>'runtime_generation')::bigint
                      ELSE NULL
                    END,
                    'started_at', state->>'started_at'
                  ))
                )`,
            [project_id, stateObj, stateTime],
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
      async listProjectMaintenanceSchedules({
        host_id,
        active_days,
        limit,
        cursor_project_id,
        project_ids,
      }) {
        return await listHostProjectMaintenanceSchedules({
          host_id,
          active_days,
          limit,
          cursor_project_id,
          project_ids,
        });
      },
      async confirmProjectMaintenanceAssignment(opts) {
        return await confirmHostProjectMaintenanceAssignment(opts);
      },
      async reportProjectMaintenance(report) {
        await recordProjectMaintenanceStatus(report);
      },
    },
  });
}
