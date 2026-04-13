/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import { v4 } from "uuid";
import getLogger from "@cocalc/backend/logger";
import { getProject } from "@cocalc/server/projects/control";
import { type CreateProjectOptions } from "@cocalc/util/db-schema/projects";
import { delay } from "awaiting";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import {
  computePlacementPermission,
  getUserHostTier,
} from "@cocalc/server/project-host/placement";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import {
  cloneProjectRootfsStates,
  initializeProjectRootfsStates,
} from "@cocalc/server/projects/rootfs-state";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  parseR2Region,
} from "@cocalc/util/consts";
import { createLro, updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { takeStartProjectPhaseTimings } from "@cocalc/server/project-host/control";
import { supersedeOlderProjectStartLros } from "@cocalc/server/projects/start-lro-cleanup";
import { mirrorStartLroProgress } from "@cocalc/server/projects/start-lro-progress";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { resolveHostBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";

const log = getLogger("server:projects:create");
const HOST_ONLINE_WINDOW_MS = 2 * 60 * 1000;

function publishStartLroSummaryBestEffort({
  scope_type,
  scope_id,
  summary,
  context,
}: {
  scope_type: LroSummary["scope_type"];
  scope_id: string;
  summary: LroSummary;
  context: string;
}): void {
  void publishLroSummary({
    scope_type,
    scope_id,
    summary,
  }).catch((err) => {
    log.warn(`${context}: unable to publish LRO summary`, {
      op_id: summary.op_id,
      scope_id,
      err: `${err}`,
    });
  });
}

function isHostRunningAndOnline(row: any): {
  ok: boolean;
  reason?: string;
} {
  if (!row || row.deleted) {
    return { ok: false, reason: "host is deleted" };
  }
  const status = `${row.status ?? ""}`.trim().toLowerCase();
  if (!["running", "active"].includes(status)) {
    return { ok: false, reason: `status is ${status || "unknown"}` };
  }
  if (!row.last_seen) {
    return { ok: false, reason: "no recent heartbeat" };
  }
  const lastSeenMs = new Date(row.last_seen as any).getTime();
  if (!Number.isFinite(lastSeenMs)) {
    return { ok: false, reason: "invalid heartbeat timestamp" };
  }
  if (Date.now() - lastSeenMs > HOST_ONLINE_WINDOW_MS) {
    return { ok: false, reason: "heartbeat is stale" };
  }
  return { ok: true };
}

function isRemoteHostRunningAndOnline(row: {
  status?: string | null;
  online?: boolean;
  reason_unavailable?: string;
}): {
  ok: boolean;
  reason?: string;
} {
  const status = `${row.status ?? ""}`.trim().toLowerCase();
  if (!["running", "active"].includes(status)) {
    return { ok: false, reason: `status is ${status || "unknown"}` };
  }
  if (row.online === false) {
    return {
      ok: false,
      reason: `${row.reason_unavailable ?? "host is offline"}`,
    };
  }
  if (`${row.reason_unavailable ?? ""}`.trim()) {
    return {
      ok: false,
      reason: `${row.reason_unavailable}`,
    };
  }
  return { ok: true };
}

export default async function createProject(opts: CreateProjectOptions) {
  if (opts.account_id != null) {
    if (!isValidUUID(opts.account_id)) {
      throw Error("if account_id given, it must be a valid uuid v4");
    }
  }
  log.debug("createProject ", opts);

  const {
    account_id,
    title,
    description,
    rootfs_image,
    rootfs_image_id,
    start,
    src_project_id,
    ephemeral,
    host_id: requested_host_id,
    region: requested_region_raw_input,
  } = opts;
  let project_id;
  if (opts.project_id) {
    if (!account_id || !(await isAdmin(account_id))) {
      throw Error("only admins can specify the project_id");
    }
    if (!isValidUUID(opts.project_id)) {
      throw Error("if project_id is given, it must be a valid uuid v4");
    }
    project_id = opts.project_id;
  } else {
    project_id = v4();
  }

  const pool = getPool();

  async function projectIdConflictsDeleted(
    project_id: string,
  ): Promise<boolean> {
    try {
      const { rows } = await pool.query<{ project_id: string }>(
        "SELECT project_id FROM deleted_projects WHERE project_id=$1 LIMIT 1",
        [project_id],
      );
      return !!rows[0];
    } catch (err: any) {
      // Table may not exist until first hard-delete run.
      if (err?.code === "42P01") {
        return false;
      }
      throw err;
    }
  }

  async function projectIdExists(project_id: string): Promise<boolean> {
    const { rows } = await pool.query<{ project_id: string }>(
      "SELECT project_id FROM projects WHERE project_id=$1 LIMIT 1",
      [project_id],
    );
    return !!rows[0];
  }

  if (opts.project_id) {
    if (await projectIdConflictsDeleted(project_id)) {
      throw Error(
        "project_id belongs to a permanently deleted workspace; restore that workspace instead of reusing its project_id",
      );
    }
    if (await projectIdExists(project_id)) {
      throw Error("project_id already exists");
    }
  } else {
    // Ensure generated id never collides with active or hard-deleted projects.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (
        !(await projectIdExists(project_id)) &&
        !(await projectIdConflictsDeleted(project_id))
      ) {
        break;
      }
      project_id = v4();
      if (attempt === 15) {
        throw Error(
          "failed to allocate a fresh project_id; please retry project creation",
        );
      }
    }
  }
  let host_id: string | undefined = requested_host_id;
  let requested_region_raw: string | undefined = requested_region_raw_input;
  let hostStatus: string | null | undefined;
  let projectOwningBayId = getConfiguredBayId();
  let assignedHostBayId = getConfiguredBayId();

  async function resolveHostPlacement(host_id: string) {
    if (!account_id) {
      throw Error("must be signed in to place a project on a host");
    }
    const { rows } = await pool.query(
      "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [host_id],
    );
    const row = rows[0];
    if (!row) {
      const hostBay = await resolveHostBay(host_id);
      if (!hostBay || hostBay.bay_id === getConfiguredBayId()) {
        throw Error(`host ${host_id} not found`);
      }
      const remote = await getInterBayBridge()
        .hostConnection(hostBay.bay_id, {
          timeout_ms: 15_000,
        })
        .get({ account_id, host_id });
      const availability = isRemoteHostRunningAndOnline(remote);
      if (!availability.ok) {
        throw Error(
          `host ${host_id} is unavailable for new projects (${availability.reason})`,
        );
      }
      if (!remote.can_place) {
        throw Error("not allowed to place a project on that host");
      }
      const hostRegion = mapCloudRegionToR2Region(remote.region ?? "");
      return {
        host_id,
        hostRegion,
        hostBayId: `${remote.bay_id ?? ""}`.trim() || hostBay.bay_id,
        hostStatus: remote.status as string | null | undefined,
      };
    }
    const availability = isHostRunningAndOnline(row);
    if (!availability.ok) {
      throw Error(
        `host ${host_id} is unavailable for new projects (${availability.reason})`,
      );
    }
    const metadata = row.metadata ?? {};
    const owner = metadata.owner;
    const collaborators: string[] = metadata.collaborators ?? [];
    const tier = row.tier as number | undefined;
    const membership = await resolveMembershipForAccount(account_id);
    const userTier = getUserHostTier(membership.entitlements);
    const { can_place } = computePlacementPermission({
      tier,
      userTier,
      isOwner: owner === account_id,
      isCollab: collaborators.includes(account_id ?? ""),
    });
    if (!can_place) {
      throw Error("not allowed to place a project on that host");
    }
    const hostRegion = mapCloudRegionToR2Region(row.region ?? "");
    const machine = metadata?.machine ?? {};
    const selfHostMode = machine?.metadata?.self_host_mode;
    const effectiveSelfHostMode =
      machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
    const isLocalSelfHost =
      machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
    log.debug("resolveHostPlacement", {
      host_id,
      isLocalSelfHost,
    });
    return {
      host_id,
      hostRegion,
      hostBayId: `${row.bay_id ?? ""}`.trim() || getConfiguredBayId(),
      hostStatus: row.status as string | null | undefined,
    };
  }

  if (src_project_id) {
    if (!account_id) {
      throw Error("user must be a collaborator on src_project_id");
    }
    await assertLocalProjectCollaborator({
      account_id,
      project_id: src_project_id,
    });
    // keep the clone on the same project-host as the source unless explicitly overridden
    const { rows } = await pool.query(
      "SELECT host_id, region, rootfs_image, rootfs_image_id, owning_bay_id FROM projects WHERE project_id=$1",
      [src_project_id],
    );
    if (!host_id && rows[0]?.host_id) {
      host_id = rows[0].host_id;
    }
    if (!opts.region && rows[0]?.region) {
      opts.region = rows[0].region;
    }
    if (!requested_region_raw && rows[0]?.region) {
      requested_region_raw = rows[0].region;
    }
    if (!opts.rootfs_image && rows[0]?.rootfs_image) {
      opts.rootfs_image = rows[0].rootfs_image;
    }
    if (!opts.rootfs_image_id && rows[0]?.rootfs_image_id) {
      opts.rootfs_image_id = rows[0].rootfs_image_id;
    }
    if (!host_id && rows[0]?.owning_bay_id) {
      projectOwningBayId =
        `${rows[0].owning_bay_id}`.trim() || projectOwningBayId;
    }
    // create filesystem for new project as a clone.
    // Route clone to the host that owns the source project.
    const client = await getProjectFileServerClient({
      project_id: src_project_id,
    });
    await client.clone({ project_id, src_project_id });
  }

  const requestedRegion = parseR2Region(requested_region_raw);
  if (requested_region_raw && !requestedRegion) {
    throw Error("invalid region");
  }

  let hostRegion: string | undefined;
  if (host_id) {
    ({
      host_id,
      hostRegion,
      hostStatus,
      hostBayId: assignedHostBayId,
    } = await resolveHostPlacement(host_id));
  }

  const projectRegion = requestedRegion ?? hostRegion ?? DEFAULT_R2_REGION;
  if (requestedRegion && hostRegion && requestedRegion !== hostRegion) {
    throw Error("project region must match host region");
  }
  const users =
    account_id == null ? null : { [account_id]: { group: "owner" } };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO projects (project_id, title, description, users, created, last_edited, rootfs_image, rootfs_image_id, ephemeral, host_id, region, owning_bay_id) VALUES($1, $2, $3, $4, NOW(), NOW(), $5, $6, $7::BIGINT, $8, $9, $10)",
      [
        project_id,
        title ?? "No Title",
        description ?? "",
        users != null ? JSON.stringify(users) : users,
        rootfs_image,
        opts.rootfs_image_id ?? rootfs_image_id ?? null,
        ephemeral ?? null,
        host_id ?? null,
        projectRegion,
        projectOwningBayId,
      ],
    );
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: "project.created",
      project_id,
      default_bay_id: projectOwningBayId,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: projectOwningBayId,
  });

  if (src_project_id) {
    await cloneProjectRootfsStates({
      project_id,
      src_project_id,
    });
  } else {
    await initializeProjectRootfsStates({
      project_id,
      image: rootfs_image,
      image_id: opts.rootfs_image_id ?? rootfs_image_id ?? null,
      set_by_account_id: account_id,
    });
  }

  // If this is a clone with a known host, register the project row on that host
  // so it is visible in its local sqlite/changefeeds without starting it.
  if (host_id) {
    let lastErr: unknown;
    try {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          const createOpts = {
            project_id,
            title,
            users,
            image: rootfs_image,
            start: false,
          };
          if (assignedHostBayId !== getConfiguredBayId()) {
            await getInterBayBridge()
              .hostControl(assignedHostBayId, {
                timeout_ms: 15_000,
              })
              .createProject({
                account_id: account_id!,
                host_id,
                create: createOpts,
              });
          } else {
            const client = await getRoutedHostControlClient({
              host_id,
              timeout: 15000,
            });
            await client.createProject(createOpts);
          }
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < 4) {
            await delay(Math.min(8000, attempt * 2000));
          }
        }
      }
      if (lastErr) {
        throw lastErr;
      }
    } catch (err) {
      log.warn("createProject: failed to register clone on host", {
        project_id,
        host_id,
        host_status: hostStatus ?? null,
        err: `${err}`,
      });
      const mustFail =
        hostStatus === "running" ||
        hostStatus === "active" ||
        hostStatus === "starting";
      if (mustFail) {
        try {
          await pool.query("DELETE FROM projects WHERE project_id=$1", [
            project_id,
          ]);
        } catch (cleanupErr) {
          log.warn(
            "createProject: failed to cleanup project row after host register error",
            {
              project_id,
              host_id,
              err: `${cleanupErr}`,
            },
          );
        }
        throw Error(
          `failed to initialize workspace on host ${host_id} (status=${hostStatus ?? "unknown"}): ${err}`,
        );
      }
    }
  }

  if (start) {
    const project = getProject(project_id);
    // intentionally not blocking
    startNewProject(project, project_id, account_id);
  }

  return project_id;
}

async function startNewProject(
  project,
  project_id: string,
  account_id?: string,
) {
  log.debug("startNewProject", { project_id });
  let op: LroSummary | undefined;
  try {
    const createdOp = await createLro({
      kind: "project-start",
      scope_type: "project",
      scope_id: project_id,
      created_by: account_id,
      routing: "hub",
      input: { project_id },
      status: "queued",
    });
    op = createdOp;
    publishStartLroSummaryBestEffort({
      scope_type: createdOp.scope_type,
      scope_id: createdOp.scope_id,
      summary: createdOp,
      context: "createProject: start initial",
    });
    void publishLroEvent({
      scope_type: createdOp.scope_type,
      scope_id: createdOp.scope_id,
      op_id: createdOp.op_id,
      event: {
        type: "progress",
        ts: Date.now(),
        phase: "queued",
        message: "queued",
        progress: 0,
      },
    }).catch((err) => {
      log.warn("createProject: unable to publish queued start event", {
        project_id,
        op_id: op?.op_id,
        err: `${err}`,
      });
    });
  } catch (err) {
    log.warn("createProject: unable to initialize start LRO", {
      project_id,
      err: `${err}`,
    });
  }

  async function setLroStatus(
    status: "running" | "succeeded" | "failed",
    opts?: {
      progress_summary?: any;
      result?: any;
      error?: string | null;
      context?: string;
    },
  ): Promise<void> {
    const currentOp = op;
    if (!currentOp?.op_id) {
      return;
    }
    try {
      const updated = await updateLro({
        op_id: currentOp.op_id,
        status,
        progress_summary: opts?.progress_summary,
        result: opts?.result,
        error: opts?.error,
      });
      if (updated) {
        publishStartLroSummaryBestEffort({
          scope_type: updated.scope_type,
          scope_id: updated.scope_id,
          summary: updated,
          context: opts?.context ?? `createProject: start ${status}`,
        });
      }
    } catch (err) {
      log.warn("createProject: unable to update start LRO", {
        project_id,
        op_id: currentOp.op_id,
        status,
        err: `${err}`,
      });
    }
  }

  await setLroStatus("running", {
    progress_summary: {
      phase: "queued",
      message: "queued",
      progress: 0,
    },
    error: null,
    context: "createProject: start running",
  });
  const stopProgressMirror = await mirrorStartLroProgress({
    project_id,
    op_id: op?.op_id,
  });
  try {
    await project.start({ account_id, lro_op_id: op?.op_id });
    // Keep a conservative retry for slow host bring-up, but only if the
    // persisted project state still is not active after a short settle window.
    // Do not verify via project.state() here: in project-host deployments that
    // goes through the runner control subject (`project.<id>.run`), which can
    // lag or time out even after the project row has already been updated to
    // running and the project is usable.
    await delay(5000);
    let state: string | undefined;
    try {
      const { rows } = await getPool().query<{ state: any }>(
        "SELECT state FROM projects WHERE project_id=$1",
        [project_id],
      );
      const rawState = rows[0]?.state;
      const parsedState =
        typeof rawState === "string" ? JSON.parse(rawState) : rawState;
      const nextState = parsedState?.state;
      state = typeof nextState === "string" ? nextState : undefined;
    } catch (err) {
      log.debug(
        "startNewProject: unable to verify persisted post-start state",
        {
          project_id,
          err: `${err}`,
        },
      );
    }
    if (state != null && state !== "running" && state !== "starting") {
      log.debug("startNewProject: retrying start after non-active state", {
        project_id,
        state,
      });
      await project.start({ account_id, lro_op_id: op?.op_id });
    }
    const phase_timings_ms = takeStartProjectPhaseTimings(op?.op_id);
    const progress_summary = {
      done: 1,
      total: 1,
      failed: 0,
      queued: 0,
      expired: 0,
      applying: 0,
      canceled: 0,
      phase_timings_ms,
    };
    await setLroStatus("succeeded", {
      progress_summary,
      result: progress_summary,
      error: null,
      context: "createProject: start succeeded",
    });
    await supersedeOlderProjectStartLros({
      project_id,
      keep_op_id: op?.op_id,
    });
  } catch (err) {
    log.warn(`problem starting new project -- ${err}`, {
      project_id,
    });
    await setLroStatus("failed", {
      error: `${err}`,
      context: "createProject: start failed",
    });
    try {
      await project.saveStateToDatabase({
        state: "opened",
        error: `${err}`,
        time: new Date(),
      });
    } catch (stateErr) {
      log.warn("failed to reset project state after startNewProject error", {
        project_id,
        err: `${stateErr}`,
      });
    }
  } finally {
    await stopProgressMirror();
  }
}
