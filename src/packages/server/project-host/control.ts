import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type { Host, HostPressureZone } from "@cocalc/conat/hub/api/hosts";
import type { ManagedProjectEgressOverride } from "@cocalc/conat/files/file-server";
import type {
  HostControlApi,
  HostProjectStartMetadata,
} from "@cocalc/conat/project-host/api";
import sshKeys from "../projects/get-ssh-keys";
import { notifyProjectHostUpdate } from "../conat/route-project";
import { getConfiguredBayId } from "../bay-config";
import {
  computePlacementPermission,
  getUserHostTier,
  hostIoPlacementConformant,
  normalizeHostTier,
} from "./placement";
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
import {
  mapCloudRegionToR2Region,
  parseR2Region,
  rankR2RegionDistance,
} from "@cocalc/util/consts";
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
import { applyHostRuntimePolicyToRunQuota } from "./run-quota";
import { reconcileProjectAppPrivateHostnamesForProject } from "@cocalc/server/app-private-hostnames";
import { getProjectSecretsRuntimeCache } from "@cocalc/server/projects/project-secrets";
import type { ProjectEnv } from "@cocalc/conat/hub/api/projects";
import type { ProjectSecretsRuntimeCache } from "@cocalc/util/project-secrets";
import { normalizeRootfsImageName } from "@cocalc/util/rootfs-images";

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
  host_session_id?: string;
  promise: Promise<void>;
};
const startProjectInFlight = new Map<string, StartProjectInFlight>();

export function immediateStartReplacementReason({
  existing_op_id,
  requested_op_id,
  existing_host_session_id,
  requested_host_session_id,
}: {
  existing_op_id?: string;
  requested_op_id?: string;
  existing_host_session_id?: string;
  requested_host_session_id?: string;
}): "untracked-start" | "host-session-changed" | undefined {
  const existingOpId = `${existing_op_id ?? ""}`.trim();
  const requestedOpId = `${requested_op_id ?? ""}`.trim();
  if (requestedOpId && !existingOpId) {
    return "untracked-start";
  }
  const existingHostSessionId = `${existing_host_session_id ?? ""}`.trim();
  const requestedHostSessionId = `${requested_host_session_id ?? ""}`.trim();
  if (
    requestedHostSessionId &&
    existingHostSessionId &&
    requestedHostSessionId !== existingHostSessionId
  ) {
    return "host-session-changed";
  }
  return undefined;
}

async function projectNeedsPendingCopyCheck(
  project_id: string,
): Promise<boolean> {
  try {
    const { rows } = await pool().query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM project_copies
          WHERE dest_project_id=$1
            AND status IN ('queued', 'applying')
            AND expires_at > now()
        ) AS exists
      `,
      [project_id],
    );
    return rows[0]?.exists !== false;
  } catch (err) {
    // Mixed-schema or temporarily unavailable copy state must retain the
    // conservative host-side claim. This optimization may fail open only for
    // latency, never for copy correctness.
    log.warn("unable to establish pending-copy warm-start fast path", {
      project_id,
      err: `${err}`,
    });
    return true;
  }
}

function isIdempotentStartUnavailable(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  const namesMethod =
    text.includes("startprojectidempotent") ||
    text.includes("start-project-idempotent");
  return (
    namesMethod &&
    (text.includes("no subscribers matching") ||
      text.includes("unknown method") ||
      text.includes("method not found") ||
      text.includes("not implemented") ||
      text.includes("not available"))
  );
}

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
      host_cpu_count: host.host_cpu_count,
      machine: host.machine,
      pressure: host.pressure,
      metrics: host.metrics,
      placement: host.placement,
      billing: {
        enforcement: host.billing_enforcement,
      },
      public_route_probe: host.public_route_probe,
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
  run_quota_revision?: number;
  env?: ProjectEnv;
  autostart_enabled?: boolean | null;
  project_secrets_cache?: ProjectSecretsRuntimeCache;
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

function hostPlacementQuarantined(row: HostRegistryRow): boolean {
  return (
    row.metadata?.runtime_synthetic_probe?.quarantined === true ||
    row.metadata?.public_route_probe?.quarantined === true
  );
}

export function hostPlacementPressureRank(
  zone: HostPressureZone | undefined,
): number {
  if (!zone) return HOST_PLACEMENT_PRESSURE_RANK.normal;
  return (
    HOST_PLACEMENT_PRESSURE_RANK[zone] ?? HOST_PLACEMENT_PRESSURE_RANK.normal
  );
}

function placementRootfsCachePenalty(
  row: HostRegistryRow,
  requestedRootfsImage?: string,
): number {
  const requested = normalizeRootfsImageName(requestedRootfsImage);
  if (!requested) return 0;
  const snapshot = row.metadata?.placement;
  const observedAt = Date.parse(`${snapshot?.observed_at ?? ""}`);
  const fresh =
    Number.isFinite(observedAt) && Date.now() - observedAt <= 3 * 60_000;
  if (!fresh || !Array.isArray(snapshot?.cached_rootfs_images)) {
    return 25;
  }
  const cached = snapshot.cached_rootfs_images.some(
    (image: unknown) =>
      normalizeRootfsImageName(`${image ?? ""}`) === requested,
  );
  if (cached) return 0;
  return snapshot.rootfs_cache_truncated === true ? 25 : 50;
}

function hostPlacementLoadPenalty(row: HostRegistryRow): number {
  const metrics = row.metadata?.metrics?.current ?? {};
  const starting = Math.max(
    0,
    Math.min(20, Math.floor(Number(metrics.starting_project_count) || 0)),
  );
  const cpuCount = Math.max(
    1,
    Math.floor(Number(row.metadata?.host_cpu_count) || 1),
  );
  const loadRatio = Math.max(
    0,
    Math.min(10, (Number(metrics.load_1) || 0) / cpuCount),
  );
  const memoryUsedPercent = Math.max(
    0,
    Math.min(100, Number(metrics.memory_used_percent) || 0),
  );
  const memoryPenalty = Math.max(0, memoryUsedPercent - 70);
  return starting * 20 + Math.round(loadRatio * 10) + memoryPenalty;
}

export function hostPlacementScore(
  row: HostRegistryRow,
  requestedRootfsImage?: string,
): number {
  return (
    hostPlacementPressureRank(
      normalizeHostPressureZone(row.metadata?.pressure?.zone),
    ) *
      10_000 +
    placementRootfsCachePenalty(row, requestedRootfsImage) +
    hostPlacementLoadPenalty(row)
  );
}

export function choosePlacementHostRow<T extends HostRegistryRow>(
  rows: T[],
  random: () => number = Math.random,
  project_region?: string,
  requested_rootfs_image?: string,
): T | undefined {
  const eligibleRows = rows.filter(
    (row) =>
      !hostPlacementQuarantined(row) &&
      hostIoPlacementConformant(row) &&
      (project_region == null ||
        mapCloudRegionToR2Region(row.region ?? "") === project_region),
  );
  if (eligibleRows.length === 0) return;
  let bestScore = Number.POSITIVE_INFINITY;
  const rankedRows: Array<{ row: T; score: number }> = [];
  for (const row of eligibleRows) {
    const score = hostPlacementScore(row, requested_rootfs_image);
    rankedRows.push({ row, score });
    if (score < bestScore) {
      bestScore = score;
    }
  }
  // Keep a little randomness among effectively equivalent hosts so a burst of
  // first projects does not stampede the single best heartbeat snapshot.
  const bestRows = rankedRows
    .filter(({ score }) => score <= bestScore + 5)
    .map(({ row }) => row);
  if (bestRows.length === 0) return;
  const index = Math.min(
    bestRows.length - 1,
    Math.max(0, Math.floor(random() * bestRows.length)),
  );
  return bestRows[index];
}

function chooseNearestRegionHostRow<T extends HostRegistryRow>(
  rows: T[],
  projectRegion: string,
  random: () => number = Math.random,
  requestedRootfsImage?: string,
): T | undefined {
  const parsedProjectRegion = parseR2Region(projectRegion);
  if (!parsedProjectRegion) {
    return choosePlacementHostRow(
      rows,
      random,
      undefined,
      requestedRootfsImage,
    );
  }
  let nearestRank = Number.POSITIVE_INFINITY;
  const nearestRows: T[] = [];
  for (const row of rows) {
    const rank = rankR2RegionDistance(
      parsedProjectRegion,
      mapCloudRegionToR2Region(row.region),
    );
    if (rank < nearestRank) {
      nearestRank = rank;
      nearestRows.length = 0;
      nearestRows.push(row);
    } else if (rank === nearestRank) {
      nearestRows.push(row);
    }
  }
  return choosePlacementHostRow(
    nearestRows,
    random,
    undefined,
    requestedRootfsImage,
  );
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
  opts?: {
    runtime_started?: boolean;
    project_bundle_version?: string | null;
    tools_version?: string | null;
  },
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
  const projectBundleVersion = `${opts?.project_bundle_version ?? ""}`.trim();
  if (projectBundleVersion) {
    (stateObj as any).project_bundle_version = projectBundleVersion;
  }
  const toolsVersion = `${opts?.tools_version ?? ""}`.trim();
  if (toolsVersion) {
    (stateObj as any).tools_version = toolsVersion;
  }
  const runtimeStarted =
    opts?.runtime_started === true && stateObj.state === "running";
  const startedAt = runtimeStarted
    ? new Date(stateObj.time).toISOString()
    : undefined;
  const defaultBayId = getConfiguredBayId();
  const client = await pool().connect();
  let changed = false;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE projects
          SET state=$2::jsonb || CASE
            WHEN $3::boolean THEN jsonb_build_object(
              'runtime_generation',
              CASE
                WHEN state->>'runtime_generation' ~ '^[0-9]+$'
                  THEN (state->>'runtime_generation')::bigint + 1
                ELSE 1
              END,
              'started_at',
              $4::text
            )
            ELSE jsonb_strip_nulls(jsonb_build_object(
              'runtime_generation',
              CASE
                WHEN state->>'runtime_generation' ~ '^[0-9]+$'
                  THEN (state->>'runtime_generation')::bigint
                ELSE NULL
              END,
              'started_at',
              state->>'started_at'
            ))
          END
        WHERE project_id=$1
          AND state IS DISTINCT FROM (
            $2::jsonb || CASE
              WHEN $3::boolean THEN jsonb_build_object(
                'runtime_generation',
                CASE
                  WHEN state->>'runtime_generation' ~ '^[0-9]+$'
                    THEN (state->>'runtime_generation')::bigint + 1
                  ELSE 1
                END,
                'started_at',
                $4::text
              )
              ELSE jsonb_strip_nulls(jsonb_build_object(
                'runtime_generation',
                CASE
                  WHEN state->>'runtime_generation' ~ '^[0-9]+$'
                    THEN (state->>'runtime_generation')::bigint
                  ELSE NULL
                END,
                'started_at',
                state->>'started_at'
              ))
            END
          )`,
      [project_id, stateObj, runtimeStarted, startedAt],
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

export async function loadProject(
  project_id: string,
  { include_start_metadata = false }: { include_start_metadata?: boolean } = {},
): Promise<ProjectMeta> {
  const { rows } = await pool().query(
    "SELECT title, users, rootfs_image as image, host_id, region, owning_bay_id, run_quota FROM projects WHERE project_id=$1",
    [project_id],
  );
  if (!rows[0]) throw Error(`project ${project_id} not found`);
  let run_quota_revision = 0;
  try {
    const revision = await pool().query(
      "SELECT COALESCE(run_quota_revision, 0)::bigint AS run_quota_revision, env, autostart_enabled FROM projects WHERE project_id=$1",
      [project_id],
    );
    run_quota_revision = Number(revision.rows[0]?.run_quota_revision ?? 0);
    rows[0].env = revision.rows[0]?.env;
    rows[0].autostart_enabled = revision.rows[0]?.autostart_enabled;
  } catch (err) {
    // Compatibility with a control plane whose additive schema migration has
    // not run yet. Revision zero is accepted only until versioned state lands.
    log.debug("loadProject: quota revision unavailable", {
      project_id,
      err: `${err}`,
    });
  }
  const keys = await sshKeys(project_id);
  const authorized_keys = Object.values(keys)
    .map((k: any) => k.value)
    .join("\n");
  const image =
    `${rows[0].image ?? ""}`.trim() ||
    (await getCurrentProjectRootfsBinding({ project_id }))?.image ||
    DEFAULT_PROJECT_IMAGE;
  return {
    ...rows[0],
    image,
    authorized_keys,
    run_quota_revision,
    project_secrets_cache: include_start_metadata
      ? await getProjectSecretsRuntimeCache({ project_id })
      : undefined,
  };
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
  rootfs_image,
  allow_region_fallback = false,
}: {
  exclude_host_id?: string;
  bay_id?: string;
  project_region?: string;
  account_id?: string;
  rootfs_image?: string;
  allow_region_fallback?: boolean;
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
      "metadata #>> '{runtime_synthetic_probe,quarantined}' IS DISTINCT FROM 'true'",
      "metadata #>> '{public_route_probe,quarantined}' IS DISTINCT FROM 'true'",
      "(metadata #>> '{metrics,current,io_containment,policy_mode}' IS DISTINCT FROM 'enforce' OR (metadata #>> '{metrics,current,io_containment,capability}' = 'validated' AND COALESCE(metadata #>> '{metrics,current,io_containment,last_reconcile_error}', '') = ''))",
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
  const filterPlaceableRows = async (rows: HostRegistryRow[]) => {
    return await filterRowsPlaceableByAccount({
      rows,
      account_id,
    });
  };
  const choosePlaceableRow = async (rows: HostRegistryRow[]) => {
    const placeableRows = await filterRowsPlaceableByAccount({
      rows,
      account_id,
    });
    return choosePlacementHostRow(
      placeableRows,
      Math.random,
      project_region,
      rootfs_image,
    );
  };

  const sameBayRows = await loadCandidateRows();
  const sameBayRow = await choosePlaceableRow(sameBayRows);
  if (sameBayRow) return mapHostRegistryRow(sameBayRow);

  const sharedPoolRows = await loadCandidateRows({
    anyBay: true,
    sharedPoolOnly: true,
  });
  const sharedPoolRow = await choosePlaceableRow(sharedPoolRows);
  if (sharedPoolRow) return mapHostRegistryRow(sharedPoolRow);

  const remoteSharedPoolRows = await loadRemoteSharedPoolCandidateRows();
  const remoteSharedPoolRow = await choosePlaceableRow(remoteSharedPoolRows);
  if (remoteSharedPoolRow) return mapHostRegistryRow(remoteSharedPoolRow);
  if (!allow_region_fallback || !project_region) return undefined;

  const fallbackRowsById = new Map<string, HostRegistryRow>();
  for (const row of [
    ...sameBayRows,
    ...sharedPoolRows,
    ...remoteSharedPoolRows,
  ]) {
    fallbackRowsById.set(row.id, row);
  }
  const fallbackRows = await filterPlaceableRows([
    ...fallbackRowsById.values(),
  ]);
  const fallbackRow = chooseNearestRegionHostRow(
    fallbackRows,
    project_region,
    Math.random,
    rootfs_image,
  );
  return fallbackRow ? mapHostRegistryRow(fallbackRow) : undefined;
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
        SET host_id = $1,
            provisioned = CASE
              WHEN projects.host_id IS DISTINCT FROM $1 THEN FALSE
              ELSE projects.provisioned
            END,
            provisioned_checked_at = CASE
              WHEN projects.host_id IS DISTINCT FROM $1 THEN NOW()
              ELSE projects.provisioned_checked_at
            END
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
  try {
    const result = await reconcileProjectAppPrivateHostnamesForProject({
      project_id,
    });
    if (result.errors.length > 0) {
      log.warn("private app hostname placement reconcile incomplete", result);
    }
  } catch (err) {
    log.warn("private app hostname placement reconcile failed", {
      project_id,
      host_id: placement.host_id,
      err: `${err}`,
    });
  }
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
        return { host_id: meta.host_id };
      }
      throw Error(
        `project is assigned to host ${meta.host_id} but it is unavailable`,
      );
    }
    // startProject is the authoritative warm-path operation. The host resolves
    // missing metadata from the owning bay and upserts its local project row,
    // so an unconditional createProject RPC here only adds a network round trip.
    return { host_id: meta.host_id };
  }

  const chosen = await selectActiveHost({
    bay_id: projectBayId,
    project_region: projectRegion,
    account_id,
    rootfs_image: meta.image,
    allow_region_fallback: true,
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

  const run_quota = await applyHostRuntimePolicyToRunQuota(
    meta.run_quota,
    host_id,
  );

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
    run_quota_revision: Number(meta.run_quota_revision ?? 0),
  });
}

export async function startProjectOnHost(
  project_id: string,
  opts?: {
    lro_op_id?: string;
    host_session_id?: string;
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
    const requestedHostSessionId = `${opts?.host_session_id ?? ""}`.trim();
    const existingHostSessionId = `${existing.host_session_id ?? ""}`.trim();
    let reuseExisting = true;
    const immediateReplacement = immediateStartReplacementReason({
      existing_op_id: existingOpId,
      requested_op_id: requestedOpId,
      existing_host_session_id: existingHostSessionId,
      requested_host_session_id: requestedHostSessionId,
    });
    if (immediateReplacement === "untracked-start") {
      // Host-restart recovery intentionally has no LRO. A recovery RPC can
      // remain pending when the project-host process is replaced without a VM
      // reboot; never let that untracked promise block a user-visible start.
      log.warn("startProjectOnHost replacing untracked in-memory start", {
        project_id,
        requested_op_id: requestedOpId,
        existing_host_session_id: existingHostSessionId || undefined,
        requested_host_session_id: requestedHostSessionId || undefined,
      });
      startProjectInFlight.delete(project_id);
      reuseExisting = false;
    } else if (immediateReplacement === "host-session-changed") {
      log.warn(
        "startProjectOnHost replacing start from a previous host session",
        {
          project_id,
          existing_op_id: existingOpId || undefined,
          requested_op_id: requestedOpId || undefined,
          existing_host_session_id: existingHostSessionId,
          requested_host_session_id: requestedHostSessionId,
        },
      );
      startProjectInFlight.delete(project_id);
      reuseExisting = false;
    } else if (
      requestedOpId &&
      existingOpId &&
      requestedOpId !== existingOpId
    ) {
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
    const hostControlStarted = Date.now();
    const hostControlTimings: Record<string, number> = {};
    const markHostControl = (name: string, started: number) => {
      hostControlTimings[`host_control.${name}`] = Date.now() - started;
    };
    let phaseStarted = Date.now();
    await cancelStaleProjectStartLros({ project_id });
    markHostControl("cancel_stale_lros", phaseStarted);
    const explicitRestoreBackupId = `${opts?.restore_backup_id ?? ""}`.trim();
    phaseStarted = Date.now();
    const snapshot = await getProjectStateSnapshot(project_id);
    const activeStartLro =
      snapshot.state === "starting"
        ? await hasActiveProjectStartLro(project_id)
        : false;
    markHostControl("state_snapshot", phaseStarted);
    const startDecision = shouldSkipStartForSnapshot({
      state: snapshot.state,
      timeMs: snapshot.timeMs,
      hasActiveStartLro: activeStartLro,
      // An explicit restore is an atomic data replacement, not a duplicate
      // runtime start. A recent state snapshot may describe the previous host
      // after placement changed and must never suppress the restore.
      ignoreRecentState:
        !!explicitRestoreBackupId ||
        opts?.ignore_recent_state_snapshot === true,
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

    phaseStarted = Date.now();
    const placement = await ensurePlacement(project_id, opts?.account_id);
    const client = await getRoutedHostControlClient({
      host_id: placement.host_id,
      timeout: START_PROJECT_TIMEOUT_MS,
    });
    markHostControl("placement_and_client", phaseStarted);
    phaseStarted = Date.now();
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
    markHostControl("cpu_policy", phaseStarted);
    phaseStarted = Date.now();
    const meta = await loadProject(project_id, {
      include_start_metadata: true,
    });
    markHostControl("load_project", phaseStarted);
    phaseStarted = Date.now();
    const run_quota = await applyHostRuntimePolicyToRunQuota(
      meta.run_quota,
      placement.host_id,
    );
    markHostControl("runtime_policy", phaseStarted);
    phaseStarted = Date.now();
    const [projectStorage, applyPendingCopies] = await Promise.all([
      pool().query<{
        backup_repo_id: string | null;
        provisioned: boolean | null;
      }>(
        "SELECT backup_repo_id, provisioned FROM projects WHERE project_id=$1",
        [project_id],
      ),
      projectNeedsPendingCopyCheck(project_id),
    ]);
    const { rows } = projectStorage;
    if (rows[0]?.backup_repo_id && rows[0]?.provisioned === false) {
      await assertCanRestoreProvisionedProjectStorage({ project_id });
    }
    markHostControl("restore_metadata", phaseStarted);
    // A provisioned project already has authoritative local storage. Asking
    // the runner to auto-restore still performs a file-server round trip even
    // when there is nothing to restore, adding latency to every warm start.
    // Recover unprovisioned/unknown storage even if an incidental local cache
    // volume was created by file browsing before start. Unlike "required",
    // "recover" still permits a genuinely new project with no backups.
    const restore = explicitRestoreBackupId
      ? "auto"
      : rows[0]?.backup_repo_id && rows[0]?.provisioned !== true
        ? "recover"
        : "none";
    const startRequest: Parameters<HostControlApi["startProject"]>[0] = {
      project_id,
      authorized_keys: meta.authorized_keys,
      run_quota,
      run_quota_revision: Number(meta.run_quota_revision ?? 0),
      image: meta.image,
      restore,
      restore_backup_id: explicitRestoreBackupId || undefined,
      apply_pending_copies: applyPendingCopies,
      lro_op_id: opts?.lro_op_id,
      start_metadata: {
        title: meta.title,
        users: meta.users,
        image: meta.image,
        authorized_keys: meta.authorized_keys,
        run_quota,
        run_quota_revision: Number(meta.run_quota_revision ?? 0),
        env: meta.env,
        autostart_enabled: meta.autostart_enabled,
        project_secrets_cache: meta.project_secrets_cache,
      } satisfies HostProjectStartMetadata,
      ...(opts?.managed_egress_override
        ? { managed_egress_override: opts.managed_egress_override }
        : {}),
    };
    try {
      phaseStarted = Date.now();
      let response;
      if (typeof client.startProjectIdempotent === "function") {
        try {
          response = await client.startProjectIdempotent(startRequest);
        } catch (err) {
          if (!isIdempotentStartUnavailable(err)) {
            throw err;
          }
          markHostControl("idempotent_capability_fallback", phaseStarted);
        }
      }
      if (response == null) {
        const liveStatusStarted = Date.now();
        try {
          const live = await client.getProjectStatus({ project_id });
          if (
            !explicitRestoreBackupId &&
            (live?.state === "running" || live?.state === "starting")
          ) {
            markHostControl("live_status_probe", liveStatusStarted);
            await saveProjectStateSnapshot(project_id, live.state, {
              project_bundle_version: live.project_bundle_version,
              tools_version: live.tools_version,
            });
            return;
          }
        } catch (err) {
          log.debug("startProjectOnHost live status probe failed", {
            project_id,
            host_id: placement.host_id,
            err: `${err}`,
          });
        }
        markHostControl("live_status_probe", liveStatusStarted);
        phaseStarted = Date.now();
        response = await client.startProject(startRequest);
      }
      markHostControl("start_rpc", phaseStarted);
      const projectHostWallMs = Number(
        response.phase_timings_ms?.["project_host.wall_total"],
      );
      if (Number.isFinite(projectHostWallMs)) {
        hostControlTimings["host_control.start_rpc_transport"] = Math.max(
          0,
          hostControlTimings["host_control.start_rpc"] - projectHostWallMs,
        );
      }
      const saveRunningStateStarted = Date.now();
      await saveProjectStateSnapshot(project_id, response.state ?? "running", {
        runtime_started: true,
        project_bundle_version: response.project_bundle_version,
        tools_version: response.tools_version,
      });
      if (opts?.lro_op_id) {
        mergeStartProjectTimings(opts.lro_op_id, {
          ...response.phase_timings_ms,
          ...hostControlTimings,
          "control.save_authoritative_running_state":
            Date.now() - saveRunningStateStarted,
          "host_control.total": Date.now() - hostControlStarted,
        });
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
        const retry = await client.startProject(startRequest);
        const saveRunningStateStarted = Date.now();
        await saveProjectStateSnapshot(project_id, retry.state ?? "running", {
          runtime_started: true,
          project_bundle_version: retry.project_bundle_version,
          tools_version: retry.tools_version,
        });
        if (opts?.lro_op_id) {
          mergeStartProjectTimings(opts.lro_op_id, {
            ...retry.phase_timings_ms,
            "control.save_authoritative_running_state":
              Date.now() - saveRunningStateStarted,
          });
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
    host_session_id: opts?.host_session_id,
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

export async function updateProjectRunQuotaOnHost({
  project_id,
  run_quota,
  run_quota_revision,
}: {
  project_id: string;
  run_quota?: any;
  run_quota_revision?: number;
}): Promise<void> {
  const { host_id } = await getAssignedProjectHostInfo(project_id);
  const client = await getRoutedHostControlClient({
    host_id,
    timeout: 30_000,
  });
  await client.updateProjectRunQuota({
    project_id,
    run_quota: await applyHostRuntimePolicyToRunQuota(run_quota, host_id),
    run_quota_revision,
  });
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
  try {
    const response = await client.stopProject({ project_id });
    await saveProjectStateSnapshot(project_id, response.state ?? "opened");
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

export async function deleteProjectDataOnHostAfterBackup({
  project_id,
  host_id,
  expected_backup_id,
  expected_generation,
}: {
  project_id: string;
  host_id: string;
  expected_backup_id: string;
  expected_generation: number;
}): Promise<void> {
  const client = await getRoutedHostControlClient({ host_id });
  await client.deleteProjectDataAfterBackup({
    project_id,
    expected_backup_id,
    expected_generation,
  });
}

export async function releaseProjectDataArchiveFreezeOnHost({
  project_id,
  host_id,
  expected_generation,
}: {
  project_id: string;
  host_id: string;
  expected_generation: number;
}): Promise<{
  status: "absent" | "already-writable" | "released";
}> {
  const client = await getRoutedHostControlClient({ host_id });
  return await client.releaseProjectDataArchiveFreeze({
    project_id,
    expected_generation,
  });
}
