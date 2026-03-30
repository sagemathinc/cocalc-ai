import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { createHostControlClient } from "@cocalc/conat/project-host/api";
import sshKeys from "../projects/get-ssh-keys";
import { notifyProjectHostUpdate } from "../conat/route-project";
import { conatWithProjectRouting } from "../conat/route-client";
import { normalizeHostTier } from "./placement";
import { machineHasGpu } from "../cloud/host-gpu";

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
  authorized_keys?: string;
  run_quota?: any;
};

const pool = () => getPool();

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
    "SELECT title, users, rootfs_image as image, host_id, run_quota FROM projects WHERE project_id=$1",
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
    "SELECT name, region, public_url, internal_url, ssh_server, tier, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
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
    name: row.name,
    region: row.region,
    public_url: row.public_url,
    internal_url: row.internal_url,
    ssh_server: row.ssh_server,
    tier,
    local_proxy: isLocalSelfHost,
  };
}

export async function selectActiveHost(exclude_host_id?: string) {
  const { rows } = await pool().query(
    `
      SELECT id, name, region, public_url, internal_url, ssh_server, tier, metadata
      FROM project_hosts
      WHERE status='running'
        AND deleted IS NULL
        AND last_seen > NOW() - interval '2 minutes'
        ${exclude_host_id ? "AND id != $1" : ""}
      ORDER BY random()
      LIMIT 1
    `,
    exclude_host_id ? [exclude_host_id] : [],
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
  await pool().query("UPDATE projects SET host_id=$1 WHERE project_id=$2", [
    placement.host_id,
    project_id,
  ]);
  await notifyProjectHostUpdate({
    project_id,
    host_id: placement.host_id,
  });
}

async function ensurePlacement(project_id: string): Promise<HostPlacement> {
  const meta = await loadProject(project_id);
  if (meta.host_id) {
    const hostInfo = await loadHostFromRegistry(meta.host_id);
    if (!hostInfo) {
      // Project is already placed, but the host is missing/unregistered.
      // Never auto-reassign here to avoid split-brain/data loss; require an explicit move.
      throw Error(
        `project is assigned to host ${meta.host_id} but it is unavailable`,
      );
    }
    return { host_id: meta.host_id };
  }

  const chosen = await selectActiveHost();
  if (!chosen) {
    throw Error("no running project-host available");
  }

  const client = createHostControlClient({
    host_id: chosen.id,
    client: conatWithProjectRouting(),
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
    const client = createHostControlClient({
      host_id: placement.host_id,
      client: conatWithProjectRouting(),
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
      log.warn("startProjectOnHost failed", {
        project_id,
        host: placement,
        err,
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
  const meta = await loadProject(project_id);
  const host_id = meta.host_id;
  if (!host_id) {
    throw Error("project has no host_id");
  }
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
  const client = createHostControlClient({
    host_id,
    client: conatWithProjectRouting(),
    timeout: opts?.timeout_ms ?? STOP_PROJECT_TIMEOUT_MS,
  });
  try {
    await client.stopProject({ project_id });
    if (wasRunning) {
      await pool().query(
        "UPDATE projects SET last_edited=NOW() WHERE project_id=$1",
        [project_id],
      );
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
  const host_id = meta.host_id;
  if (!host_id) {
    return;
  }
  const client = createHostControlClient({
    host_id,
    client: conatWithProjectRouting(),
  });
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
  const host_id = meta.host_id;
  if (!host_id) {
    return;
  }
  if (expected_host_id && expected_host_id !== host_id) {
    throw Error(
      `project ${project_id} is assigned to host ${host_id}, not ${expected_host_id}`,
    );
  }
  const client = createHostControlClient({
    host_id,
    client: conatWithProjectRouting(),
  });
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
  const client = createHostControlClient({
    host_id,
    client: conatWithProjectRouting(),
  });
  await client.deleteProjectData({ project_id });
}
