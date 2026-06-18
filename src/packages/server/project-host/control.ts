import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type { Host, HostPressureZone } from "@cocalc/conat/hub/api/hosts";
import type { ManagedProjectEgressOverride } from "@cocalc/conat/files/file-server";
import type { HostControlApi } from "@cocalc/conat/project-host/api";
import sshKeys from "../projects/get-ssh-keys";
import { notifyProjectHostUpdate } from "../conat/route-project";
import { getConfiguredBayId } from "../bay-config";
import {
  computePlacementPermission,
  getUserHostTier,
  normalizeHostTier,
} from "./placement";
import { machineHasGpu } from "../cloud/host-gpu";
import { maybeAutoGrowHostDiskForReservationFailure } from "./auto-grow";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import {
  getAssignedProjectHostInfo,
  PROJECT_HAS_NO_ASSIGNED_HOST_ERROR,
} from "@cocalc/server/conat/project-host-assignment";
import { getCurrentProjectRootfsBinding } from "@cocalc/server/projects/rootfs-state";
import { assertCanRestoreProvisionedProjectStorage } from "@cocalc/server/membership/project-limits";
import {
  formatManagedProjectCpuPolicyBlockMessage,
  getManagedProjectCpuPolicy,
} from "@cocalc/server/membership/managed-cpu-policy";
import { countsTowardManagedCpuBudgetForHost } from "@cocalc/server/membership/managed-cpu-scope";
import { cancelStaleProjectStartLros } from "@cocalc/server/projects/start-lro-cleanup";
import { getLro } from "@cocalc/server/lro/lro-db";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";
import { mapCloudRegionToR2Region, parseR2Region } from "@cocalc/util/consts";
import { getRoutedHostControlClient } from "./client";
import { resolveHostBayAcrossCluster } from "@cocalc/server/inter-bay/directory";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getConfiguredClusterBayIdsForStaticEnumerationOnly } from "@cocalc/server/cluster-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  mergeStartProjectTimings,
  takeStartProjectTimings,
} from "@cocalc/server/projects/start-timings";
import type {
  HostAccessRole,
  HostEffectiveAccessRole,
} from "@cocalc/conat/hub/api/hosts";

const log = getLogger("server:project-host:control");
// Project starts can include large restores, so allow a long RPC timeout.
const START_PROJECT_TIMEOUT_MS = 60 * 60 * 1000;
const STOP_PROJECT_TIMEOUT_MS = 30 * 1000;
const RECENT_RUNNING_STATE_MS = 60 * 1000;
const RECENT_STARTING_STATE_MS = 5 * 60 * 1000;
const TERMINAL_START_LRO_STATUSES = new Set([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);
type StartProjectInFlight = {
  op_id?: string;
  promise: Promise<void>;
};
const startProjectInFlight = new Map<string, StartProjectInFlight>();

type HostPlacement = {
  host_id: string;
};

type HostRegistryRow = {
  id: string;
  bay_id?: string | null;
  name?: string | null;
  region?: string | null;
  public_url?: string | null;
  internal_url?: string | null;
  ssh_server?: string | null;
  tier?: number | null;
  metadata?: any;
  delegated_access_role?: HostAccessRole | null;
};

function hostToRegistryRow(host: Host): HostRegistryRow {
  return {
    id: host.id,
    bay_id: host.bay_id,
    name: host.name,
    region: host.region,
    public_url: host.public_url,
    internal_url: host.internal_url,
    ssh_server: host.ssh_server,
    tier: host.tier ?? null,
    metadata: {
      owner: host.owner,
      machine: host.machine,
      pressure: host.pressure,
      billing: {
        enforcement: host.billing_enforcement,
      },
    },
    delegated_access_role:
      host.access_role === "manager" || host.access_role === "user"
        ? host.access_role
        : null,
  };
}

const HOST_PLACEMENT_PRESSURE_RANK: Record<HostPressureZone, number> = {
  normal: 0,
  observe: 1,
  pressure: 2,
  emergency: 3,
};

export type ProjectMeta = {
  title?: string;
  users?: any;
  image?: string;
  host_id?: string;
  region?: string | null;
  owning_bay_id?: string;
  authorized_keys?: string;
  run_quota?: any;
};

const pool = () => getPool();

function normalizeHostPressureZone(
  value: unknown,
): HostPressureZone | undefined {
  switch (`${value ?? ""}`.trim()) {
    case "normal":
    case "observe":
    case "pressure":
    case "emergency":
      return `${value}`.trim() as HostPressureZone;
    default:
      return;
  }
}

export function hostPlacementPressureRank(
  zone: HostPressureZone | undefined,
): number {
  if (!zone) return HOST_PLACEMENT_PRESSURE_RANK.normal;
  return (
    HOST_PLACEMENT_PRESSURE_RANK[zone] ?? HOST_PLACEMENT_PRESSURE_RANK.normal
  );
}

export function choosePlacementHostRow<T extends HostRegistryRow>(
  rows: T[],
  random: () => number = Math.random,
  project_region?: string,
): T | undefined {
  const eligibleRows =
    project_region == null
      ? rows
      : rows.filter(
          (row) =>
            mapCloudRegionToR2Region(row.region ?? "") === project_region,
        );
  if (eligibleRows.length === 0) return;
  let bestRank = Number.POSITIVE_INFINITY;
  const rankedRows: Array<{ row: T; rank: number }> = [];
  for (const row of eligibleRows) {
    const rank = hostPlacementPressureRank(
      normalizeHostPressureZone(row.metadata?.pressure?.zone),
    );
    rankedRows.push({ row, rank });
    if (rank < bestRank) {
      bestRank = rank;
    }
  }
  const bestRows = rankedRows
    .filter(({ rank }) => rank === bestRank)
    .map(({ row }) => row);
  if (bestRows.length === 0) return;
  const index = Math.min(
    bestRows.length - 1,
    Math.max(0, Math.floor(random() * bestRows.length)),
  );
  return bestRows[index];
}

function mapHostRegistryRow(row: HostRegistryRow) {
  const machine = row?.metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const isLocalSelfHost =
    (machine?.cloud === "self-host" && effectiveSelfHostMode === "local") ||
    row?.metadata?.local === true ||
    row?.metadata?.provider === "star" ||
    row?.metadata?.cloud_provider === "star";
  const tier = row.tier == null ? undefined : normalizeHostTier(row.tier);
  const pressure =
    typeof row?.metadata?.pressure === "object" && row.metadata.pressure != null
      ? row.metadata.pressure
      : undefined;
  return {
    id: row.id,
    bay_id: effectiveBayId(row.bay_id),
    name: row.name,
    region: row.region,
    public_url: row.public_url,
    internal_url: row.internal_url,
    ssh_server: row.ssh_server,
    tier,
    local_proxy: isLocalSelfHost,
    pressure,
  };
}

function normalizeDelegatedAccessRole(
  role?: string | null,
): HostAccessRole | undefined {
  const normalized = `${role ?? ""}`.trim().toLowerCase();
  if (normalized === "user" || normalized === "manager") {
    return normalized;
  }
  return undefined;
}

function hostOwnerAccountId(row: HostRegistryRow): string {
  return `${row.metadata?.owner ?? row.metadata?.owner_account_id ?? ""}`.trim();
}

async function filterRowsPlaceableByAccount<T extends HostRegistryRow>({
  rows,
  account_id,
}: {
  rows: T[];
  account_id?: string;
}): Promise<T[]> {
  if (!account_id) {
    // Internal background fallback has no user context, so it must never pick a
    // private/dedicated host. Shared pool hosts are the only safe default.
    return rows.filter((row) => row.tier != null);
  }

  const [membership, admin] = await Promise.all([
    resolveMembershipForAccount(account_id),
    isAdmin(account_id),
  ]);
  const userTier = getUserHostTier(membership.entitlements);

  return rows.filter((row) => {
    const delegatedRole = normalizeDelegatedAccessRole(
      row.delegated_access_role,
    );
    const isOwner = hostOwnerAccountId(row) === account_id;
    const accessRole: HostEffectiveAccessRole | undefined = isOwner
      ? "owner"
      : delegatedRole != null
        ? delegatedRole
        : admin
          ? "admin"
          : undefined;
    return computePlacementPermission({
      tier: row.tier == null ? undefined : normalizeHostTier(row.tier),
      userTier,
      isOwner,
      accessRole,
      hasDedicatedAccess: delegatedRole != null,
    }).can_place;
  });
}

async function saveProjectStateSnapshot(
  project_id: string,
  state: string | { state?: string; time?: string | Date } | undefined,
): Promise<void> {
  if (!state) return;
  const stateObj =
    typeof state === "string"
      ? { state, time: new Date().toISOString() }
      : {
          ...state,
          time:
            state.time instanceof Date
              ? state.time.toISOString()
              : (state.time ?? new Date().toISOString()),
        };
  if (!stateObj.state) {
    return;
  }
  const defaultBayId = getConfiguredBayId();
  const client = await pool().connect();
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
    changed = (result.rowCount ?? 0) > 0;
    if (changed) {
      await appendProjectOutboxEventForProject({
        db: client,
        event_type: "project.state_changed",
        project_id,
        default_bay_id: defaultBayId,
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
      default_bay_id: defaultBayId,
    });
  }
}

function effectiveBayId(bay_id?: string | null): string {
  const value = `${bay_id ?? ""}`.trim();
  return value || getConfiguredBayId();
}

async function getProjectStateSnapshot(
  project_id: string,
): Promise<{ state?: string; timeMs?: number }> {
  try {
    const { rows } = await pool().query<{ state: any }>(
      "SELECT state FROM projects WHERE project_id=$1",
      [project_id],
    );
    const rawState = rows[0]?.state;
    const parsed =
      typeof rawState === "string" ? JSON.parse(rawState) : (rawState ?? {});
    const state = parsed?.state;
    const timeMs =
      parsed?.time != null ? new Date(parsed.time).getTime() : undefined;
    return {
      state: typeof state === "string" ? state : undefined,
      timeMs: Number.isFinite(timeMs) ? timeMs : undefined,
    };
  } catch (err) {
    log.debug("getProjectStateSnapshot failed", { project_id, err: `${err}` });
    return {};
  }
}

async function getAssignedProjectHostControlClient({
  project_id,
  timeout,
}: {
  project_id: string;
  timeout?: number;
}): Promise<{ host_id: string; client: HostControlApi }> {
  const { host_id } = await getAssignedProjectHostInfo(project_id);
  return {
    host_id,
    client: await getRoutedHostControlClient({ host_id, timeout }),
  };
}

async function hasActiveProjectStartLro(project_id: string): Promise<boolean> {
  const { rows } = await pool().query<{ exists: boolean }>(
    `
      SELECT EXISTS(
        SELECT 1
        FROM long_running_operations
        WHERE kind = 'project-start'
          AND scope_type = 'project'
          AND scope_id = $1
          AND dismissed_at IS NULL
          AND status IN ('queued', 'running')
      ) AS exists
    `,
    [project_id],
  );
  return !!rows[0]?.exists;
}

export function shouldSkipStartForSnapshot({
  state,
  timeMs,
  hasActiveStartLro,
  ignoreRecentState = false,
  nowMs = Date.now(),
}: {
  state?: string;
  timeMs?: number;
  hasActiveStartLro: boolean;
  ignoreRecentState?: boolean;
  nowMs?: number;
}): { skip: boolean; reason?: string } {
  if (state === "starting") {
    if (hasActiveStartLro) {
      return { skip: true, reason: "active-start-lro" };
    }
    if (ignoreRecentState) {
      return { skip: false };
    }
    const isRecent =
      timeMs != null && nowMs - timeMs <= RECENT_STARTING_STATE_MS;
    if (isRecent) {
      return { skip: true, reason: "recent-starting-state" };
    }
    return { skip: false };
  }
  if (state === "running") {
    if (ignoreRecentState) {
      return { skip: false };
    }
    const isRecent =
      timeMs != null && nowMs - timeMs <= RECENT_RUNNING_STATE_MS;
    if (isRecent) {
      return { skip: true, reason: "recent-running-state" };
    }
  }
  return { skip: false };
}

export async function loadProject(project_id: string): Promise<ProjectMeta> {
  const { rows } = await pool().query(
    "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1",
    [project_id],
  );
  if (!rows[0]) throw Error(`project ${project_id} not found`);
  const keys = await sshKeys(project_id);
  const authorized_keys = Object.values(keys)
    .map((k: any) => k.value)
    .join("\n");
  const image =
    `${rows[0].image ?? ""}`.trim() ||
    (await getCurrentProjectRootfsBinding({ project_id }))?.image ||
    DEFAULT_PROJECT_IMAGE;
  return { ...rows[0], image, authorized_keys };
}

async function hostHasGpu(host_id: string): Promise<boolean> {
  const { rows } = await pool().query(
    "SELECT metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  const metadata = rows[0]?.metadata ?? {};
  const machine = metadata?.machine ?? {};
  return machineHasGpu(machine);
}

async function applyHostGpuToRunQuota(
  run_quota: any | undefined,
  host_id: string,
): Promise<any> {
  const quota = run_quota ? { ...run_quota } : {};
  if (await hostHasGpu(host_id)) {
    quota.gpu = true;
  } else {
    if (Object.prototype.hasOwnProperty.call(quota, "gpu")) {
      quota.gpu = false;
    }
    if (Object.prototype.hasOwnProperty.call(quota, "gpu_count")) {
      delete quota.gpu_count;
    }
  }
  return quota;
}

export async function loadHostFromRegistry(host_id: string) {
  const { rows } = await pool().query(
    "SELECT id, bay_id, name, region, public_url, internal_url, ssh_server, tier, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  if (!rows[0]) return undefined;
  return mapHostRegistryRow(rows[0]);
}

async function hostExistsAnywhere(host_id: string): Promise<boolean> {
  return !!(await resolveHostBayAcrossCluster(host_id));
}

export async function selectActiveHost({
  exclude_host_id,
  bay_id,
  project_region,
  account_id,
}: {
  exclude_host_id?: string;
  bay_id?: string;
  project_region?: string;
  account_id?: string;
} = {}) {
  const targetBayId = effectiveBayId(bay_id);
  const loadCandidateRows = async ({
    anyBay = false,
    sharedPoolOnly = false,
  }: {
    anyBay?: boolean;
    sharedPoolOnly?: boolean;
  } = {}) => {
    const params: any[] = [];
    const where: string[] = [
      "status='running'",
      "deleted IS NULL",
      "last_seen > NOW() - interval '2 minutes'",
      "COALESCE(metadata #>> '{billing,enforcement,state}', 'ok') NOT IN ('at_risk', 'draining', 'stopped_billing_blocked', 'deprovision_pending', 'deprovisioned_recoverable')",
    ];
    if (exclude_host_id) {
      params.push(exclude_host_id);
      where.push(`id != $${params.length}`);
    }
    if (!anyBay) {
      params.push(targetBayId);
      where.push(`COALESCE(bay_id, $${params.length}) = $${params.length}`);
    }
    if (sharedPoolOnly) {
      where.push("tier IS NOT NULL");
    }
    let delegatedAccessJoin = "";
    let delegatedAccessSelect = "NULL::text AS delegated_access_role";
    if (account_id) {
      params.push(account_id);
      delegatedAccessSelect = "delegated_access.delegated_access_role";
      delegatedAccessJoin = `
      LEFT JOIN LATERAL (
        SELECT access.role AS delegated_access_role
        FROM project_host_access access
        WHERE access.host_id = project_hosts.id
          AND access.account_id::text = $${params.length}::text
          AND access.revoked_at IS NULL
        LIMIT 1
      ) delegated_access ON TRUE`;
    }
    const { rows } = await pool().query<HostRegistryRow>(
      `
      SELECT id, bay_id, name, region, public_url, internal_url, ssh_server, tier, metadata,
             ${delegatedAccessSelect}
      FROM project_hosts
      ${delegatedAccessJoin}
      WHERE ${where.join("\n        AND ")}
    `,
      params,
    );
    return rows;
  };
  const loadRemoteSharedPoolCandidateRows = async () => {
    if (!account_id) {
      return [];
    }
    const currentBayId = getConfiguredBayId();
    const remoteRows: HostRegistryRow[] = [];
    await Promise.all(
      getConfiguredClusterBayIdsForStaticEnumerationOnly()
        .filter((candidateBayId) => candidateBayId !== currentBayId)
        .map(async (candidateBayId) => {
          try {
            const hosts = await getInterBayBridge()
              .hostConnection(candidateBayId)
              .list({
                account_id,
                catalog: false,
              });
            remoteRows.push(
              ...hosts
                .filter((host) => host.tier != null && host.can_place !== false)
                .map(hostToRegistryRow),
            );
          } catch (err) {
            log.warn("selectActiveHost: failed remote shared-pool host scan", {
              bay_id: candidateBayId,
              err: `${err}`,
            });
          }
        }),
    );
    return remoteRows;
  };
  const choosePlaceableRow = async (rows: HostRegistryRow[]) => {
    const placeableRows = await filterRowsPlaceableByAccount({
      rows,
      account_id,
    });
    return choosePlacementHostRow(placeableRows, Math.random, project_region);
  };

  const sameBayRow = await choosePlaceableRow(await loadCandidateRows());
  if (sameBayRow) return mapHostRegistryRow(sameBayRow);

  const sharedPoolRow = await choosePlaceableRow(
    await loadCandidateRows({ anyBay: true, sharedPoolOnly: true }),
  );
  if (sharedPoolRow) return mapHostRegistryRow(sharedPoolRow);

  const remoteSharedPoolRow = await choosePlaceableRow(
    await loadRemoteSharedPoolCandidateRows(),
  );
  if (!remoteSharedPoolRow) return undefined;
  return mapHostRegistryRow(remoteSharedPoolRow);
}

export async function savePlacement(
  project_id: string,
  placement: HostPlacement,
) {
  const defaultBayId = getConfiguredBayId();
  if (!(await hostExistsAnywhere(placement.host_id))) {
    throw Error(`host ${placement.host_id} not found`);
  }
  const client = await pool().connect();
  let rows: { owning_bay_id: string }[] = [];
  try {
    await client.query("BEGIN");
    ({ rows } = await client.query<{
      owning_bay_id: string;
    }>(
      `
        UPDATE projects AS projects
        SET host_id = $1
        WHERE projects.project_id = $2
        RETURNING
          COALESCE(projects.owning_bay_id, $3) AS owning_bay_id
      `,
      [placement.host_id, project_id, defaultBayId],
    ));
    if (!rows[0]) {
      throw Error(`project ${project_id} not found`);
    }
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.host_changed",
      project_id,
      default_bay_id: defaultBayId,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (rows[0]) {
    await publishProjectAccountFeedEventsBestEffort({
      project_id,
      default_bay_id: defaultBayId,
    });
  }
  await notifyProjectHostUpdate({
    project_id,
    host_id: placement.host_id,
  });
}

export async function ensurePlacement(
  project_id: string,
  account_id?: string,
): Promise<HostPlacement> {
  const meta = await loadProject(project_id);
  const projectBayId = effectiveBayId(meta.owning_bay_id);
  const projectRegion = parseR2Region(meta.region) ?? undefined;
  if (meta.host_id) {
    const hostInfo = await loadHostFromRegistry(meta.host_id);
    if (!hostInfo) {
      // Project is already placed. In multi-bay mode the assigned host may be
      // registered on another bay, so only reject if it cannot be resolved at all.
      if (await hostExistsAnywhere(meta.host_id)) {
        await registerProjectOnHost({
          project_id,
          host_id: meta.host_id,
          meta,
          account_id,
        });
        return { host_id: meta.host_id };
      }
      throw Error(
        `project is assigned to host ${meta.host_id} but it is unavailable`,
      );
    }
    await registerProjectOnHost({
      project_id,
      host_id: meta.host_id,
      meta,
      account_id,
    });
    return { host_id: meta.host_id };
  }

  const chosen = await selectActiveHost({
    bay_id: projectBayId,
    project_region: projectRegion,
    account_id,
  });
  if (!chosen) {
    if (projectRegion) {
      throw Error(
        `no running project-host available in bay ${projectBayId} for region ${projectRegion}`,
      );
    }
    throw Error(`no running project-host available in bay ${projectBayId}`);
  }

  await registerProjectOnHost({
    project_id,
    host_id: chosen.id,
    meta,
    account_id,
  });

  const placement: HostPlacement = { host_id: chosen.id };

  await savePlacement(project_id, placement);
  return placement;
}

async function registerProjectOnHost({
  project_id,
  host_id,
  meta,
  account_id,
}: {
  project_id: string;
  host_id: string;
  meta: ProjectMeta;
  account_id?: string;
}): Promise<void> {
  const client = await getRoutedHostControlClient({
    host_id,
    account_id,
    timeout: START_PROJECT_TIMEOUT_MS,
  });

  log.debug("createProject on project host", {
    project_id,
    host_id,
    already_assigned: meta.host_id === host_id,
  });

  const run_quota = await applyHostGpuToRunQuota(meta.run_quota, host_id);

  await client.createProject({
    project_id,
    title: meta.title,
    users: meta.users,
    image: meta.image,
    ensure_volume: false,
    // Register or refresh the project metadata on the chosen host first, then
    // persist placement before any long-running runtime start. This call is
    // idempotent and repairs old half-placed projects whose hub row has a
    // host_id but whose assigned host lacks the local project row needed for
    // data-plane authorization.
    start: false,
    authorized_keys: meta.authorized_keys,
    run_quota,
  });
}

export async function startProjectOnHost(
  project_id: string,
  opts?: {
    lro_op_id?: string;
    account_id?: string;
    managed_egress_override?: ManagedProjectEgressOverride;
    restore_backup_id?: string;
    ignore_recent_state_snapshot?: boolean;
  },
): Promise<void> {
  const existing = startProjectInFlight.get(project_id);
  if (existing) {
    const requestedOpId = `${opts?.lro_op_id ?? ""}`.trim();
    const existingOpId = `${existing.op_id ?? ""}`.trim();
    let reuseExisting = true;
    if (requestedOpId && existingOpId && requestedOpId !== existingOpId) {
      const existingLro = await getLro(existingOpId).catch((err) => {
        log.warn("startProjectOnHost unable to inspect in-flight lro", {
          project_id,
          existing_op_id: existingOpId,
          requested_op_id: requestedOpId,
          err: `${err}`,
        });
        return undefined;
      });
      if (
        existingLro == null ||
        TERMINAL_START_LRO_STATUSES.has(`${existingLro.status ?? ""}`)
      ) {
        log.warn(
          "startProjectOnHost replacing stale in-memory start for terminal lro",
          {
            project_id,
            existing_op_id: existingOpId,
            existing_status: existingLro?.status ?? "missing",
            requested_op_id: requestedOpId,
          },
        );
        startProjectInFlight.delete(project_id);
        reuseExisting = false;
      }
    }
    if (reuseExisting) {
      await existing.promise;
      return;
    }
  }
  const task = (async () => {
    await cancelStaleProjectStartLros({ project_id });
    const snapshot = await getProjectStateSnapshot(project_id);
    const activeStartLro =
      snapshot.state === "starting"
        ? await hasActiveProjectStartLro(project_id)
        : false;
    const startDecision = shouldSkipStartForSnapshot({
      state: snapshot.state,
      timeMs: snapshot.timeMs,
      hasActiveStartLro: activeStartLro,
      ignoreRecentState: opts?.ignore_recent_state_snapshot === true,
    });
    if (startDecision.skip) {
      log.debug("startProjectOnHost skipping duplicate start", {
        project_id,
        state: snapshot.state,
        state_time: snapshot.timeMs,
        reason: startDecision.reason,
      });
      return;
    }
    if (snapshot.state === "starting") {
      log.warn("startProjectOnHost recovering stale starting state", {
        project_id,
        state_time: snapshot.timeMs,
      });
    }
    if (snapshot.state === "running") {
      log.debug(
        "startProjectOnHost proceeding despite stale running state snapshot",
        {
          project_id,
          state_time: snapshot.timeMs,
        },
      );
    }

    const placement = await ensurePlacement(project_id, opts?.account_id);
    const explicitRestoreBackupId = `${opts?.restore_backup_id ?? ""}`.trim();
    const client = await getRoutedHostControlClient({
      host_id: placement.host_id,
      timeout: START_PROJECT_TIMEOUT_MS,
    });
    try {
      if (typeof client.getProjectStatus === "function") {
        const live = await client.getProjectStatus({ project_id });
        if (
          explicitRestoreBackupId &&
          (live?.state === "running" || live?.state === "starting")
        ) {
          log.warn(
            "startProjectOnHost ignoring active destination state because an explicit restore backup was requested",
            {
              project_id,
              host_id: placement.host_id,
              snapshot_state: snapshot.state,
              live_state: live.state,
              restore_backup_id: explicitRestoreBackupId,
            },
          );
        } else if (live?.state === "running" || live?.state === "starting") {
          log.warn(
            "startProjectOnHost found project already active on assigned host; skipping restart",
            {
              project_id,
              host_id: placement.host_id,
              snapshot_state: snapshot.state,
              live_state: live.state,
            },
          );
          await saveProjectStateSnapshot(project_id, live.state);
          return;
        }
      }
    } catch (err) {
      log.debug("startProjectOnHost live status probe failed", {
        project_id,
        host_id: placement.host_id,
        err: `${err}`,
      });
    }
    let cpuPolicyBlockMessage: string | undefined;
    try {
      if (
        await countsTowardManagedCpuBudgetForHost({
          host_id: placement.host_id,
          project_id,
        })
      ) {
        const policy = await getManagedProjectCpuPolicy({ project_id });
        if (!policy.allowed) {
          cpuPolicyBlockMessage =
            formatManagedProjectCpuPolicyBlockMessage(policy);
        }
      }
    } catch (err) {
      log.warn("startProjectOnHost unable to evaluate CPU start policy", {
        project_id,
        err: `${err}`,
      });
    }
    if (cpuPolicyBlockMessage) {
      throw new Error(cpuPolicyBlockMessage);
    }
    const meta = await loadProject(project_id);
    const run_quota = await applyHostGpuToRunQuota(
      meta.run_quota,
      placement.host_id,
    );
    const { rows } = await pool().query<{
      backup_repo_id: string | null;
      provisioned: boolean | null;
    }>("SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1", [
      project_id,
    ]);
    if (rows[0]?.backup_repo_id && rows[0]?.provisioned === false) {
      await assertCanRestoreProvisionedProjectStorage({ project_id });
    }
    const restore = rows[0]?.backup_repo_id ? "auto" : "none";
    try {
      const response = await client.startProject({
        project_id,
        authorized_keys: meta.authorized_keys,
        run_quota,
        image: meta.image,
        restore,
        restore_backup_id: explicitRestoreBackupId || undefined,
        lro_op_id: opts?.lro_op_id,
        ...(opts?.managed_egress_override
          ? { managed_egress_override: opts.managed_egress_override }
          : {}),
      });
      await saveProjectStateSnapshot(project_id, response.state ?? "running");
      if (opts?.lro_op_id && response.phase_timings_ms) {
        mergeStartProjectTimings(opts.lro_op_id, response.phase_timings_ms);
      }
    } catch (err) {
      const autoGrow = await maybeAutoGrowHostDiskForReservationFailure({
        host_id: placement.host_id,
        err,
      });
      if (autoGrow.grown) {
        log.info("retrying project start after guarded auto-grow", {
          project_id,
          host_id: placement.host_id,
          next_disk_gb: autoGrow.next_disk_gb,
        });
        const retry = await client.startProject({
          project_id,
          authorized_keys: meta.authorized_keys,
          run_quota,
          image: meta.image,
          restore,
          restore_backup_id: explicitRestoreBackupId || undefined,
          lro_op_id: opts?.lro_op_id,
          ...(opts?.managed_egress_override
            ? { managed_egress_override: opts.managed_egress_override }
            : {}),
        });
        await saveProjectStateSnapshot(project_id, retry.state ?? "running");
        if (opts?.lro_op_id && retry.phase_timings_ms) {
          mergeStartProjectTimings(opts.lro_op_id, retry.phase_timings_ms);
        }
        return;
      }
      log.warn("startProjectOnHost failed", {
        project_id,
        host: placement,
        err,
        auto_grow_reason: autoGrow.reason,
      });
      throw err;
    }
  })();
  const inFlight: StartProjectInFlight = {
    op_id: opts?.lro_op_id,
    promise: task,
  };
  startProjectInFlight.set(project_id, inFlight);
  try {
    await task;
  } finally {
    if (startProjectInFlight.get(project_id) === inFlight) {
      startProjectInFlight.delete(project_id);
    }
  }
}

export function takeStartProjectPhaseTimings(
  op_id?: string,
): Record<string, number> | undefined {
  return takeStartProjectTimings(op_id);
}

export async function stopProjectOnHost(
  project_id: string,
  opts?: { timeout_ms?: number },
): Promise<void> {
  const { host_id, client } = await getAssignedProjectHostControlClient({
    project_id,
    timeout: opts?.timeout_ms ?? STOP_PROJECT_TIMEOUT_MS,
  });
  let wasRunning = false;
  try {
    const { rows } = await pool().query<{ state: { state?: string } | null }>(
      "SELECT state FROM projects WHERE project_id=$1",
      [project_id],
    );
    const rawState = rows[0]?.state ?? null;
    const parsedState =
      typeof rawState === "string" ? JSON.parse(rawState) : rawState;
    const stateValue = parsedState?.state;
    wasRunning = stateValue === "running" || stateValue === "starting";
  } catch (err) {
    log.debug("stopProjectOnHost unable to read project state", {
      project_id,
      err: `${err}`,
    });
  }
  try {
    const response = await client.stopProject({ project_id });
    await saveProjectStateSnapshot(project_id, response.state ?? "opened");
    if (wasRunning) {
      await pool().query(
        "UPDATE projects SET last_edited=NOW() WHERE project_id=$1",
        [project_id],
      );
      await appendProjectOutboxEventForProject({
        event_type: "project.summary_changed",
        project_id,
        default_bay_id: getConfiguredBayId(),
      });
      await publishProjectAccountFeedEventsBestEffort({
        project_id,
        default_bay_id: getConfiguredBayId(),
      });
    }
  } catch (err) {
    log.warn("stopProjectOnHost failed", { project_id, host_id, err });
    throw err;
  }
}

export async function updateAuthorizedKeysOnHost(
  project_id: string,
): Promise<void> {
  const meta = await loadProject(project_id);
  let assigned: Awaited<ReturnType<typeof getAssignedProjectHostControlClient>>;
  try {
    assigned = await getAssignedProjectHostControlClient({
      project_id,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === PROJECT_HAS_NO_ASSIGNED_HOST_ERROR
    ) {
      return;
    }
    throw err;
  }
  const { host_id, client } = assigned;
  try {
    await client.updateAuthorizedKeys({
      project_id,
      authorized_keys: meta.authorized_keys,
    });
  } catch (err) {
    log.warn("updateAuthorizedKeysOnHost failed", { project_id, host_id, err });
  }
}

export async function syncProjectUsersOnHost({
  project_id,
  expected_host_id,
}: {
  project_id: string;
  expected_host_id?: string;
}): Promise<void> {
  const meta = await loadProject(project_id);
  let assigned: Awaited<ReturnType<typeof getAssignedProjectHostControlClient>>;
  try {
    assigned = await getAssignedProjectHostControlClient({
      project_id,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === PROJECT_HAS_NO_ASSIGNED_HOST_ERROR
    ) {
      return;
    }
    throw err;
  }
  const { host_id, client } = assigned;
  if (expected_host_id && expected_host_id !== host_id) {
    throw Error(
      `project ${project_id} is assigned to host ${host_id}, not ${expected_host_id}`,
    );
  }
  try {
    await client.updateProjectUsers({
      project_id,
      users: meta.users ?? {},
    });
  } catch (err) {
    log.warn("syncProjectUsersOnHost failed", {
      project_id,
      host_id,
      err,
    });
    throw err;
  }
}

export async function deleteProjectDataOnHost({
  project_id,
  host_id,
}: {
  project_id: string;
  host_id: string;
}): Promise<void> {
  const client = await getRoutedHostControlClient({
    host_id,
  });
  await client.deleteProjectData({ project_id });
}
