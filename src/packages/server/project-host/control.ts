import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type { HostControlApi } from "@cocalc/conat/project-host/api";
import sshKeys from "../projects/get-ssh-keys";
import { notifyProjectHostUpdate } from "../conat/route-project";
import { getConfiguredBayId } from "../bay-config";
import { normalizeHostTier } from "./placement";
import { machineHasGpu } from "../cloud/host-gpu";
import { maybeAutoGrowHostDiskForReservationFailure } from "./auto-grow";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import {
  getAssignedProjectHostInfo,
  PROJECT_HAS_NO_ASSIGNED_HOST_ERROR,
} from "@cocalc/server/conat/project-host-assignment";
import { getRoutedHostControlClient } from "./client";

const log = getLogger("server:project-host:control");
// Project starts can include large restores, so allow a long RPC timeout.
const START_PROJECT_TIMEOUT_MS = 60 * 60 * 1000;
const STOP_PROJECT_TIMEOUT_MS = 30 * 1000;
const RECENT_RUNNING_STATE_MS = 60 * 1000;
const RECENT_STARTING_STATE_MS = 5 * 60 * 1000;
const startProjectInFlight = new Map<string, Promise<void>>();
const startProjectPhaseTimings = new Map<string, Record<string, number>>();

type HostPlacement = {
  host_id: string;
};

export type ProjectMeta = {
  title?: string;
  users?: any;
  image?: string;
  host_id?: string;
  owning_bay_id?: string;
  authorized_keys?: string;
  run_quota?: any;
};

const pool = () => getPool();

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
  nowMs = Date.now(),
}: {
  state?: string;
  timeMs?: number;
  hasActiveStartLro: boolean;
  nowMs?: number;
}): { skip: boolean; reason?: string } {
  if (state === "starting") {
    if (hasActiveStartLro) {
      return { skip: true, reason: "active-start-lro" };
    }
    const isRecent =
      timeMs != null && nowMs - timeMs <= RECENT_STARTING_STATE_MS;
    if (isRecent) {
      return { skip: true, reason: "recent-starting-state" };
    }
    return { skip: false };
  }
  if (state === "running") {
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
    "SELECT title, users, rootfs_image as image, host_id, owning_bay_id, run_quota FROM projects WHERE project_id=$1",
    [project_id],
  );
  if (!rows[0]) throw Error(`project ${project_id} not found`);
  const keys = await sshKeys(project_id);
  const authorized_keys = Object.values(keys)
    .map((k: any) => k.value)
    .join("\n");
  return { ...rows[0], authorized_keys };
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
  const row = rows[0];
  const machine = row?.metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  const tier = normalizeHostTier(row.tier);
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
  };
}

export async function selectActiveHost({
  exclude_host_id,
  bay_id,
}: {
  exclude_host_id?: string;
  bay_id?: string;
} = {}) {
  const params: any[] = [];
  const where: string[] = [
    "status='running'",
    "deleted IS NULL",
    "last_seen > NOW() - interval '2 minutes'",
  ];
  if (exclude_host_id) {
    params.push(exclude_host_id);
    where.push(`id != $${params.length}`);
  }
  const targetBayId = effectiveBayId(bay_id);
  params.push(targetBayId);
  where.push(`COALESCE(bay_id, $${params.length}) = $${params.length}`);
  const { rows } = await pool().query(
    `
      SELECT id, bay_id, name, region, public_url, internal_url, ssh_server, tier, metadata
      FROM project_hosts
      WHERE ${where.join("\n        AND ")}
      ORDER BY random()
      LIMIT 1
    `,
    params,
  );
  if (!rows[0]) return undefined;
  const row = rows[0];
  const machine = row?.metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  const tier = normalizeHostTier(row.tier);
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
  };
}

export async function savePlacement(
  project_id: string,
  placement: HostPlacement,
) {
  const defaultBayId = getConfiguredBayId();
  const client = await pool().connect();
  let rows: { owning_bay_id: string; host_bay_id: string }[] = [];
  try {
    await client.query("BEGIN");
    ({ rows } = await client.query<{
      owning_bay_id: string;
      host_bay_id: string;
    }>(
      `
        UPDATE projects AS projects
        SET host_id = $1
        FROM project_hosts AS project_hosts
        WHERE projects.project_id = $2
          AND project_hosts.id = $1
          AND project_hosts.deleted IS NULL
          AND COALESCE(projects.owning_bay_id, $3) = COALESCE(project_hosts.bay_id, $3)
        RETURNING
          COALESCE(projects.owning_bay_id, $3) AS owning_bay_id,
          COALESCE(project_hosts.bay_id, $3) AS host_bay_id
      `,
      [placement.host_id, project_id, defaultBayId],
    ));
    if (rows[0]) {
      await appendProjectOutboxEventForProject({
        db: client,
        event_type: "project.host_changed",
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
  if (rows[0]) {
    await publishProjectAccountFeedEventsBestEffort({
      project_id,
      default_bay_id: defaultBayId,
    });
  }
  if (!rows[0]) {
    const [{ rows: projectRows }, { rows: hostRows }] = await Promise.all([
      pool().query<{ owning_bay_id: string }>(
        "SELECT COALESCE(owning_bay_id, $2) AS owning_bay_id FROM projects WHERE project_id=$1",
        [project_id, defaultBayId],
      ),
      pool().query<{ bay_id: string }>(
        "SELECT COALESCE(bay_id, $2) AS bay_id FROM project_hosts WHERE id=$1 AND deleted IS NULL",
        [placement.host_id, defaultBayId],
      ),
    ]);
    if (!projectRows[0]) {
      throw Error(`project ${project_id} not found`);
    }
    if (!hostRows[0]) {
      throw Error(`host ${placement.host_id} not found`);
    }
    throw Error(
      `project ${project_id} belongs to bay ${projectRows[0].owning_bay_id} but host ${placement.host_id} belongs to bay ${hostRows[0].bay_id}`,
    );
  }
  await notifyProjectHostUpdate({
    project_id,
    host_id: placement.host_id,
  });
}

async function ensurePlacement(project_id: string): Promise<HostPlacement> {
  const meta = await loadProject(project_id);
  const projectBayId = effectiveBayId(meta.owning_bay_id);
  if (meta.host_id) {
    const hostInfo = await loadHostFromRegistry(meta.host_id);
    if (!hostInfo) {
      // Project is already placed, but the host is missing/unregistered.
      // Never auto-reassign here to avoid split-brain/data loss; require an explicit move.
      throw Error(
        `project is assigned to host ${meta.host_id} but it is unavailable`,
      );
    }
    if (hostInfo.bay_id !== projectBayId) {
      throw Error(
        `project ${project_id} belongs to bay ${projectBayId} but host ${meta.host_id} belongs to bay ${hostInfo.bay_id}`,
      );
    }
    return { host_id: meta.host_id };
  }

  const chosen = await selectActiveHost({ bay_id: projectBayId });
  if (!chosen) {
    throw Error(`no running project-host available in bay ${projectBayId}`);
  }

  const client = await getRoutedHostControlClient({
    host_id: chosen.id,
  });

  log.debug("createProject on remote project host", {
    project_id,
    meta,
    host_id: chosen.id,
  });

  const run_quota = await applyHostGpuToRunQuota(meta.run_quota, chosen.id);

  await client.createProject({
    project_id,
    title: meta.title,
    users: meta.users,
    image: meta.image,
    // Register the project on the chosen host first, then persist placement
    // before doing any long-running runtime start. Large OCI image pulls can
    // take minutes, and they must happen on the explicit startProject RPC with
    // its long timeout so we never lose host placement on a createProject
    // timeout.
    start: false,
    authorized_keys: meta.authorized_keys,
    run_quota,
  });

  const placement: HostPlacement = { host_id: chosen.id };

  await savePlacement(project_id, placement);
  return placement;
}

export async function startProjectOnHost(
  project_id: string,
  opts?: { lro_op_id?: string },
): Promise<void> {
  const existing = startProjectInFlight.get(project_id);
  if (existing) {
    await existing;
    return;
  }
  const task = (async () => {
    const snapshot = await getProjectStateSnapshot(project_id);
    const activeStartLro =
      snapshot.state === "starting"
        ? await hasActiveProjectStartLro(project_id)
        : false;
    const startDecision = shouldSkipStartForSnapshot({
      state: snapshot.state,
      timeMs: snapshot.timeMs,
      hasActiveStartLro: activeStartLro,
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

    const placement = await ensurePlacement(project_id);
    const meta = await loadProject(project_id);
    const run_quota = await applyHostGpuToRunQuota(
      meta.run_quota,
      placement.host_id,
    );
    const { rows } = await pool().query<{
      backup_repo_id: string | null;
    }>("SELECT backup_repo_id FROM projects WHERE project_id=$1", [project_id]);
    const restore = rows[0]?.backup_repo_id ? "auto" : "none";
    const client = await getRoutedHostControlClient({
      host_id: placement.host_id,
      timeout: START_PROJECT_TIMEOUT_MS,
    });
    try {
      const response = await client.startProject({
        project_id,
        authorized_keys: meta.authorized_keys,
        run_quota,
        image: meta.image,
        restore,
        lro_op_id: opts?.lro_op_id,
      });
      if (opts?.lro_op_id && response.phase_timings_ms) {
        startProjectPhaseTimings.set(opts.lro_op_id, response.phase_timings_ms);
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
          lro_op_id: opts?.lro_op_id,
        });
        if (opts?.lro_op_id && retry.phase_timings_ms) {
          startProjectPhaseTimings.set(opts.lro_op_id, retry.phase_timings_ms);
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
  startProjectInFlight.set(project_id, task);
  try {
    await task;
  } finally {
    if (startProjectInFlight.get(project_id) === task) {
      startProjectInFlight.delete(project_id);
    }
  }
}

export function takeStartProjectPhaseTimings(
  op_id?: string,
): Record<string, number> | undefined {
  const key = `${op_id ?? ""}`.trim();
  if (!key) return;
  const timings = startProjectPhaseTimings.get(key);
  startProjectPhaseTimings.delete(key);
  return timings;
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
    await client.stopProject({ project_id });
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
